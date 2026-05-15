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
//! - `WebviewScraper::run_hidden` builds a hidden `WebviewWindow`, hops to
//!   the Tauri main thread to construct it (Wry requires main-thread
//!   construction on macOS), injects the extractor as an initialization
//!   script, and waits on a `tokio::sync::oneshot` channel that is signaled
//!   from the `on_document_title_changed` callback. The window is destroyed
//!   in all paths so a refresh tick never leaks a window.
//! - `WebviewScraper::open_visible_login` is the visible-login equivalent;
//!   no extractor JS is injected and no title polling happens. The caller
//!   (a Tauri command) just returns once the window exists.
//!
//! Pure helpers (the JSON parsing, allowlist matching, idle login redirect
//! reasoning) live here as free functions so they are unit-testable without
//! a Tauri runtime.

use std::path::PathBuf;
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
/// extractor JS emits a payload). Set to 25 s to leave headroom under the
/// scheduler's 15 s soft timeout while still failing closed quickly if the
/// page is unresponsive.
pub const DEFAULT_REFRESH_TIMEOUT: Duration = Duration::from_secs(25);

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
}

/// Decoded shape of the JSON payload the extractor JS writes into
/// `document.title`. The concrete provider module casts the `rows` payload
/// into `UsageSnapshot[]` itself — the scraper does not care about the
/// per-provider row shape.
#[derive(Debug, Clone)]
pub enum ScraperPayload {
    /// `{ "ok": true, "rows": [...] }`. The provider module interprets the
    /// row JSON.
    Ok { rows: serde_json::Value },
    /// `{ "ok": false, "kind": "...", "message"?: "..." }`.
    Err {
        kind: ScraperErrorKind,
        message: Option<String>,
    },
}

impl ScraperPayload {
    fn from_raw(raw: RawScraperPayload) -> Result<Self, String> {
        if raw.ok {
            Ok(Self::Ok {
                rows: raw.rows.unwrap_or(serde_json::Value::Null),
            })
        } else {
            Ok(Self::Err {
                kind: raw.kind.unwrap_or(ScraperErrorKind::Unknown),
                message: raw.message,
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScraperErrorKind {
    CloudflareChallenge,
    LoggedOut,
    NoRows,
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
}

impl LoginRedirectTracker {
    pub fn new() -> Self {
        Self { in_chain: false }
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
        // Static allowlist always permits.
        if allowlist.permits(&nav_host) {
            // Reset the chain when we return to the target origin so a
            // stale IDP allowance doesn't outlive the login flow.
            if nav_host == target_host {
                self.in_chain = false;
            }
            return NavigationDecision::Allow;
        }
        // Otherwise, allow IDP hosts but only while a chain is active. The
        // chain itself is bootstrapped by the *first* IDP redirect from the
        // target — that is, when we are leaving the target for a known IDP.
        if host_is_known_idp(&nav_host) {
            self.in_chain = true;
            return NavigationDecision::Allow;
        }
        // While in a chain, additional IDP hops (e.g. Google → corp SSO →
        // Google) may pass through hosts we haven't tagged. We keep this
        // conservative: anything not on either list while in-chain is still
        // blocked, but the chain itself stays open in case a subsequent
        // navigation does land on an IDP suffix we know.
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
fn apply_session_storage<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    storage: &SessionStorage,
) -> WebviewWindowBuilder<'a, R, M> {
    match storage {
        SessionStorage::DataDirectory(path) => builder.data_directory(path.clone()),
        SessionStorage::DataStoreIdentifier(uuid) => {
            let bytes: [u8; 16] = *uuid.as_bytes();
            builder.data_store_identifier(bytes)
        }
    }
}

/// Apply the hidden-window flags from §8.7. The flags are platform-aware
/// (macOS doesn't expose `skip_taskbar` per Tauri 2 docs).
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
    b
}

/// RAII guard that destroys the named hidden window on drop.
///
/// The previous shape — running the refresh, then unconditionally calling
/// `window.destroy()` after the `.await` — only worked when the local
/// `tokio::time::timeout` fired. The scheduler wraps each `provider.refresh()`
/// in its own outer 15 s `tokio::time::timeout`; when that one fires first,
/// our future is dropped mid-await and the post-await cleanup is never
/// reached, leaking the hidden window. A `Drop` impl runs on every
/// termination path (success, timeout, cancellation, panic), so the window
/// is always torn down even when the future is cancelled by the caller.
struct WindowDestroyGuard {
    app: AppHandle,
    label: String,
}

impl Drop for WindowDestroyGuard {
    fn drop(&mut self) {
        if let Some(window) = self.app.get_webview_window(&self.label) {
            let _ = window.destroy();
        }
    }
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
    /// Counter used to mint unique window labels per call so a previous
    /// refresh that is still tearing down doesn't collide with the next.
    counter: Arc<std::sync::atomic::AtomicU64>,
}

impl WebviewScraper {
    pub fn new(app: AppHandle, config: ScraperConfig, storage: SessionStorage) -> Self {
        Self {
            app,
            config,
            storage,
            counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
        let label_clone = label.clone();
        let title = format!("{} login", self.config.slug);
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
            let builder = apply_session_storage(builder, &storage);
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

    /// Run one hidden refresh cycle. Creates a hidden window, waits for the
    /// extractor JS to emit a payload via `document.title`, parses it, and
    /// returns the parsed payload. Closes the window in all paths.
    pub async fn run_hidden(&self) -> Result<ScraperPayload, ScraperError> {
        self.run_hidden_with_timeout(DEFAULT_REFRESH_TIMEOUT).await
    }

    /// Same as [`Self::run_hidden`] but with a caller-supplied timeout.
    /// Exposed so tests / configuration can shorten the wait.
    pub async fn run_hidden_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<ScraperPayload, ScraperError> {
        let label = self.hidden_label();
        // Drop-based cleanup so the window is destroyed even when the outer
        // future (e.g. scheduler's `tokio::time::timeout`) cancels us before
        // the post-`.await` block can run. See `WindowDestroyGuard`.
        let _guard = WindowDestroyGuard {
            app: self.app.clone(),
            label: label.clone(),
        };
        let result = tokio::time::timeout(timeout, self.run_hidden_inner(label)).await;
        match result {
            Ok(inner) => inner,
            Err(_) => Err(ScraperError::Timeout(timeout)),
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

    async fn run_hidden_inner(&self, label: String) -> Result<ScraperPayload, ScraperError> {
        let (tx, rx) = oneshot::channel::<String>();
        // Wrap the sender in a mutex so the title callback (Fn, not FnMut)
        // can take it once and ignore subsequent fires.
        let tx_slot: Arc<Mutex<Option<oneshot::Sender<String>>>> = Arc::new(Mutex::new(Some(tx)));
        let app = self.app.clone();
        let storage = self.storage.clone();
        let target_url = self.config.target_url;
        let extractor_js = self.config.extractor_js;
        let allowlist = self.config.host_allowlist;
        let target_host = host_of(target_url).unwrap_or_default();
        let label_clone = label.clone();
        let tx_slot_clone = Arc::clone(&tx_slot);

        // The login tracker is shared between the navigation callback and the
        // (rare) cleanup path. For a hidden refresh we expect zero IDP hops
        // — if the session is still valid the only navigation is to the
        // target origin. If it isn't, we'd see a `/login` redirect, which
        // the extractor JS reports as `logged-out`.
        let tracker: Arc<Mutex<LoginRedirectTracker>> =
            Arc::new(Mutex::new(LoginRedirectTracker::new()));
        let tracker_nav = Arc::clone(&tracker);

        let (build_tx, build_rx) = oneshot::channel::<Result<(), String>>();
        let app_for_main = app.clone();
        let result = app.run_on_main_thread(move || {
            let app = app_for_main;
            let url = match Url::parse(target_url) {
                Ok(u) => u,
                Err(e) => {
                    let _ = build_tx.send(Err(format!("invalid target URL: {e}")));
                    return;
                }
            };
            let builder = WebviewWindowBuilder::new(&app, &label_clone, WebviewUrl::External(url))
                .title("QuotaHUD scraper");
            let builder = apply_hidden_window_flags(builder);
            let builder = apply_session_storage(builder, &storage);
            let builder = builder.initialization_script(extractor_js);
            // Enforce the static / dynamic egress allowlist on every
            // top-level navigation. Returning false cancels the navigation.
            let builder = builder.on_navigation({
                let target_host = target_host.clone();
                let tracker = Arc::clone(&tracker_nav);
                move |url| {
                    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
                    let mut guard = tracker
                        .lock()
                        .expect("scraper login tracker mutex poisoned");
                    match guard.decide(&host, &target_host, allowlist) {
                        NavigationDecision::Allow => true,
                        NavigationDecision::Block => {
                            log::warn!(
                                "webview scraper blocked navigation to disallowed host: {host}"
                            );
                            false
                        }
                    }
                }
            });
            // Title-change callback is our result channel. The extractor JS
            // writes `QHJSON:{...}` whenever it finishes a pass; we take the
            // first such title and signal the oneshot — except for the
            // `no-rows` transient kind below, which the extractor publishes
            // during SPA hydration and retries on its own. Resolving on
            // that first emit would race the retry and false-error the
            // snapshot, so we drop it and keep waiting for the next title
            // change (success / cloudflare / logged-out / layout-changed
            // are all final). The outer `tokio::time::timeout` still
            // bounds the wait.
            let builder = builder.on_document_title_changed({
                let tx_slot = Arc::clone(&tx_slot_clone);
                move |_window, title| {
                    if !title.starts_with(TITLE_PREFIX) {
                        return;
                    }
                    if let Some(Ok(ScraperPayload::Err {
                        kind: ScraperErrorKind::NoRows,
                        ..
                    })) = parse_title_payload(&title)
                    {
                        return;
                    }
                    let mut slot = tx_slot
                        .lock()
                        .expect("scraper title oneshot mutex poisoned");
                    if let Some(sender) = slot.take() {
                        let _ = sender.send(title);
                    }
                }
            });
            match builder.build() {
                Ok(_window) => {
                    let _ = build_tx.send(Ok(()));
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
        // Wait for the title channel. The `tokio::time::timeout` around
        // `run_hidden_inner` enforces the upper bound.
        let title = match rx.await {
            Ok(t) => t,
            Err(_) => {
                return Err(ScraperError::Eval(
                    "extractor never wrote to document.title".into(),
                ))
            }
        };
        // Best-effort title reset so a stale value isn't picked up by the
        // next title change.
        if let Some(window) = self.app.get_webview_window(&label) {
            let _ = window.set_title("QuotaHUD scraper");
        }
        match parse_title_payload(&title) {
            Some(Ok(payload)) => Ok(payload),
            Some(Err(e)) => Err(ScraperError::Parse(e)),
            None => Err(ScraperError::Parse(format!(
                "title did not carry {TITLE_PREFIX} prefix: {title}",
            ))),
        }
    }

    fn hidden_label(&self) -> String {
        let n = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        format!("{}-hidden-{n}", self.config.slug)
    }

    fn login_label(&self) -> String {
        format!("{}-login", self.config.slug)
    }

    fn clear_label(&self) -> String {
        let n = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
            ScraperPayload::Ok { rows } => {
                assert_eq!(rows, serde_json::json!([1, 2, 3]));
            }
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
            ScraperPayload::Err { kind, message } => {
                assert_eq!(kind, ScraperErrorKind::CloudflareChallenge);
                assert!(message.is_none());
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
            ScraperPayload::Err { kind, message } => {
                assert_eq!(kind, ScraperErrorKind::NoRows);
                assert_eq!(message.as_deref(), Some("hydrating"));
            }
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
    fn parse_title_payload_returns_err_for_malformed_json() {
        let title = format!("{TITLE_PREFIX}{{not json");
        let parsed = parse_title_payload(&title).expect("prefix present");
        assert!(parsed.is_err());
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
    fn navigation_tracker_opens_chain_on_idp_redirect() {
        let mut tracker = LoginRedirectTracker::new();
        let decision = tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Allow);
        assert!(tracker.in_chain(), "IDP redirect must open a chain");
    }

    #[test]
    fn navigation_tracker_resets_chain_on_return_to_target() {
        let mut tracker = LoginRedirectTracker::new();
        // Bootstrap an IDP chain.
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
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        let decision = tracker.decide("evil.com", "example.com", &TEST_ALLOWLIST);
        assert_eq!(decision, NavigationDecision::Block);
    }

    #[test]
    fn navigation_tracker_force_reset_works() {
        let mut tracker = LoginRedirectTracker::new();
        tracker.decide("accounts.google.com", "example.com", &TEST_ALLOWLIST);
        assert!(tracker.in_chain());
        tracker.reset();
        assert!(!tracker.in_chain());
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
}
