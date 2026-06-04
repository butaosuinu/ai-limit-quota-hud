//! `WebviewScraper` — shared orchestration for opt-in WebView providers
//! (PROJECT_SPEC §8.7).
//!
//! Both the Claude (#30) and Codex (#31) providers drive an isolated WebView
//! pointed at a vendor's own usage page, inject a small extractor JS, and
//! receive the JSON result via `document.title` (Tauri's IPC must not be
//! exposed to those external origins). The window lifecycle, navigation
//! allowlisting, and title-channel polling are the same shape for both
//! providers — this module owns that shape so the per-provider modules stay
//! small and focused on the DOM contract.
//!
//! Architecture:
//!
//! - `ScraperConfig` is provider-supplied data: the slug, the target URL,
//!   the extractor JS source, and the static allowlist of provider-owned
//!   supporting hosts that the page is permitted to fetch from.
//! - `WebviewScraper::run_hidden` builds (or reuses) one hidden
//!   `WebviewWindow` per provider, hops to the Tauri main thread for first
//!   construction (Wry requires main-thread construction on macOS), injects
//!   the extractor as an initialization script, and waits on a
//!   `tokio::sync::oneshot` channel that is signaled from the
//!   `on_document_title_changed` callback. After each refresh the window is
//!   parked on `about:blank` so the vendor SPA heap is not kept alive between
//!   scheduled refreshes.
//! - `WebviewScraper::open_visible_login` is the visible-login equivalent;
//!   no extractor JS is injected and no title polling happens. The caller
//!   (a Tauri command) just returns once the window exists.
//!
//! Pure helpers (the JSON parsing, allowlist matching, idle login redirect
//! reasoning) live here as free functions so they are unit-testable without
//! a Tauri runtime.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, Url, WebviewUrl};
use tokio::sync::oneshot;

use super::{host_is_known_idp, ProviderHostAllowlist, SessionStorage};

/// Prefix the extractor JS writes into `document.title` so the Rust side can
/// distinguish a real result from whatever the page's own `<title>` is.
pub const TITLE_PREFIX: &str = "QHJSON:";

/// Default timeout for one full hidden refresh cycle (window create →
/// extractor JS emits a payload). Set to 25 s — the scheduler wraps each
/// refresh in its own 30 s outer timeout (`REFRESH_TIMEOUT_SECS`), and
/// keeping the inner budget strictly smaller ensures the scraper's own
/// `Timeout` error path wins over the outer "provider refresh timed out"
/// snapshot.
pub const DEFAULT_REFRESH_TIMEOUT: Duration = Duration::from_secs(25);
const HIDDEN_IDLE_URL: &str = "about:blank";
const HIDDEN_WINDOW_TITLE: &str = "QuotaHUD scraper";
const HIDDEN_REFRESH_GENERATION_PARAM: &str = "qhgen";

/// Provider-supplied configuration consumed by [`WebviewScraper`]. Kept as a
/// plain data struct (rather than a trait) so the same scraper code path is
/// driven by Claude and Codex without dynamic dispatch.
#[derive(Debug, Clone)]
pub struct ScraperConfig {
    /// Provider slug — matches [`super::provider_slug`] output (e.g.
    /// `"webview-claude-ai"`). Used as the window label prefix and the
    /// session-storage seed.
    pub slug: &'static str,
    /// Target URL the scraper navigates to. For Claude this is
    /// `https://claude.ai/settings/usage`.
    pub target_url: &'static str,
    /// Login URL for the visible-login flow. For Claude:
    /// `https://claude.ai/login`.
    pub login_url: &'static str,
    /// Extractor JS source code. Loaded via `include_str!` in the concrete
    /// provider module.
    pub extractor_js: &'static str,
    /// Static portion of the egress allowlist (§14). Hosts not in this list
    /// (and not in the active login redirect chain) are blocked.
    pub host_allowlist: &'static ProviderHostAllowlist,
}

/// Wire format the extractor JS writes into `document.title` (after stripping
/// the `QHJSON:` prefix). Serde cannot tag a variant on a bool `ok` field
/// directly, so we deserialize into this raw struct and convert via
/// [`ScraperPayload::from_raw`].
#[derive(Debug, Clone, Deserialize)]
struct RawScraperPayload {
    ok: bool,
    #[serde(default)]
    rows: Option<serde_json::Value>,
    #[serde(default)]
    kind: Option<ScraperErrorKind>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    generation: Option<u64>,
}

/// Decoded shape of the JSON payload the extractor JS writes into
/// `document.title`. The concrete provider module casts the `rows` payload
/// into `UsageSnapshot[]` itself — the scraper does not care about the
/// per-provider row shape.
#[derive(Debug, Clone)]
pub enum ScraperPayload {
    /// `{ "ok": true, "rows": [...] }`. The provider module interprets the
    /// row JSON.
    Ok {
        rows: serde_json::Value,
        generation: Option<u64>,
    },
    /// `{ "ok": false, "kind": "...", "message"?: "..." }`.
    Err {
        kind: ScraperErrorKind,
        message: Option<String>,
        generation: Option<u64>,
    },
}

impl ScraperPayload {
    fn from_raw(raw: RawScraperPayload) -> Result<Self, String> {
        if raw.ok {
            Ok(Self::Ok {
                rows: raw.rows.unwrap_or(serde_json::Value::Null),
                generation: raw.generation,
            })
        } else {
            Ok(Self::Err {
                kind: raw.kind.unwrap_or(ScraperErrorKind::Unknown),
                message: raw.message,
                generation: raw.generation,
            })
        }
    }

    fn generation(&self) -> Option<u64> {
        match self {
            Self::Ok { generation, .. } | Self::Err { generation, .. } => *generation,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScraperErrorKind {
    CloudflareChallenge,
    LoggedOut,
    /// Transient: SPA hydration race; the extractor's retry loop will try
    /// again. The scraper title callback ignores this variant so it does
    /// not race the next emit.
    NoRows,
    /// Terminal: the extractor exhausted its retry budget without finding
    /// usage rows. Surfaced to the awaiter so providers can map it onto an
    /// error snapshot instead of waiting out the 25 s timeout.
    NoRowsFinal,
    EmitFailed,
    #[serde(other)]
    Unknown,
}

/// Errors surfaced by the scraper itself (separate from the in-page extractor
/// errors above). Concrete providers translate these into `SnapshotStatus`.
#[derive(Debug, thiserror::Error)]
pub enum ScraperError {
    #[error("scraper timed out waiting for extractor result after {0:?}")]
    Timeout(Duration),
    #[error("failed to construct WebView window: {0}")]
    WindowCreate(String),
    #[error("failed to evaluate extractor JS: {0}")]
    Eval(String),
    #[error("extractor JSON parse error: {0}")]
    Parse(String),
    /// Surfaced when the navigation callback rejects a host. Currently not
    /// produced by `run_hidden_inner` (rejected navigations are blocked at
    /// the WebView layer and bubble up as `Eval` / `Timeout`), but kept on
    /// the public API so concrete providers / future cancellation flows have
    /// a typed variant to map onto.
    #[allow(dead_code)] // reserved for navigation-cancel propagation
    #[error("blocked navigation to disallowed host: {0}")]
    BlockedNavigation(String),
}

/// Render an extractor payload as a privacy-safe one-liner — counts and
/// kinds only, never the raw row text. Used for info-level logging so
/// scraped page content (sidebar chat titles, error messages, etc.) only
/// reaches the log stream when the operator opts in at `debug`.
fn payload_summary(parsed: &Option<Result<ScraperPayload, String>>) -> String {
    match parsed {
        Some(Ok(ScraperPayload::Ok { rows, .. })) => {
            let n = rows.as_array().map(|a| a.len()).unwrap_or(0);
            format!("ok rows={n}")
        }
        Some(Ok(ScraperPayload::Err { kind, .. })) => format!("err kind={kind:?}"),
        Some(Err(_)) => "parse-error".into(),
        None => "no-prefix".into(),
    }
}

/// Decide whether a hostless top-level navigation (no `host_str`) should be
/// allowed through the WebView. Only inert internal schemes (`about:`,
/// `data:`, `blob:`) pass; `javascript:` / `file:` / unknown schemes are
/// blocked and logged so they can't bypass the host allowlist via an
/// empty-host shortcut.
fn permit_hostless_scheme(scheme: &str, window_label: &str) -> bool {
    if matches!(scheme, "about" | "data" | "blob") {
        return true;
    }
    log::warn!("webview blocked hostless navigation window={window_label} scheme={scheme}");
    false
}

/// Parse a `document.title` value emitted by an extractor JS. Returns `None`
/// when the title does not carry the `QHJSON:` prefix (the page's own title,
/// not our payload).
pub fn parse_title_payload(title: &str) -> Option<Result<ScraperPayload, String>> {
    let body = title.strip_prefix(TITLE_PREFIX)?;
    let raw = match serde_json::from_str::<RawScraperPayload>(body) {
        Ok(r) => r,
        Err(e) => return Some(Err(e.to_string())),
    };
    Some(ScraperPayload::from_raw(raw))
}

/// Tracks the dynamic half of the egress allowlist (§14): a redirect chain
/// through an external identity provider during login.
///
/// The state is intentionally minimal — once we enter an IDP chain (the
/// target page's `/login` redirected us somewhere known), we keep allowing
/// IDP hosts until we land back at the target origin. Concrete providers
/// reset this state whenever they explicitly navigate (e.g. to start a
/// refresh).
#[derive(Debug, Default)]
pub struct LoginRedirectTracker {
    in_chain: bool,
    /// Whether the most recently-allowed navigation landed inside the static
    /// allowlist (provider's own origin + supporting hosts). Required so an
    /// IDP host can only be permitted as a *redirect from* the provider, not
    /// as a fresh top-level navigation. Without this flag, the tracker would
    /// allow direct top-level navigation to e.g. `github.com` simply because
    /// the host is in `KNOWN_IDP_SUFFIXES`.
    last_was_static: bool,
}

impl LoginRedirectTracker {
    pub fn new() -> Self {
        Self {
            in_chain: false,
            last_was_static: false,
        }
    }

    /// Returns `true` if the current state is in an active IDP redirect
    /// chain. Useful for tests; callers normally drive the tracker via
    /// `decide`. Kept `pub` so concrete providers (or future telemetry) can
    /// log when a refresh tick observes an unexpected mid-flight chain.
    #[allow(dead_code)] // exercised by unit tests; part of the public API for Codex #31
    pub fn in_chain(&self) -> bool {
        self.in_chain
    }

    /// Force-reset the chain. Concrete providers call this when they
    /// programmatically navigate (refresh / explicit `navigate()` call), so
    /// a leftover IDP cookie navigation cannot widen the allowlist forever.
    #[allow(dead_code)] // public API for Codex #31; production code does not need explicit reset yet
    pub fn reset(&mut self) {
        self.in_chain = false;
        self.last_was_static = false;
    }

    /// Inspect a navigation attempt and decide whether to allow it. Updates
    /// internal state to track the IDP chain.
    ///
    /// `target_host` is the host of the provider's target origin (e.g.
    /// `claude.ai`) — when we land back on it the chain resets.
    pub fn decide(
        &mut self,
        nav_host: &str,
        target_host: &str,
        allowlist: &ProviderHostAllowlist,
    ) -> NavigationDecision {
        let nav_host = nav_host.to_ascii_lowercase();
        let target_host = target_host.to_ascii_lowercase();
        // Static allowlist always permits and arms the IDP gate.
        if allowlist.permits(&nav_host) {
            // Reset the chain when we return to the target origin so a
            // stale IDP allowance doesn't outlive the login flow.
            if nav_host == target_host {
                self.in_chain = false;
            }
            self.last_was_static = true;
            return NavigationDecision::Allow;
        }
        // IDP hosts: only as part of an active chain or as the *immediate*
        // redirect target after a static-allowlist host. A direct top-level
        // navigation to e.g. `github.com` from a fresh tab does not satisfy
        // either condition and is blocked.
        if host_is_known_idp(&nav_host) && (self.in_chain || self.last_was_static) {
            self.in_chain = true;
            // Subsequent IDP hops (Google → corp SSO → Google) keep the
            // chain open; only landing back inside the static allowlist
            // (handled above) rearms `last_was_static`.
            self.last_was_static = false;
            return NavigationDecision::Allow;
        }
        // While in a chain, additional IDP hops (e.g. Google → corp SSO →
        // Google) may pass through hosts we haven't tagged. We keep this
        // conservative: anything not on either list while in-chain is still
        // blocked, but the chain itself stays open in case a subsequent
        // navigation does land on an IDP suffix we know.
        self.last_was_static = false;
        NavigationDecision::Block
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    Block,
}

/// Convert a SessionStorage handle into the corresponding builder calls.
/// Kept here so both `run_hidden` and `open_visible_login` apply the same
/// platform-specific isolation; concrete providers don't have to know which
/// builder hook is honored on which OS.
#[cfg_attr(coverage_nightly, coverage(off))]
fn apply_session_storage<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    storage: &SessionStorage,
) -> WebviewWindowBuilder<'a, R, M> {
    match storage {
        SessionStorage::DataDirectory(path) => builder.data_directory(path.clone()),
        SessionStorage::DataStoreIdentifier(uuid) => {
            // `data_store_identifier` is a macOS-only WebView2/WKWebView
            // builder hook. `SessionStorage::for_provider` already only
            // produces this variant on macOS, but the *call site* must also
            // be gated so the Windows / Linux binaries don't link the symbol
            // — Windows test exe was hitting STATUS_ENTRYPOINT_NOT_FOUND
            // (0xc0000139) during delayed load of this entry point.
            #[cfg(target_os = "macos")]
            {
                let bytes: [u8; 16] = *uuid.as_bytes();
                builder.data_store_identifier(bytes)
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Defensive: this branch is unreachable at runtime because
                // `for_provider` returns `DataDirectory` on non-macOS, but
                // the match arm still has to type-check.
                let _ = uuid;
                builder
            }
        }
    }
}

/// Apply the hidden-window flags from §8.7. The flags are platform-aware
/// (macOS doesn't expose `skip_taskbar` per Tauri 2 docs).
#[cfg_attr(coverage_nightly, coverage(off))]
fn apply_hidden_window_flags<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let b = builder
        .visible(false)
        .focused(false)
        .decorations(false)
        .resizable(false);
    #[cfg(not(target_os = "macos"))]
    let b = b.skip_taskbar(true);
    // Enable devtools in debug builds so the WKWebView Develop menu can
    // attach to the hidden refresh window and step through the extractor
    // JS. Release builds do not expose devtools (PROJECT_SPEC §14).
    #[cfg(debug_assertions)]
    let b = b.devtools(true);
    b
}

/// RAII guard that destroys a transient helper window on drop.
struct WindowDestroyGuard {
    app: AppHandle,
    label: String,
}

impl Drop for WindowDestroyGuard {
    #[cfg_attr(coverage_nightly, coverage(off))]
    fn drop(&mut self) {
        if let Some(window) = self.app.get_webview_window(&self.label) {
            let _ = window.destroy();
        }
    }
}

/// Per-refresh cleanup for the reused hidden window.
///
/// The window itself intentionally stays alive, but the active oneshot sender
/// must be cleared on every exit path so a late title event cannot resolve a
/// stale refresh. Navigating back to `about:blank` releases the vendor SPA's
/// DOM/JS heap between scheduled refreshes while avoiding repeated WebView
/// process creation.
struct HiddenRefreshGuard {
    app: AppHandle,
    label: String,
    generation: u64,
    result_slot: Arc<Mutex<Option<HiddenResultSlot>>>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for HiddenRefreshGuard {
    #[cfg_attr(coverage_nightly, coverage(off))]
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.result_slot.lock() {
            if slot
                .as_ref()
                .is_some_and(|active| active.generation == self.generation)
            {
                *slot = None;
            }
        }
        if let Some(window) = self.app.get_webview_window(&self.label) {
            let _ = window.set_title(HIDDEN_WINDOW_TITLE);
            if let Ok(url) = Url::parse(HIDDEN_IDLE_URL) {
                let _ = window.navigate(url);
            }
        }
    }
}

struct HiddenResultSlot {
    generation: u64,
    sender: oneshot::Sender<String>,
}

/// Path of a hidden refresh window's data directory, if any. Returned so
/// `delete_provider_data` can wipe it. `None` on macOS (cookies live in the
/// `WKWebsiteDataStore` keyed by `data_store_identifier`).
///
/// `commands.rs` discriminates the two storage variants inline instead of
/// going through this helper, but it's kept on the public API so external
/// callers (the Codex provider in #31, or future health-check tooling) can
/// reuse the same mapping.
#[allow(dead_code)] // public helper; not currently called from production code
pub fn data_directory_for(storage: &SessionStorage) -> Option<PathBuf> {
    match storage {
        SessionStorage::DataDirectory(path) => Some(path.clone()),
        SessionStorage::DataStoreIdentifier(_) => None,
    }
}

/// Shared scraper façade. Concrete provider modules call into this to drive
/// the hidden refresh and the visible login window. The struct itself is
/// cheap to clone — `AppHandle` is `Clone` and the config is `'static`.
#[derive(Clone)]
pub struct WebviewScraper {
    app: AppHandle,
    config: ScraperConfig,
    storage: SessionStorage,
    /// Counter used to mint unique one-shot clear-window labels.
    counter: Arc<AtomicU64>,
    /// Result channel for the currently-running hidden refresh. The hidden
    /// WebView window is reused across refreshes, so its title callback must
    /// look up the active sender dynamically instead of capturing a sender
    /// from the first build.
    hidden_result_slot: Arc<Mutex<Option<HiddenResultSlot>>>,
    /// Monotonic generation assigned to every hidden refresh. Extractors echo
    /// it back so late title events from an old page cannot satisfy a newer
    /// refresh.
    hidden_generation: Arc<AtomicU64>,
    /// Incremented whenever the hidden window is explicitly destroyed. Queued
    /// first-build closures compare against this epoch before constructing a
    /// WebView.
    hidden_destroy_epoch: Arc<AtomicU64>,
    /// Navigation tracker shared by the reused hidden window callback.
    hidden_tracker: Arc<Mutex<LoginRedirectTracker>>,
}

impl WebviewScraper {
    pub fn new(app: AppHandle, config: ScraperConfig, storage: SessionStorage) -> Self {
        Self {
            app,
            config,
            storage,
            counter: Arc::new(AtomicU64::new(0)),
            hidden_result_slot: Arc::new(Mutex::new(None)),
            hidden_generation: Arc::new(AtomicU64::new(0)),
            hidden_destroy_epoch: Arc::new(AtomicU64::new(0)),
            hidden_tracker: Arc::new(Mutex::new(LoginRedirectTracker::new())),
        }
    }

    /// Borrow the provider-supplied configuration. Used by future Codex
    /// (#31) integration code that builds richer diagnostic snapshots.
    #[allow(dead_code)] // public API for Codex #31
    pub fn config(&self) -> &ScraperConfig {
        &self.config
    }

    /// Borrow the resolved session-storage handle for this scraper. The
    /// concrete provider keeps its own copy and uses that one; this exists
    /// so external code can mint a `delete_provider_data` action without
    /// reaching into the provider struct.
    #[allow(dead_code)] // public API for Codex #31
    pub fn storage(&self) -> &SessionStorage {
        &self.storage
    }

    /// Open the provider's own visible login URL in a normal decorated
    /// window. Returns once the window exists so the caller (the Tauri
    /// command) can resolve the IPC quickly; the user drives the login flow
    /// inside the page itself.
    ///
    /// Idempotent: if a window with the same label is already open we
    /// surface it instead of building a new one. That keeps the user from
    /// accidentally racing two login windows against the same session
    /// cookie.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub async fn open_visible_login(&self) -> Result<(), ScraperError> {
        let label = self.login_label();
        if let Some(existing) = self.app.get_webview_window(&label) {
            let _ = existing.show();
            let _ = existing.set_focus();
            return Ok(());
        }
        let app = self.app.clone();
        let storage = self.storage.clone();
        let login_url = self.config.login_url;
        let allowlist = self.config.host_allowlist;
        // Derive the target host from the *target* URL (not `login_url`),
        // so the navigation tracker's "return to target resets the chain"
        // logic still works after a successful login redirects back to the
        // usage page.
        let target_host = host_of(self.config.target_url).unwrap_or_default();
        let label_clone = label.clone();
        let title = format!("{} login", self.config.slug);
        // The login window navigates through the user's real login flow,
        // including IDP redirects. The hidden scraper has its own tracker;
        // the login window needs its own — they don't share state because
        // they're independent windows.
        let tracker: Arc<Mutex<LoginRedirectTracker>> =
            Arc::new(Mutex::new(LoginRedirectTracker::new()));
        // Window construction must happen on the main thread (Wry / macOS
        // requirement). `run_on_main_thread` queues the closure and we
        // observe the outcome via a oneshot.
        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let app_for_main = app.clone();
        let result = app.run_on_main_thread(move || {
            let app = app_for_main;
            let url = match Url::parse(login_url) {
                Ok(u) => u,
                Err(e) => {
                    let _ = tx.send(Err(format!("invalid login URL: {e}")));
                    return;
                }
            };
            let builder = WebviewWindowBuilder::new(&app, &label_clone, WebviewUrl::External(url))
                .title(title)
                .visible(true)
                .focused(true)
                .resizable(true)
                .decorations(true)
                .inner_size(960.0, 720.0);
            // Enable devtools in debug builds so right-click → Inspect Element
            // works in the visible login window. Release builds do not expose
            // devtools (PROJECT_SPEC §14).
            #[cfg(debug_assertions)]
            let builder = builder.devtools(true);
            let builder = apply_session_storage(builder, &storage);
            // Enforce the §14 egress allowlist on the visible login window
            // too — Codex Review pointed out that without this guard the
            // login page (or an injected script) could redirect anywhere,
            // bypassing the constraint that only the provider's own origin
            // + supporting hosts + chained IDPs are reachable. The static
            // allow on the initial login URL arms `last_was_static`, so
            // the subsequent /login → IDP hop is permitted as a redirect.
            // We use a separate clone of `app` for the navigation callback
            // because the surrounding closure has already moved its own
            // `app` by the time the callback fires.
            let app_for_callback = app.clone();
            let target_host_for_callback = target_host.clone();
            let login_slug = label_clone.clone();
            let builder = builder.on_navigation({
                let target_host = target_host.clone();
                let tracker = Arc::clone(&tracker);
                move |url| {
                    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
                    if host.is_empty() {
                        return permit_hostless_scheme(url.scheme(), &login_slug);
                    }
                    let mut guard = tracker
                        .lock()
                        .expect("login navigation tracker mutex poisoned");
                    let decision = guard.decide(&host, &target_host, allowlist);
                    drop(guard);
                    match decision {
                        NavigationDecision::Allow => {
                            if log::log_enabled!(log::Level::Info) {
                                log::info!(
                                    "webview login nav allow window={login_slug} host={host} path={}",
                                    url.path()
                                );
                            }
                            // Nudge the scheduler when the user lands back on
                            // the target origin; the open-time trigger fires
                            // before the user has authenticated, which would
                            // capture a still-logged-out snapshot and burn
                            // the next 60 s of refresh interval on a stale
                            // row.
                            if host == target_host_for_callback {
                                if let Some(state) =
                                    app_for_callback.try_state::<crate::state::ProviderState>()
                                {
                                    crate::scheduler::trigger(&state.scheduler);
                                }
                            }
                            true
                        }
                        NavigationDecision::Block => {
                            log::warn!(
                                "webview login nav BLOCK window={login_slug} host={host} path={}",
                                url.path()
                            );
                            false
                        }
                    }
                }
            });
            match builder.build() {
                Ok(_window) => {
                    let _ = tx.send(Ok(()));
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
        if let Err(e) = result {
            return Err(ScraperError::WindowCreate(format!(
                "run_on_main_thread failed: {e}"
            )));
        }
        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(ScraperError::WindowCreate(e)),
            Err(_) => Err(ScraperError::WindowCreate(
                "main-thread channel dropped".into(),
            )),
        }
    }

    /// Run one hidden refresh cycle. Creates or reuses the provider's hidden
    /// window, waits for the extractor JS to emit a payload via
    /// `document.title`, parses it, and parks the window on `about:blank`.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub async fn run_hidden(&self) -> Result<ScraperPayload, ScraperError> {
        self.run_hidden_with_timeout(DEFAULT_REFRESH_TIMEOUT).await
    }

    /// Same as [`Self::run_hidden`] but with a caller-supplied timeout.
    /// Exposed so tests / configuration can shorten the wait.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub async fn run_hidden_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<ScraperPayload, ScraperError> {
        let label = self.hidden_label();
        let generation = self
            .hidden_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let destroy_epoch = self.hidden_destroy_epoch.load(Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<String>();
        {
            let mut slot = self
                .hidden_result_slot
                .lock()
                .expect("hidden scraper result slot mutex poisoned");
            if slot.is_some() {
                return Err(ScraperError::WindowCreate(
                    "hidden scraper refresh already running".into(),
                ));
            }
            *slot = Some(HiddenResultSlot {
                generation,
                sender: tx,
            });
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let _run_guard = HiddenRefreshGuard {
            app: self.app.clone(),
            label: label.clone(),
            generation,
            result_slot: Arc::clone(&self.hidden_result_slot),
            cancelled: Arc::clone(&cancelled),
        };
        let result = tokio::time::timeout(
            timeout,
            self.run_hidden_inner(label, rx, generation, destroy_epoch, Arc::clone(&cancelled)),
        )
        .await;
        match result {
            Ok(inner) => inner,
            Err(_) => Err(ScraperError::Timeout(timeout)),
        }
    }

    /// Destroy the reused hidden refresh window and clear any in-flight title
    /// sender. Called when a provider is disabled or its session data is
    /// deleted so a long-lived app does not keep an idle WebView profile in
    /// memory.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub fn destroy_hidden_window(&self) {
        self.hidden_destroy_epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut slot) = self.hidden_result_slot.lock() {
            *slot = None;
        }
        if let Some(window) = self.app.get_webview_window(&self.hidden_label()) {
            let _ = window.destroy();
        }
    }

    /// Flush all browsing data attached to this scraper's session storage.
    ///
    /// On macOS the per-provider [`WKWebsiteDataStore`] keyed by our
    /// `dataStoreIdentifier` cannot be dropped through Tauri 2's public API,
    /// so `delete_provider_data` cannot just `rm -rf` a directory. Instead
    /// we open a transient hidden window pinned to the same store, ask the
    /// WebView to clear its data, then destroy the window. On the next
    /// refresh the user must log in again. The same primitive works on
    /// Windows / Linux for parity even though `commands.rs` deletes the
    /// `data_directory` directly there.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub async fn clear_session_data(&self) -> Result<(), ScraperError> {
        let label = self.clear_label();
        let app_outer = self.app.clone();
        let app = app_outer.clone();
        let storage = self.storage.clone();
        let label_for_main = label.clone();

        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let post = app_outer.run_on_main_thread(move || {
            // The window is owned by the main-thread closure; the guard
            // ensures it is torn down even if `clear_all_browsing_data`
            // returns an error.
            let outcome = (|| -> Result<(), String> {
                let url = Url::parse("about:blank").map_err(|e| e.to_string())?;
                let builder =
                    WebviewWindowBuilder::new(&app, &label_for_main, WebviewUrl::External(url));
                let builder = apply_session_storage(builder, &storage);
                let builder = apply_hidden_window_flags(builder);
                let window = builder.build().map_err(|e| e.to_string())?;
                let _guard = WindowDestroyGuard {
                    app: app.clone(),
                    label: label_for_main.clone(),
                };
                // `clear_all_browsing_data` is only needed for the macOS
                // `WKWebsiteDataStore` path — Windows / Linux already delete
                // the per-provider directory in `commands.rs`. Gating the
                // call also avoids a Windows STATUS_ENTRYPOINT_NOT_FOUND seen
                // on CI when the WebView2 symbol fails delayed-load.
                #[cfg(target_os = "macos")]
                window
                    .clear_all_browsing_data()
                    .map_err(|e| e.to_string())?;
                #[cfg(not(target_os = "macos"))]
                let _ = &window;
                Ok(())
            })();
            let _ = tx.send(outcome);
        });
        if let Err(e) = post {
            return Err(ScraperError::WindowCreate(format!(
                "run_on_main_thread failed: {e}"
            )));
        }
        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(ScraperError::WindowCreate(e)),
            Err(_) => Err(ScraperError::WindowCreate(
                "main-thread channel dropped".into(),
            )),
        }
    }

    #[cfg_attr(coverage_nightly, coverage(off))]
    async fn run_hidden_inner(
        &self,
        label: String,
        rx: oneshot::Receiver<String>,
        generation: u64,
        expected_destroy_epoch: u64,
        cancelled: Arc<AtomicBool>,
    ) -> Result<ScraperPayload, ScraperError> {
        let app = self.app.clone();
        let storage = self.storage.clone();
        let target_url = self.config.target_url;
        let extractor_js = self.config.extractor_js;
        let allowlist = self.config.host_allowlist;
        let target_host = host_of(target_url).unwrap_or_default();
        let label_clone = label.clone();
        let tx_slot_clone = Arc::clone(&self.hidden_result_slot);

        {
            let mut guard = self
                .hidden_tracker
                .lock()
                .expect("hidden navigation tracker mutex poisoned");
            guard.reset();
        }

        let url = target_url_with_generation(target_url, generation)?;

        if let Some(window) = app.get_webview_window(&label) {
            window
                .set_title(HIDDEN_WINDOW_TITLE)
                .map_err(|e| ScraperError::WindowCreate(e.to_string()))?;
            window
                .navigate(url)
                .map_err(|e| ScraperError::WindowCreate(e.to_string()))?;
        } else {
            self.build_hidden_window(
                label_clone,
                url,
                storage,
                extractor_js,
                allowlist,
                target_host.clone(),
                tx_slot_clone,
                expected_destroy_epoch,
                Arc::clone(&self.hidden_destroy_epoch),
                Arc::clone(&cancelled),
            )
            .await?;
        }

        let title = rx
            .await
            .map_err(|_| ScraperError::Eval("extractor never wrote to document.title".into()))?;
        if let Some(window) = self.app.get_webview_window(&label) {
            let _ = window.set_title(HIDDEN_WINDOW_TITLE);
        }
        match parse_title_payload(&title) {
            Some(Ok(payload)) => Ok(payload),
            Some(Err(e)) => Err(ScraperError::Parse(e)),
            None => Err(ScraperError::Parse(format!(
                "title did not carry {TITLE_PREFIX} prefix: {title}",
            ))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg_attr(coverage_nightly, coverage(off))]
    async fn build_hidden_window(
        &self,
        label_clone: String,
        url: Url,
        storage: SessionStorage,
        extractor_js: &'static str,
        allowlist: &'static ProviderHostAllowlist,
        target_host: String,
        tx_slot_clone: Arc<Mutex<Option<HiddenResultSlot>>>,
        expected_destroy_epoch: u64,
        destroy_epoch: Arc<AtomicU64>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), ScraperError> {
        let app = self.app.clone();
        let tracker_nav = Arc::clone(&self.hidden_tracker);
        let (build_tx, build_rx) = oneshot::channel::<Result<(), String>>();
        let app_for_main = app.clone();
        let cancelled_for_main = Arc::clone(&cancelled);
        let destroy_epoch_for_main = Arc::clone(&destroy_epoch);
        let result = app.run_on_main_thread(move || {
            let app = app_for_main;
            // The awaiting future may have been dropped between queuing
            // this closure and the main thread actually picking it up.
            // Bail before building so we don't orphan a hidden window.
            if cancelled_for_main.load(Ordering::SeqCst)
                || destroy_epoch_for_main.load(Ordering::SeqCst) != expected_destroy_epoch
            {
                let _ = build_tx.send(Err(
                    "scrape was cancelled before main-thread dispatch".into()
                ));
                return;
            }
            let builder = WebviewWindowBuilder::new(&app, &label_clone, WebviewUrl::External(url))
                .title(HIDDEN_WINDOW_TITLE);
            let builder = apply_hidden_window_flags(builder);
            let builder = apply_session_storage(builder, &storage);
            let builder = builder.initialization_script(extractor_js);
            // Enforce the static / dynamic egress allowlist on every
            // top-level navigation. Returning false cancels the navigation.
            let nav_label = label_clone.clone();
            let builder = builder.on_navigation({
                let target_host = target_host.clone();
                let tracker = Arc::clone(&tracker_nav);
                move |url| {
                    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
                    if host.is_empty() {
                        return permit_hostless_scheme(url.scheme(), &nav_label);
                    }
                    let mut guard = tracker
                        .lock()
                        .expect("scraper login tracker mutex poisoned");
                    match guard.decide(&host, &target_host, allowlist) {
                        NavigationDecision::Allow => {
                            if log::log_enabled!(log::Level::Info) {
                                log::info!(
                                    "webview hidden nav allow window={nav_label} host={host} path={}",
                                    url.path()
                                );
                            }
                            true
                        }
                        NavigationDecision::Block => {
                            log::warn!(
                                "webview hidden nav BLOCK window={nav_label} host={host} path={}",
                                url.path()
                            );
                            false
                        }
                    }
                }
            });
            // The extractor JS writes `QHJSON:{...}` to the document title
            // whenever it finishes a pass. We take the first such title and
            // signal the oneshot, *except* the transient `no-rows` kind that
            // the extractor emits and retries during SPA hydration —
            // resolving on that would race the retry and false-error the
            // snapshot. The outer `tokio::time::timeout` bounds the wait.
            //
            // Logging is split by level to keep scraped page content out of
            // default `info` logs: info-level only emits a privacy-safe
            // summary (`ok rows=N` / `err kind=…`), while the full payload
            // — which embeds `raw` / `head` / `ctx0` page snippets — is
            // gated on `debug`.
            let title_label = label_clone.clone();
            let builder = builder.on_document_title_changed({
                let tx_slot = Arc::clone(&tx_slot_clone);
                move |_window, title| {
                    if !title.starts_with(TITLE_PREFIX) {
                        return;
                    }
                    let parsed = parse_title_payload(&title);
                    let title_generation = parsed
                        .as_ref()
                        .and_then(|result| result.as_ref().ok())
                        .and_then(ScraperPayload::generation);
                    let mut slot = tx_slot
                        .lock()
                        .expect("scraper title oneshot mutex poisoned");
                    let active_generation = match slot.as_ref() {
                        Some(active) => active.generation,
                        None => return,
                    };
                    if title_generation != Some(active_generation) {
                        if log::log_enabled!(log::Level::Debug) {
                            log::debug!(
                                "ignored stale extractor title window={title_label} active_generation={active_generation} title_generation={title_generation:?}"
                            );
                        }
                        return;
                    }
                    let is_transient_no_rows = matches!(
                        &parsed,
                        Some(Ok(ScraperPayload::Err {
                            kind: ScraperErrorKind::NoRows,
                            ..
                        }))
                    );
                    if log::log_enabled!(log::Level::Debug) {
                        let label = if is_transient_no_rows {
                            "extractor title (transient no-rows)"
                        } else {
                            "extractor title"
                        };
                        log::debug!(
                            "{label} window={title_label} payload={}",
                            title.chars().take(500).collect::<String>()
                        );
                    }
                    if is_transient_no_rows {
                        return;
                    }
                    if log::log_enabled!(log::Level::Info) {
                        log::info!(
                            "extractor result window={title_label} {}",
                            payload_summary(&parsed)
                        );
                    }
                    if let Some(active) = slot.take() {
                        let _ = active.sender.send(title);
                    }
                }
            });
            match builder.build() {
                Ok(window) => {
                    // Build succeeded; before returning success, check
                    // whether the awaiting future was cancelled while we
                    // were on the main thread. If so, destroy the window
                    // inline so a queued first build cannot leave an orphan
                    // hidden WebView behind.
                    if cancelled_for_main.load(Ordering::SeqCst)
                        || destroy_epoch_for_main.load(Ordering::SeqCst) != expected_destroy_epoch
                    {
                        let _ = window.destroy();
                        let _ = build_tx
                            .send(Err("scrape was cancelled during main-thread build".into()));
                    } else {
                        let _ = build_tx.send(Ok(()));
                    }
                }
                Err(e) => {
                    let _ = build_tx.send(Err(e.to_string()));
                }
            }
        });
        if let Err(e) = result {
            return Err(ScraperError::WindowCreate(format!(
                "run_on_main_thread failed: {e}"
            )));
        }
        match build_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(ScraperError::WindowCreate(e)),
            Err(_) => {
                return Err(ScraperError::WindowCreate(
                    "main-thread channel dropped".into(),
                ))
            }
        }
        Ok(())
    }

    fn hidden_label(&self) -> String {
        format!("{}-hidden", self.config.slug)
    }

    fn login_label(&self) -> String {
        format!("{}-login", self.config.slug)
    }

    fn clear_label(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        format!("{}-clear-{n}", self.config.slug)
    }

    /// Helper used by `delete_provider_data` to surface the on-disk session
    /// directory (Windows / Linux) or `None` (macOS uses
    /// `WKWebsiteDataStore`).
    #[allow(dead_code)] // public API for Codex #31; commands.rs reaches in directly via SessionStorage
    pub fn data_directory(&self) -> Option<PathBuf> {
        data_directory_for(&self.storage)
    }
}

fn host_of(url_str: &str) -> Option<String> {
    Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
}

fn target_url_with_generation(target_url: &str, generation: u64) -> Result<Url, ScraperError> {
    let mut url = Url::parse(target_url)
        .map_err(|e| ScraperError::WindowCreate(format!("invalid target URL: {e}")))?;
    url.query_pairs_mut()
        .append_pair(HIDDEN_REFRESH_GENERATION_PARAM, &generation.to_string());
    let marker = format!("{HIDDEN_REFRESH_GENERATION_PARAM}={generation}");
    let fragment = match url.fragment() {
        Some(existing) if !existing.is_empty() => format!("{existing}&{marker}"),
        _ => marker,
    };
    url.set_fragment(Some(&fragment));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::webview::ProviderHostAllowlist;

    static TEST_ALLOWLIST: ProviderHostAllowlist =
        ProviderHostAllowlist::new(&["example.com", "*.example.com"]);

    #[test]
    fn parse_title_payload_returns_none_without_prefix() {
        assert!(parse_title_payload("Hello world").is_none());
        assert!(parse_title_payload("").is_none());
    }

    #[test]
    fn parse_title_payload_decodes_ok_variant() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":true,\"rows\":[1,2,3]}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Ok { rows, generation } => {
                assert_eq!(rows, serde_json::json!([1, 2, 3]));
                assert_eq!(generation, None);
            }
            other => panic!("expected Ok variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_ok_without_rows_uses_null() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":true}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Ok { rows, generation } => {
                assert_eq!(rows, serde_json::Value::Null);
                assert_eq!(generation, None);
            }
            other => panic!("expected Ok variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_decodes_ok_generation() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":true,\"rows\":[],\"generation\":42}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Ok { generation, .. } => assert_eq!(generation, Some(42)),
            other => panic!("expected Ok variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_decodes_err_variant() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":false,\"kind\":\"cloudflare-challenge\"}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Err {
                kind,
                message,
                generation,
            } => {
                assert_eq!(kind, ScraperErrorKind::CloudflareChallenge);
                assert!(message.is_none());
                assert_eq!(generation, None);
            }
            other => panic!("expected Err variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_decodes_err_with_message() {
        let title = format!(
            "{TITLE_PREFIX}{{\"ok\":false,\"kind\":\"no-rows\",\"message\":\"hydrating\"}}"
        );
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Err {
                kind,
                message,
                generation,
            } => {
                assert_eq!(kind, ScraperErrorKind::NoRows);
                assert_eq!(message.as_deref(), Some("hydrating"));
                assert_eq!(generation, None);
            }
            other => panic!("expected Err variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_decodes_err_generation() {
        let title =
            format!("{TITLE_PREFIX}{{\"ok\":false,\"kind\":\"logged-out\",\"generation\":99}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Err { generation, .. } => assert_eq!(generation, Some(99)),
            other => panic!("expected Err variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_surfaces_unknown_error_kind() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":false,\"kind\":\"something-new\"}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Err { kind, .. } => assert_eq!(kind, ScraperErrorKind::Unknown),
            other => panic!("expected Err variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_err_without_kind_defaults_to_unknown() {
        let title = format!("{TITLE_PREFIX}{{\"ok\":false}}");
        let parsed = parse_title_payload(&title)
            .expect("prefix present")
            .unwrap();
        match parsed {
            ScraperPayload::Err {
                kind,
                message,
                generation,
            } => {
                assert_eq!(kind, ScraperErrorKind::Unknown);
                assert!(message.is_none());
                assert_eq!(generation, None);
            }
            other => panic!("expected Err variant, got {other:?}"),
        }
    }

    #[test]
    fn parse_title_payload_returns_err_for_malformed_json() {
        let title = format!("{TITLE_PREFIX}{{not json");
        let parsed = parse_title_payload(&title).expect("prefix present");
        assert!(parsed.is_err());
    }

    #[test]
    fn target_url_with_generation_sets_query_and_fragment_markers() {
        let url = target_url_with_generation("https://example.com/settings/usage", 7)
            .expect("valid target URL");
        assert_eq!(
            url.as_str(),
            "https://example.com/settings/usage?qhgen=7#qhgen=7"
        );
    }

    #[test]
    fn target_url_with_generation_preserves_existing_query_and_fragment() {
        let url =
            target_url_with_generation("https://example.com/settings/usage?tab=limits#section", 7)
                .expect("valid target URL");
        assert_eq!(
            url.as_str(),
            "https://example.com/settings/usage?tab=limits&qhgen=7#section&qhgen=7"
        );
    }

    #[test]
    fn navigation_tracker_allows_static_allowlist_without_opening_chain() {
        let mut tracker = LoginRedirectTracker::new();
        let decision = tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
        assert!(!tracker.in_chain(), "static allow must not open a chain");
    }

    #[test]
    fn navigation_tracker_allows_wildcard_supporting_host() {
        let mut tracker = LoginRedirectTracker::new();
        let decision = tracker.decide("cdn.example.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
        assert!(!tracker.in_chain());
    }

    #[test]
    fn navigation_tracker_opens_chain_on_idp_redirect_from_target() {
        // The intended flow: provider's own page → /login → IDP. The static
        // allow on the target arms the IDP gate; the subsequent IDP hop is
        // then permitted and opens the chain.
        let mut tracker = LoginRedirectTracker::new();
        tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        let decision = tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
        assert!(tracker.in_chain(), "IDP redirect must open a chain");
    }

    #[test]
    fn navigation_tracker_blocks_idp_without_prior_static_navigation() {
        // Direct top-level navigation to an IDP host (no prior static-allow
        // navigation) must be blocked — Codex Review pointed out that the
        // previous unconditional `Allow` for KNOWN_IDP_SUFFIXES bypassed the
        // "only during a provider login chain" constraint.
        let mut tracker = LoginRedirectTracker::new();
        let decision = tracker.decide("github.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Block);
        assert!(
            !tracker.in_chain(),
            "blocked IDP navigation must not open a chain"
        );
    }

    #[test]
    fn navigation_tracker_resets_chain_on_return_to_target() {
        let mut tracker = LoginRedirectTracker::new();
        // Bootstrap an IDP chain via the legitimate static → IDP path.
        tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        assert!(tracker.in_chain());
        // Land back on target → chain resets.
        let decision = tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
        assert!(!tracker.in_chain(), "returning to target must reset");
    }

    #[test]
    fn navigation_tracker_blocks_unknown_host() {
        let mut tracker = LoginRedirectTracker::new();
        let decision = tracker.decide("evil.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Block);
        assert!(!tracker.in_chain());
    }

    #[test]
    fn navigation_tracker_blocks_unknown_host_even_during_chain() {
        // Once a chain is open, a totally unrelated host is still blocked.
        // This is the conservative posture described in the doc comment.
        let mut tracker = LoginRedirectTracker::new();
        tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        let decision = tracker.decide("evil.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Block);
    }

    #[test]
    fn navigation_tracker_force_reset_works() {
        let mut tracker = LoginRedirectTracker::new();
        tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        assert!(tracker.in_chain());
        tracker.reset();
        assert!(!tracker.in_chain());
    }

    #[test]
    fn navigation_tracker_idp_hops_within_chain_stay_allowed() {
        // Once a chain is open, additional IDP hops are permitted (Google → corp
        // SSO → Google). This verifies the `in_chain || last_was_static` half
        // still works after the IDP gate tightening.
        let mut tracker = LoginRedirectTracker::new();
        tracker.decide("example.com", "example.com", &TEST_ALLOWLIST);
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        let decision = tracker.decide("login.microsoftonline.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
    }

    #[test]
    fn data_directory_for_data_directory_returns_path() {
        let storage = SessionStorage::DataDirectory(PathBuf::from("/tmp/x"));
        assert_eq!(data_directory_for(&storage), Some(PathBuf::from("/tmp/x")));
    }

    #[test]
    fn data_directory_for_data_store_identifier_returns_none() {
        let storage = SessionStorage::DataStoreIdentifier(uuid::Uuid::from_bytes([0u8; 16]));
        assert_eq!(data_directory_for(&storage), None);
    }

    #[test]
    fn permit_hostless_scheme_admits_inert_internal_schemes() {
        assert!(permit_hostless_scheme("about", "test"));
        assert!(permit_hostless_scheme("data", "test"));
        assert!(permit_hostless_scheme("blob", "test"));
    }

    #[test]
    fn payload_summary_redacts_row_text() {
        // The summary must never echo the raw row contents (chat-sidebar
        // text on Claude, model-breakdown labels on Codex). Only counts /
        // kinds may surface in info-level logs.
        let parsed = parse_title_payload(&format!(
            "{TITLE_PREFIX}{{\"ok\":true,\"rows\":[{{\"raw\":\"100%キーボード\"}},{{\"raw\":\"another secret\"}}]}}"
        ));
        let summary = payload_summary(&parsed);
        assert_eq!(summary, "ok rows=2");
        assert!(!summary.contains("キーボード"));
        assert!(!summary.contains("secret"));
    }

    #[test]
    fn payload_summary_surfaces_error_kind_without_message() {
        let parsed = parse_title_payload(&format!(
            "{TITLE_PREFIX}{{\"ok\":false,\"kind\":\"logged-out\",\"message\":\"some private path\"}}"
        ));
        let summary = payload_summary(&parsed);
        assert!(summary.starts_with("err kind="));
        assert!(!summary.contains("private path"));
    }

    #[test]
    fn payload_summary_handles_unparseable_input() {
        assert_eq!(
            payload_summary(&Some(Err("bad json".into()))),
            "parse-error"
        );
        assert_eq!(payload_summary(&None), "no-prefix");
    }

    #[test]
    fn permit_hostless_scheme_blocks_unsafe_schemes() {
        // `javascript:` could execute attacker-controlled code in the
        // scraper context, `file:` could exfiltrate local content — both
        // appear as hostless top-level navigations and must not bypass
        // the host allowlist via the empty-host shortcut.
        assert!(!permit_hostless_scheme("javascript", "test"));
        assert!(!permit_hostless_scheme("file", "test"));
        assert!(!permit_hostless_scheme("ftp", "test"));
        assert!(!permit_hostless_scheme("", "test"));
    }
}
