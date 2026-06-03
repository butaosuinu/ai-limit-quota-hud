//! `CodexWebProvider` — opt-in WebView-backed provider for the chatgpt.com
//! Codex Cloud analytics page (PROJECT_SPEC §8.7).
//!
//! Data source: the visible content of
//! `https://chatgpt.com/codex/cloud/settings/analytics`, extracted by
//! `extractors/codex.js` running inside an isolated Tauri WebView. The
//! provider is **disabled by default** and only refreshes when the user has
//! flipped the toggle in Settings. All emitted snapshots carry
//! `source = WebviewScrape` and `confidence = Low` — the DOM contract of an
//! external web app is not a stable interface.
//!
//! Failure modes are mapped onto `SnapshotStatus`:
//!
//! - Cloudflare challenge → `Error` with a human-readable message.
//! - `/auth/login` redirect or visible "Log in" CTA → `NoData` (re-login
//!   required).
//! - Extractor returns no rows / DOM layout change → `Error` so the
//!   scheduler's exponential backoff kicks in.
//!
//! The cached snapshot is stored in memory only; restart re-derives it from
//! the next refresh. We deliberately do **not** persist scraped usage to
//! SQLite — the values are low-confidence and stale data is worse than no
//! data.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use time::OffsetDateTime;

use crate::model::{
    error_snapshot, format_rfc3339, no_data_snapshot, Confidence, ProviderKind, SnapshotStatus,
    UsageMetric, UsageSnapshot, UsageSource, UsageWindow,
};
use crate::provider_settings::ProviderSettingsStore;
use crate::providers::webview::scraper::{
    ScraperConfig, ScraperError, ScraperErrorKind, ScraperPayload, WebviewScraper,
};
use crate::providers::webview::{ProviderHostAllowlist, SessionStorage};
use crate::providers::{ProviderContext, UsageProvider};

pub const CODEX_WEB_PROVIDER_ID: &str = "webview-chatgpt-codex";
pub const CODEX_TARGET_URL: &str = "https://chatgpt.com/codex/cloud/settings/analytics";
pub const CODEX_LOGIN_URL: &str = "https://chatgpt.com/auth/login";
pub const CODEX_ACCOUNT_LABEL: &str = "Codex";

/// WebView providers are intentionally slow by default (PROJECT_SPEC §8).
/// See `claude_web::MIN_REFRESH_INTERVAL_SECS`.
pub const MIN_REFRESH_INTERVAL_SECS: u64 = 600;

/// Static allowlist for chatgpt.com's Codex Cloud analytics page (§14). The
/// page renders behind Cloudflare; first-party XHR and static-asset hosts
/// belong to OpenAI. We keep this short and explicit so additions go through
/// code review.
static CODEX_HOST_ALLOWLIST: ProviderHostAllowlist = ProviderHostAllowlist::new(&[
    "chatgpt.com",
    "*.chatgpt.com",
    "openai.com",
    "*.openai.com",
    "cdn.oaistatic.com",
    "cdn.openai.com",
]);

/// Embedded extractor JS — keeps it on the build artifact rather than
/// shipping a separate file to disk.
const CODEX_EXTRACTOR_JS: &str = include_str!("extractors/codex.js");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedRow {
    #[serde(default)]
    window_kind: Option<String>,
    #[serde(default)]
    percent_used: Option<f64>,
    #[serde(default)]
    reset_at: Option<String>,
    #[serde(default)]
    reset_label: Option<String>,
    // `raw` is purely diagnostic — we ignore it on the Rust side.
}

/// Cached latest snapshot list. Held behind an `RwLock` so the scheduler
/// loop (writer) and any concurrent `list_snapshots` reads (reader, via the
/// scheduler's own `latest` buffer) cannot deadlock — in practice only the
/// provider's own `refresh` writes here.
#[derive(Default)]
struct Cache {
    snapshots: Vec<UsageSnapshot>,
}

pub struct CodexWebProvider {
    storage: SessionStorage,
    scraper: Arc<RwLock<Option<WebviewScraper>>>,
    settings: Arc<ProviderSettingsStore>,
    cache: Arc<RwLock<Cache>>,
}

impl CodexWebProvider {
    pub fn new(data_dir: PathBuf, settings: Arc<ProviderSettingsStore>) -> Self {
        let storage = SessionStorage::for_provider(ProviderKind::WebviewChatgptCodex, &data_dir)
            .expect("codex provider kind must yield a known slug");
        // `data_dir` is consumed by `SessionStorage::for_provider`. We
        // don't keep it around — the provider's session paths are baked
        // into the `SessionStorage` value above.
        let _ = data_dir;
        Self {
            storage,
            scraper: Arc::new(RwLock::new(None)),
            settings,
            cache: Arc::new(RwLock::new(Cache::default())),
        }
    }

    /// Build the shared [`ScraperConfig`] for chatgpt.com. Exposed so the
    /// `open_provider_login_window` / `delete_provider_data` Tauri commands
    /// can mint their own scraper without going through the provider's own
    /// init path.
    pub fn scraper_config() -> ScraperConfig {
        ScraperConfig {
            slug: CODEX_WEB_PROVIDER_ID,
            target_url: CODEX_TARGET_URL,
            login_url: CODEX_LOGIN_URL,
            extractor_js: CODEX_EXTRACTOR_JS,
            host_allowlist: &CODEX_HOST_ALLOWLIST,
        }
    }

    /// Lazily attach an `AppHandle` so the provider can build hidden
    /// windows. Called from `lib.rs::init_provider_runtime` once the Tauri
    /// app handle is available. Until this is wired up `refresh` falls back
    /// to a `NoData` row explaining that the WebView runtime is not ready.
    #[cfg_attr(coverage_nightly, coverage(off))]
    pub fn attach_app(&self, app: tauri::AppHandle) {
        let scraper = WebviewScraper::new(app, Self::scraper_config(), self.storage.clone());
        if let Ok(mut guard) = self.scraper.write() {
            *guard = Some(scraper);
        }
    }

    pub fn session_storage(&self) -> &SessionStorage {
        &self.storage
    }

    /// Borrow the underlying [`WebviewScraper`] for callers that need to
    /// drive the login flow themselves (the `open_provider_login_window`
    /// command). Returns `None` while the Tauri app handle hasn't been
    /// attached yet — at that point no WebView can be constructed.
    pub fn attach_scraper_for_login(&self) -> Option<WebviewScraper> {
        self.scraper.read().ok().and_then(|guard| guard.clone())
    }

    fn is_enabled(&self) -> bool {
        self.settings.is_enabled(CODEX_WEB_PROVIDER_ID)
    }

    fn snapshots_from_payload(payload: ScraperPayload, now: &OffsetDateTime) -> Vec<UsageSnapshot> {
        match payload {
            ScraperPayload::Ok { rows, .. } => {
                let parsed: Vec<ExtractedRow> = match serde_json::from_value(rows) {
                    Ok(rows) => rows,
                    Err(e) => {
                        return vec![error_snapshot(
                            CODEX_WEB_PROVIDER_ID,
                            ProviderKind::WebviewChatgptCodex,
                            now,
                            format!("codex usage payload parse error: {e}"),
                        )];
                    }
                };
                if parsed.is_empty() {
                    return vec![no_data_snapshot(
                        CODEX_WEB_PROVIDER_ID,
                        ProviderKind::WebviewChatgptCodex,
                        CODEX_ACCOUNT_LABEL,
                        UsageSource::WebviewScrape,
                        now,
                        "chatgpt.com codex analytics page returned no rows",
                    )];
                }
                parsed
                    .into_iter()
                    .map(|row| snapshot_from_row(row, now))
                    .collect()
            }
            ScraperPayload::Err { kind, message, .. } => {
                vec![snapshot_from_payload_error(kind, message, now)]
            }
        }
    }

    #[cfg_attr(coverage_nightly, coverage(off))]
    fn record_cache(&self, snapshots: Vec<UsageSnapshot>) {
        if let Ok(mut guard) = self.cache.write() {
            guard.snapshots = snapshots;
        }
    }
}

fn classify_window(window_kind: Option<&str>) -> UsageWindow {
    match window_kind {
        Some("five-hours") => UsageWindow::FiveHours,
        Some("weekly") => UsageWindow::Weekly,
        _ => UsageWindow::Unknown,
    }
}

fn account_label_for_window(window_kind: Option<&str>) -> String {
    match window_kind {
        Some("weekly") => format!("{CODEX_ACCOUNT_LABEL} weekly"),
        Some("five-hours") => format!("{CODEX_ACCOUNT_LABEL} 5h"),
        _ => CODEX_ACCOUNT_LABEL.to_string(),
    }
}

fn snapshot_from_row(row: ExtractedRow, now: &OffsetDateTime) -> UsageSnapshot {
    let window = classify_window(row.window_kind.as_deref());
    let percent_used = row.percent_used.unwrap_or(0.0).clamp(0.0, 100.0);
    // The page reports % USED; QuotaHUD's data model tracks % REMAINING so
    // the threshold classifier behaves consistently across providers.
    let remaining_percent = (100.0 - percent_used).max(0.0);
    // Map the remaining % to a status using the global thresholds. We don't
    // have a true `remaining` count here (the page doesn't expose one),
    // so we rely on `remaining_percent` alone.
    let status = if remaining_percent < crate::model::DEFAULT_CRITICAL_PCT {
        SnapshotStatus::Critical
    } else if remaining_percent < crate::model::DEFAULT_WARN_PCT {
        SnapshotStatus::Warning
    } else {
        SnapshotStatus::Ok
    };
    let provider_id = match row.window_kind.as_deref() {
        Some(k) => format!("{CODEX_WEB_PROVIDER_ID}:{k}"),
        None => format!("{CODEX_WEB_PROVIDER_ID}:unknown"),
    };
    UsageSnapshot {
        provider_id,
        provider_kind: ProviderKind::WebviewChatgptCodex,
        account_label: account_label_for_window(row.window_kind.as_deref()),
        window,
        metric: UsageMetric::Percent,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: Some(remaining_percent),
        reset_at: row.reset_at,
        observed_at: format_rfc3339(now),
        source: UsageSource::WebviewScrape,
        confidence: Confidence::Low,
        status,
        message: row.reset_label.map(|s| format!("resets {s}")),
    }
}

fn snapshot_from_payload_error(
    kind: ScraperErrorKind,
    message: Option<String>,
    now: &OffsetDateTime,
) -> UsageSnapshot {
    match kind {
        ScraperErrorKind::CloudflareChallenge => error_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            now,
            "Cloudflare challenge — re-open chatgpt.com in a normal browser to clear the challenge",
        ),
        ScraperErrorKind::LoggedOut => no_data_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            CODEX_ACCOUNT_LABEL,
            UsageSource::WebviewScrape,
            now,
            "chatgpt.com session expired — open Settings → Codex (web) → Login again",
        ),
        // Transient NoRows is filtered out by the scraper's title callback
        // (extractor retries internally); seeing it here is a defensive
        // fallback that should not happen in normal operation.
        ScraperErrorKind::NoRows | ScraperErrorKind::NoRowsFinal => error_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            now,
            message.unwrap_or_else(|| {
                "chatgpt.com codex analytics returned no parseable rows".to_string()
            }),
        ),
        ScraperErrorKind::EmitFailed | ScraperErrorKind::Unknown => error_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            now,
            message
                .unwrap_or_else(|| "chatgpt.com extractor reported an unknown error".to_string()),
        ),
    }
}

fn snapshot_from_scraper_error(err: ScraperError, now: &OffsetDateTime) -> UsageSnapshot {
    let message = match err {
        ScraperError::Timeout(d) => format!("chatgpt.com refresh timed out after {d:?}"),
        ScraperError::WindowCreate(e) => format!("could not create WebView window: {e}"),
        ScraperError::Eval(e) => format!("could not evaluate extractor JS: {e}"),
        ScraperError::Parse(e) => format!("could not parse extractor payload: {e}"),
        ScraperError::BlockedNavigation(host) => {
            format!("blocked navigation to disallowed host: {host}")
        }
    };
    error_snapshot(
        CODEX_WEB_PROVIDER_ID,
        ProviderKind::WebviewChatgptCodex,
        now,
        message,
    )
}

#[async_trait]
impl UsageProvider for CodexWebProvider {
    fn id(&self) -> &'static str {
        CODEX_WEB_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::WebviewChatgptCodex
    }

    fn min_refresh_interval(&self) -> Duration {
        Duration::from_secs(MIN_REFRESH_INTERVAL_SECS)
    }

    #[cfg_attr(coverage_nightly, coverage(off))]
    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let now = ctx.clock.now();
        // Opt-in gate (§8.7). If the user has not flipped the toggle we
        // emit nothing — the overlay simply doesn't render a row.
        if !self.is_enabled() {
            if let Some(scraper) = self.attach_scraper_for_login() {
                scraper.destroy_hidden_window();
            }
            return Ok(Vec::new());
        }
        // Grab a scraper handle without holding the lock across `await`.
        let scraper = match self.scraper.read() {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        };
        let Some(scraper) = scraper else {
            return Ok(vec![no_data_snapshot(
                CODEX_WEB_PROVIDER_ID,
                ProviderKind::WebviewChatgptCodex,
                CODEX_ACCOUNT_LABEL,
                UsageSource::WebviewScrape,
                &now,
                "WebView runtime not attached yet",
            )]);
        };
        let result = scraper.run_hidden().await;
        let snapshots = match result {
            Ok(payload) => Self::snapshots_from_payload(payload, &now),
            Err(err) => vec![snapshot_from_scraper_error(err, &now)],
        };
        self.record_cache(snapshots.clone());
        Ok(snapshots)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn now_fixture() -> OffsetDateTime {
        datetime!(2026-05-16 12:00:00 UTC)
    }

    #[test]
    fn min_refresh_interval_matches_webview_budget() {
        assert_eq!(MIN_REFRESH_INTERVAL_SECS, 600);
    }

    #[test]
    fn classify_window_maps_known_kinds() {
        assert_eq!(classify_window(Some("five-hours")), UsageWindow::FiveHours);
        assert_eq!(classify_window(Some("weekly")), UsageWindow::Weekly);
        assert_eq!(classify_window(Some("unknown")), UsageWindow::Unknown);
        assert_eq!(classify_window(None), UsageWindow::Unknown);
        // Codex does not have an "Opus weekly" window — it must fall
        // through to Unknown rather than mis-classifying as Weekly.
        assert_eq!(classify_window(Some("weekly-opus")), UsageWindow::Unknown);
    }

    #[test]
    fn account_label_distinguishes_windows() {
        assert_eq!(account_label_for_window(Some("five-hours")), "Codex 5h");
        assert_eq!(account_label_for_window(Some("weekly")), "Codex weekly");
        assert_eq!(account_label_for_window(None), "Codex");
        assert_eq!(account_label_for_window(Some("mystery")), "Codex");
    }

    #[test]
    fn snapshot_from_row_inverts_used_to_remaining() {
        let row = ExtractedRow {
            window_kind: Some("five-hours".into()),
            percent_used: Some(25.0),
            reset_at: Some("2026-05-16T17:00:00Z".into()),
            reset_label: Some("in 5 hours".into()),
        };
        let snap = snapshot_from_row(row, &now_fixture());
        assert_eq!(snap.provider_kind, ProviderKind::WebviewChatgptCodex);
        assert_eq!(snap.source, UsageSource::WebviewScrape);
        assert_eq!(snap.confidence, Confidence::Low);
        assert_eq!(snap.window, UsageWindow::FiveHours);
        assert_eq!(snap.metric, UsageMetric::Percent);
        assert_eq!(snap.remaining_percent, Some(75.0));
        // 75% remaining → Ok (above the 30% warn floor).
        assert_eq!(snap.status, SnapshotStatus::Ok);
        assert!(snap.message.as_deref().unwrap().contains("resets"));
        assert_eq!(snap.provider_id, "webview-chatgpt-codex:five-hours");
        assert_eq!(snap.account_label, "Codex 5h");
    }

    #[test]
    fn snapshot_from_row_classifies_critical_when_nearly_full() {
        let row = ExtractedRow {
            window_kind: Some("weekly".into()),
            percent_used: Some(95.0),
            reset_at: None,
            reset_label: None,
        };
        let snap = snapshot_from_row(row, &now_fixture());
        // 5% remaining → Critical.
        assert_eq!(snap.remaining_percent, Some(5.0));
        assert_eq!(snap.status, SnapshotStatus::Critical);
        assert_eq!(snap.provider_id, "webview-chatgpt-codex:weekly");
    }

    #[test]
    fn snapshot_from_row_clamps_out_of_range_percent() {
        let row = ExtractedRow {
            window_kind: Some("five-hours".into()),
            percent_used: Some(150.0),
            reset_at: None,
            reset_label: None,
        };
        let snap = snapshot_from_row(row, &now_fixture());
        // 150 used clamps to 100 → 0 remaining → Critical.
        assert_eq!(snap.remaining_percent, Some(0.0));
        assert_eq!(snap.status, SnapshotStatus::Critical);
    }

    #[test]
    fn snapshot_from_row_defaults_missing_percent_to_full_remaining() {
        let row = ExtractedRow {
            window_kind: None,
            percent_used: None,
            reset_at: None,
            reset_label: None,
        };
        let snap = snapshot_from_row(row, &now_fixture());
        assert_eq!(snap.provider_id, "webview-chatgpt-codex:unknown");
        assert_eq!(snap.account_label, "Codex");
        assert_eq!(snap.remaining_percent, Some(100.0));
        assert_eq!(snap.status, SnapshotStatus::Ok);
        assert!(snap.message.is_none());
    }

    #[test]
    fn snapshot_from_row_handles_unknown_window_kind() {
        let row = ExtractedRow {
            window_kind: None,
            percent_used: Some(10.0),
            reset_at: None,
            reset_label: None,
        };
        let snap = snapshot_from_row(row, &now_fixture());
        assert_eq!(snap.window, UsageWindow::Unknown);
        assert_eq!(snap.provider_id, "webview-chatgpt-codex:unknown");
        assert_eq!(snap.account_label, "Codex");
    }

    #[test]
    fn payload_logged_out_becomes_no_data() {
        let snap = snapshot_from_payload_error(ScraperErrorKind::LoggedOut, None, &now_fixture());
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::WebviewScrape);
        assert_eq!(snap.provider_kind, ProviderKind::WebviewChatgptCodex);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or("")
            .contains("session expired"));
    }

    #[test]
    fn payload_cloudflare_challenge_becomes_error() {
        let snap = snapshot_from_payload_error(
            ScraperErrorKind::CloudflareChallenge,
            None,
            &now_fixture(),
        );
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert!(snap.message.as_deref().unwrap_or("").contains("Cloudflare"));
    }

    #[test]
    fn payload_no_rows_becomes_error_with_default_message() {
        let snap = snapshot_from_payload_error(ScraperErrorKind::NoRows, None, &now_fixture());
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or("")
            .contains("no parseable rows"));
    }

    #[test]
    fn payload_no_rows_final_uses_message_when_present() {
        let snap = snapshot_from_payload_error(
            ScraperErrorKind::NoRowsFinal,
            Some("layout drifted".into()),
            &now_fixture(),
        );
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert_eq!(snap.message.as_deref(), Some("layout drifted"));
    }

    #[test]
    fn payload_unknown_kind_becomes_error() {
        let snap = snapshot_from_payload_error(
            ScraperErrorKind::Unknown,
            Some("unexpected".into()),
            &now_fixture(),
        );
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert_eq!(snap.message.as_deref(), Some("unexpected"));
    }

    #[test]
    fn snapshots_from_payload_handles_empty_rows() {
        let snaps = CodexWebProvider::snapshots_from_payload(
            ScraperPayload::Ok {
                rows: serde_json::json!([]),
                generation: None,
            },
            &now_fixture(),
        );
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::NoData);
        assert_eq!(snaps[0].provider_kind, ProviderKind::WebviewChatgptCodex);
    }

    #[test]
    fn snapshots_from_payload_handles_malformed_rows() {
        // `rows` is supposed to be an array of objects; an object should
        // cleanly surface as an error snapshot instead of panicking.
        let snaps = CodexWebProvider::snapshots_from_payload(
            ScraperPayload::Ok {
                rows: serde_json::json!({"oops": true}),
                generation: None,
            },
            &now_fixture(),
        );
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::Error);
    }

    #[test]
    fn snapshots_from_payload_maps_two_window_rows() {
        let snaps = CodexWebProvider::snapshots_from_payload(
            ScraperPayload::Ok {
                rows: serde_json::json!([
                    {
                        "windowKind": "five-hours",
                        "percentUsed": 40.0,
                        "resetAt": null,
                        "resetLabel": "in 2 hours"
                    },
                    {
                        "windowKind": "weekly",
                        "percentUsed": 88.0,
                        "resetAt": null,
                        "resetLabel": "in 3 days"
                    }
                ]),
                generation: None,
            },
            &now_fixture(),
        );
        assert_eq!(snaps.len(), 2);
        assert_eq!(snaps[0].window, UsageWindow::FiveHours);
        assert_eq!(snaps[1].window, UsageWindow::Weekly);
        // 12% remaining → Warning.
        assert_eq!(snaps[1].remaining_percent, Some(12.0));
        assert_eq!(snaps[1].status, SnapshotStatus::Warning);
        assert_eq!(snaps[0].account_label, "Codex 5h");
        assert_eq!(snaps[1].account_label, "Codex weekly");
    }

    #[test]
    fn snapshot_from_scraper_error_blocked_navigation_includes_host() {
        let snap = snapshot_from_scraper_error(
            ScraperError::BlockedNavigation("evil.example.com".into()),
            &now_fixture(),
        );
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or("")
            .contains("evil.example.com"));
        assert_eq!(snap.provider_kind, ProviderKind::WebviewChatgptCodex);
    }

    #[test]
    fn snapshot_from_scraper_error_maps_window_failures() {
        for err in [
            ScraperError::Timeout(Duration::from_secs(5)),
            ScraperError::WindowCreate("webview denied".into()),
            ScraperError::Eval("eval failed".into()),
            ScraperError::Parse("bad json".into()),
        ] {
            let snap = snapshot_from_scraper_error(err, &now_fixture());
            assert_eq!(snap.status, SnapshotStatus::Error);
            assert_eq!(snap.provider_kind, ProviderKind::WebviewChatgptCodex);
            assert!(snap.message.as_deref().unwrap_or("").len() > 4);
        }
    }

    #[tokio::test]
    async fn refresh_returns_empty_when_disabled() {
        let tmp = tempfile::TempDir::new().unwrap();
        let settings = Arc::new(ProviderSettingsStore::load(tmp.path()).unwrap());
        let provider = CodexWebProvider::new(tmp.path().to_path_buf(), Arc::clone(&settings));
        let ctx = ProviderContext::new();
        let snaps = provider.refresh(&ctx).await.unwrap();
        assert!(snaps.is_empty(), "disabled provider must emit no rows");
    }

    #[tokio::test]
    async fn refresh_without_app_handle_returns_no_data() {
        let tmp = tempfile::TempDir::new().unwrap();
        let settings = Arc::new(ProviderSettingsStore::load(tmp.path()).unwrap());
        // Flip the toggle on so the gate doesn't short-circuit.
        settings.set_enabled(CODEX_WEB_PROVIDER_ID, true).unwrap();
        let provider = CodexWebProvider::new(tmp.path().to_path_buf(), Arc::clone(&settings));
        let ctx = ProviderContext::new();
        let snaps = provider.refresh(&ctx).await.unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::NoData);
        assert_eq!(snaps[0].source, UsageSource::WebviewScrape);
        assert_eq!(snaps[0].provider_kind, ProviderKind::WebviewChatgptCodex);
    }

    #[test]
    fn embedded_extractor_js_is_not_empty() {
        assert!(!CODEX_EXTRACTOR_JS.trim().is_empty());
        // Quick sanity check that the file matches the protocol — the
        // prefix must appear textually somewhere, otherwise an extractor
        // refactor that drops the title channel would silently break the
        // scraper.
        assert!(CODEX_EXTRACTOR_JS.contains("QHJSON:"));
        // The four error kinds the Rust side maps must all appear in the
        // extractor, otherwise we'd silently drop one branch.
        assert!(CODEX_EXTRACTOR_JS.contains("cloudflare-challenge"));
        assert!(CODEX_EXTRACTOR_JS.contains("logged-out"));
        assert!(CODEX_EXTRACTOR_JS.contains("no-rows"));
        assert!(CODEX_EXTRACTOR_JS.contains("no-rows-final"));
    }

    #[test]
    fn host_allowlist_permits_expected_hosts() {
        // The provider config exposes the allowlist via `scraper_config()`;
        // we want to be sure the chatgpt.com surface (including known
        // first-party static-asset CDNs) is allowed, but unrelated hosts
        // are not.
        let cfg = CodexWebProvider::scraper_config();
        let list = cfg.host_allowlist;
        assert!(list.permits("chatgpt.com"));
        assert!(list.permits("api.chatgpt.com"));
        assert!(list.permits("ab.chatgpt.com"));
        assert!(list.permits("openai.com"));
        assert!(list.permits("api.openai.com"));
        assert!(list.permits("cdn.oaistatic.com"));
        assert!(list.permits("cdn.openai.com"));
        // Adjacent / unrelated hosts must not be permitted.
        assert!(!list.permits("evil.com"));
        assert!(!list.permits("claude.ai"));
        assert!(!list.permits("notchatgpt.com"));
    }

    #[test]
    fn scraper_config_uses_expected_urls() {
        let cfg = CodexWebProvider::scraper_config();
        assert_eq!(cfg.slug, "webview-chatgpt-codex");
        assert_eq!(
            cfg.target_url,
            "https://chatgpt.com/codex/cloud/settings/analytics"
        );
        assert_eq!(cfg.login_url, "https://chatgpt.com/auth/login");
    }
}
