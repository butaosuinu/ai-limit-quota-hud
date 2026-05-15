//! **Temporary stub** for the shared `WebviewScraper` actor.
//!
//! The canonical implementation is owned by the sibling PR #30 (Claude
//! WebView provider). This file exists only so that #31's `codex_web.rs`
//! can compile and unit-test before #30 lands. When #30 merges first this
//! whole module is replaced wholesale by the canonical version — the
//! `codex_web.rs` call sites only depend on the small surface declared
//! here, so a rebase is mechanical.
//!
//! Hard rules while this stub is in place:
//!
//! - Every method below is a non-trivial `Result::Err` so a misconfigured
//!   build can never accidentally pretend to scrape. `refresh()` returns a
//!   well-formed `ScraperError::NotImplemented` and the rest mirror the
//!   eventual API shape (`open_login`, `delete_data`).
//! - `#[allow(dead_code)]` is dropped on the items that are exercised only
//!   by integration paths today; unit tests in `codex_web.rs` poke at the
//!   pure JS-output → snapshot parsing path, which doesn't need a live
//!   `WebviewScraper` at all.
//!
//! See `docs/PROJECT_SPEC.md` §8.7 for the high-level behavior this scraper
//! is meant to implement when #30 lands:
//!   - visible login window navigating to `login_url`
//!   - hidden refresh window pointed at `scrape_url`
//!   - JS injection via `extractor_js`
//!   - result polling through `document.title = "QHJSON:<payload>"`
//!   - egress filtered through `host_allowlist` + `KNOWN_IDP_SUFFIXES`
//!   - per-provider session isolation via `SessionStorage`

use std::time::Duration;

use serde::Serialize;
use thiserror::Error;

use crate::model::ProviderKind;
use crate::providers::webview::{ProviderHostAllowlist, SessionStorage};

const DEFAULT_POLL_TIMEOUT_MS: u64 = 25_000;
const DEFAULT_POLL_INTERVAL_MS: u64 = 100;

/// Static configuration for one provider's scraper.
///
/// All fields are `'static` because the canonical impl (#30) plans to
/// `include_str!` the extractor JS and bake the URLs into a constant. Keeping
/// the lifetime here matches that intent and avoids one round of `String`
/// allocations per refresh tick.
#[allow(dead_code)] // exercised by #30 once the canonical scraper lands
#[derive(Debug, Clone)]
pub struct WebviewScraperConfig {
    pub provider_kind: ProviderKind,
    pub login_url: &'static str,
    pub scrape_url: &'static str,
    pub extractor_js: &'static str,
    pub host_allowlist: ProviderHostAllowlist,
    pub poll_timeout_ms: u64,
    pub poll_interval_ms: u64,
}

impl WebviewScraperConfig {
    /// Build a config with the project-spec defaults for the polling knobs
    /// (25 s overall budget, 100 ms intra-poll sleep). Callers only need to
    /// pass the provider-specific fields.
    #[allow(dead_code)] // exercised by #30 once the canonical scraper lands
    pub const fn new(
        provider_kind: ProviderKind,
        login_url: &'static str,
        scrape_url: &'static str,
        extractor_js: &'static str,
        host_allowlist: ProviderHostAllowlist,
    ) -> Self {
        Self {
            provider_kind,
            login_url,
            scrape_url,
            extractor_js,
            host_allowlist,
            poll_timeout_ms: DEFAULT_POLL_TIMEOUT_MS,
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
        }
    }
}

/// Failure modes a scraper can surface. The variants intentionally mirror the
/// snapshot statuses they map to in `docs/PROJECT_SPEC.md` §8.7 (Cloudflare /
/// login redirect / layout change) so the provider can pick `Error` vs
/// `NoData` without re-parsing the message.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScraperError {
    /// Stub-only: returned by every method while the canonical impl is not
    /// yet linked. Will be removed when #30 lands.
    #[error("WebView scraper is not implemented yet — placeholder until PR #30 lands")]
    NotImplemented,
    /// Page demanded a "verify you are human" check; we cannot solve it
    /// non-interactively. Maps to `SnapshotStatus::Error`.
    #[error("provider page is gated by a Cloudflare/turnstile challenge")]
    CloudflareChallenge,
    /// We landed on `/auth/login` (or equivalent) — the session expired.
    /// Maps to `SnapshotStatus::NoData` with a re-login hint.
    #[error("provider session expired; re-login required")]
    LoginRequired,
    /// Extractor returned `null` or signalled `"layout may have changed"`.
    /// Maps to `SnapshotStatus::Error` because it means the heuristics need
    /// to be updated.
    #[error("extractor returned no data; provider page layout may have changed")]
    LayoutChanged,
    /// Generic transport / timeout / JS exception path. Maps to
    /// `SnapshotStatus::Error`.
    #[error("scraper failure: {0}")]
    Other(String),
}

/// Public marker for the shared scraper actor. The canonical implementation
/// (PR #30) replaces this struct with the real one — callers only see
/// `new`, `refresh`, `open_login`, `delete_data`.
#[allow(dead_code)] // every field is consumed by #30's canonical impl
pub struct WebviewScraper {
    config: WebviewScraperConfig,
    session: SessionStorage,
}

impl WebviewScraper {
    /// Construct a scraper for one provider. `app` is taken but currently
    /// unused; the canonical impl uses it to build the hidden / visible
    /// WebView windows.
    #[allow(dead_code)] // exercised by #30 once the canonical scraper lands
    pub fn new(
        _app: tauri::AppHandle,
        config: WebviewScraperConfig,
        session: SessionStorage,
    ) -> Self {
        Self { config, session }
    }

    /// Trigger one scrape cycle. Returns the JSON payload extracted from
    /// `document.title` after stripping the `QHJSON:` prefix, or a typed
    /// error matching one of the failure modes documented above.
    #[allow(dead_code)] // exercised by #30 once the canonical scraper lands
    pub async fn refresh(&self) -> Result<serde_json::Value, ScraperError> {
        Err(ScraperError::NotImplemented)
    }

    /// Open the provider's first-party login page in a *visible* WebView
    /// window. Tauri 2 / Wry creates the window with the provider's own
    /// `SessionStorage` so cookies set by the login flow are reusable from
    /// the hidden refresh window.
    #[allow(dead_code)] // exercised by #30 once the canonical scraper lands
    pub async fn open_login(&self) -> Result<(), ScraperError> {
        Err(ScraperError::NotImplemented)
    }

    /// Forget every cookie / cache entry for this provider's session.
    /// Implementation is platform-specific (see `SessionStorage`).
    #[allow(dead_code)] // exercised by #30 once the canonical scraper lands
    pub async fn delete_data(&self) -> Result<(), ScraperError> {
        Err(ScraperError::NotImplemented)
    }

    /// Diagnostic accessor used by tests today and by the canonical impl
    /// internally.
    #[allow(dead_code)]
    pub fn config(&self) -> &WebviewScraperConfig {
        &self.config
    }

    /// Diagnostic accessor used by tests today and by the canonical impl
    /// internally.
    #[allow(dead_code)]
    pub fn session(&self) -> &SessionStorage {
        &self.session
    }

    /// Constant exposed for the canonical impl to keep the same key in sync.
    /// Anything appearing in `document.title` after this prefix is treated
    /// as the extractor's JSON payload.
    #[allow(dead_code)]
    pub const TITLE_PAYLOAD_PREFIX: &'static str = "QHJSON:";

    /// Hard upper bound on a single scrape attempt; the polling loop in #30
    /// will give up after this much wall clock.
    #[allow(dead_code)]
    pub fn poll_timeout(&self) -> Duration {
        Duration::from_millis(self.config.poll_timeout_ms)
    }

    /// Intra-poll sleep used by #30's polling loop.
    #[allow(dead_code)]
    pub fn poll_interval(&self) -> Duration {
        Duration::from_millis(self.config.poll_interval_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec_timeouts() {
        // Sanity check: the project spec calls for a ~25 s overall budget
        // per scrape and a 100 ms intra-poll sleep. The constants are kept
        // here so a future tuning change has to update both the doc and
        // this test.
        assert_eq!(DEFAULT_POLL_TIMEOUT_MS, 25_000);
        assert_eq!(DEFAULT_POLL_INTERVAL_MS, 100);
    }

    #[test]
    fn config_new_keeps_defaults_for_polling() {
        let cfg = WebviewScraperConfig::new(
            ProviderKind::WebviewChatgptCodex,
            "https://example.com/login",
            "https://example.com/usage",
            "",
            ProviderHostAllowlist::new(&[]),
        );
        assert_eq!(cfg.poll_timeout_ms, DEFAULT_POLL_TIMEOUT_MS);
        assert_eq!(cfg.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
        assert_eq!(cfg.provider_kind, ProviderKind::WebviewChatgptCodex);
    }
}
