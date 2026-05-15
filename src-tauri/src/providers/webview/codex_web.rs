//! Codex / ChatGPT (Plus / Pro / Codex agent) WebView usage provider
//! (PROJECT_SPEC §8.7).
//!
//! This provider is **opt-in only**. The scheduler list only includes it
//! when `ProviderSettingsStore` has flipped `webview-chatgpt-codex` to
//! `true`; until then `default_providers` skips it entirely so no network
//! call happens on startup (AGENTS.md "no network on startup" rule).
//!
//! Concretely this file owns:
//!
//! 1. The static configuration for `WebviewScraper` — login URL, scrape
//!    URL, egress allowlist, the JS extractor loaded via `include_str!`.
//! 2. The `UsageProvider` impl that wraps a scrape result into one or two
//!    `UsageSnapshot` rows (5h session + weekly).
//! 3. A pure parser (`snapshots_from_payload`) that turns the JSON the
//!    extractor publishes via `document.title` into snapshots. The parser
//!    is the unit-tested core of the provider — the live WebView path goes
//!    through `WebviewScraper` (currently a stub, see `scraper.rs`).
//!
//! When PR #30 lands its canonical `WebviewScraper` this file only needs a
//! rebase touch in the constructor — every other function is independent of
//! the scraper implementation.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use time::OffsetDateTime;

use crate::model::{
    classify_status, error_snapshot, format_rfc3339, Confidence, ProviderKind, SnapshotStatus,
    UsageMetric, UsageSnapshot, UsageSource, UsageWindow,
};
use crate::providers::webview::scraper::{ScraperError, WebviewScraper, WebviewScraperConfig};
use crate::providers::webview::{ProviderHostAllowlist, SessionStorage};
use crate::providers::{ProviderContext, UsageProvider};

/// Public provider id. Mirrors the `ProviderKind` kebab-case slug so the
/// frontend can match snapshots back to the provider settings toggle.
pub const CODEX_WEB_PROVIDER_ID: &str = "webview-chatgpt-codex";

const CODEX_WEB_DEFAULT_ACCOUNT_LABEL: &str = "Codex (ChatGPT)";

/// Default refresh interval per §8.7: 600 seconds. The spec also pins the
/// floor at 300 seconds — the settings layer enforces that bound; the
/// scheduler reads only this getter and respects whatever it returns.
const CODEX_WEB_MIN_REFRESH_INTERVAL_SECS: u64 = 600;

/// First-party login URL. Redirects to Google / Apple / Microsoft / Okta /
/// Cloudflare / GitHub during SSO are admitted by `KNOWN_IDP_SUFFIXES`
/// (see `webview/mod.rs`).
const CODEX_LOGIN_URL: &str = "https://chatgpt.com/auth/login";

/// Analytics page used by the hidden refresh window.
const CODEX_SCRAPE_URL: &str = "https://chatgpt.com/codex/cloud/settings/analytics";

/// Provider-owned host allowlist (§14). Estimated from the analytics page's
/// behavior — actual verification is part of the manual E2E sweep when the
/// canonical scraper lands. Conservative on purpose: every entry is either
/// a chatgpt.com origin or an OpenAI-owned CDN/API host.
///
/// Patterns:
/// - `chatgpt.com` — top-level page navigation.
/// - `*.chatgpt.com` — Cloudflare-fronted subdomains used by chatgpt.com
///   (e.g. `cdn.chatgpt.com`, `auth.chatgpt.com`).
/// - `*.openai.com` — first-party XHR + auth API (`api.openai.com`,
///   `auth.openai.com`, `auth0.openai.com`).
/// - `cdn.oaistatic.com` — static asset host the analytics page uses.
/// - `cdn.openai.com` — alternative CDN used during transitions.
pub const CODEX_HOST_ALLOWLIST: ProviderHostAllowlist = ProviderHostAllowlist::new(&[
    "chatgpt.com",
    "*.chatgpt.com",
    "*.openai.com",
    "cdn.oaistatic.com",
    "cdn.openai.com",
]);

/// JS extractor loaded from `extractors/codex.js`. Kept as a `'static` slice
/// so the scraper does not allocate per scrape cycle.
const CODEX_EXTRACTOR_JS: &str = include_str!("extractors/codex.js");

/// Build the static `WebviewScraperConfig` for this provider. Public so the
/// canonical scraper in #30 (and any future test that wants to inspect the
/// configuration) can read it without going through the provider object.
pub fn codex_scraper_config() -> WebviewScraperConfig {
    WebviewScraperConfig::new(
        ProviderKind::WebviewChatgptCodex,
        CODEX_LOGIN_URL,
        CODEX_SCRAPE_URL,
        CODEX_EXTRACTOR_JS,
        CODEX_HOST_ALLOWLIST,
    )
}

/// Provider object held by the scheduler.
///
/// The scraper is lazily-constructible: a `tauri::AppHandle` is required to
/// build it, which we only have once `setup()` runs. Tests build the
/// provider without a handle and exercise `snapshots_from_payload` directly.
pub struct CodexWebProvider {
    // Boxed behind `Arc<Option<...>>` so multiple scheduler ticks share one
    // scraper instance once it's created. `None` means the provider is in
    // its pure parsing form (used by tests and by the bootstrap path before
    // the canonical scraper exists).
    scraper: Arc<Option<WebviewScraper>>,
}

impl CodexWebProvider {
    /// Construct a provider with no live scraper. The `refresh` path will
    /// emit an explanatory `NoData` snapshot until [`Self::with_scraper`]
    /// is wired up by the canonical PR #30.
    pub fn new() -> Self {
        Self {
            scraper: Arc::new(None),
        }
    }

    /// Wire the provider against a constructed scraper. Used by the
    /// bootstrap path once PR #30 lands and `WebviewScraper::new` becomes
    /// real. Currently the stub scraper returns `NotImplemented` on every
    /// call, which the refresh path translates into a clear `Error`
    /// snapshot — never a panic.
    #[allow(dead_code)] // exercised once #30 lands
    pub fn with_scraper(scraper: WebviewScraper) -> Self {
        Self {
            scraper: Arc::new(Some(scraper)),
        }
    }

    /// Build a scraper for the host app. Currently a thin wrapper around
    /// `WebviewScraper::new` — once #30 lands the call signature here stays
    /// stable, only the underlying behavior changes.
    #[allow(dead_code)] // exercised once #30 lands
    pub fn build_scraper(app: tauri::AppHandle, session: SessionStorage) -> WebviewScraper {
        WebviewScraper::new(app, codex_scraper_config(), session)
    }
}

impl Default for CodexWebProvider {
    fn default() -> Self {
        Self::new()
    }
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
        Duration::from_secs(CODEX_WEB_MIN_REFRESH_INTERVAL_SECS)
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let now = ctx.clock.now();
        let scraper = match self.scraper.as_ref() {
            Some(s) => s,
            None => {
                // No scraper installed yet — this is the state between
                // #31 landing and #30 wiring up the canonical scraper. The
                // overlay must still show the row, so we surface a clear
                // `NoData` message instead of an `Error`.
                return Ok(vec![webview_nodata_snapshot(
                    &now,
                    "WebView scraper not yet wired up (waiting on PR #30)",
                )]);
            }
        };

        match scraper.refresh().await {
            Ok(value) => Ok(snapshots_from_payload(
                &value,
                &now,
                ctx.warn_pct,
                ctx.critical_pct,
            )),
            Err(ScraperError::LoginRequired) => Ok(vec![webview_nodata_snapshot(
                &now,
                "ログインが必要です — Settings からログインを再実行してください",
            )]),
            Err(err) => Ok(vec![error_snapshot(
                CODEX_WEB_PROVIDER_ID,
                ProviderKind::WebviewChatgptCodex,
                &now,
                err.to_string(),
            )]),
        }
    }
}

/// Build a `NoData` snapshot tagged with `UsageSource::WebviewScrape`.
///
/// The shared `model::nodata_snapshot` helper hard-codes `LocalLog` because
/// every existing caller is a local-CLI provider. WebView providers must
/// always emit `WebviewScrape` (§8.7) so the UI's source badge stays
/// truthful even on "no data" rows.
fn webview_nodata_snapshot(now: &OffsetDateTime, message: impl Into<String>) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: CODEX_WEB_PROVIDER_ID.to_string(),
        provider_kind: ProviderKind::WebviewChatgptCodex,
        account_label: CODEX_WEB_DEFAULT_ACCOUNT_LABEL.to_string(),
        window: UsageWindow::Unknown,
        metric: UsageMetric::Unknown,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at: format_rfc3339(now),
        source: UsageSource::WebviewScrape,
        confidence: Confidence::Low,
        status: SnapshotStatus::NoData,
        message: Some(message.into()),
    }
}

/// Shape of the JSON the extractor publishes via `document.title`. Kept in
/// sync with `extractors/codex.js`; any field renamed there must update
/// this struct too.
///
/// The discriminator (`status`) uses kebab-case to match the JS side (`ok` /
/// `cloudflare` / `logged-out` / `layout-changed`); inner fields use
/// camelCase (`sessionPercent`, `weeklyPercent`, `resetText`).
#[derive(Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ExtractorPayload {
    Ok {
        session_percent: Option<f64>,
        weekly_percent: Option<f64>,
        reset_text: Option<String>,
        #[serde(default)]
        models: Vec<String>,
    },
    Cloudflare,
    LoggedOut,
    LayoutChanged {
        #[serde(default)]
        message: Option<String>,
    },
}

/// Pure parser exposed for unit tests. Translates the JSON the extractor
/// produces into the `UsageSnapshot` list the scheduler stores. All status
/// classification, account labelling and error-string assembly happens
/// here so the live scraper path stays a thin shell.
pub fn snapshots_from_payload(
    payload: &serde_json::Value,
    now: &OffsetDateTime,
    warn_pct: f64,
    crit_pct: f64,
) -> Vec<UsageSnapshot> {
    let parsed: ExtractorPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(err) => {
            return vec![error_snapshot(
                CODEX_WEB_PROVIDER_ID,
                ProviderKind::WebviewChatgptCodex,
                now,
                format!("extractor payload parse error: {err}"),
            )];
        }
    };

    match parsed {
        ExtractorPayload::Cloudflare => vec![error_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            now,
            "Cloudflare の人間確認が要求されました",
        )],
        ExtractorPayload::LoggedOut => vec![webview_nodata_snapshot(
            now,
            "未ログイン — Settings からログインしてください",
        )],
        ExtractorPayload::LayoutChanged { message } => vec![error_snapshot(
            CODEX_WEB_PROVIDER_ID,
            ProviderKind::WebviewChatgptCodex,
            now,
            message.unwrap_or_else(|| {
                "chatgpt.com の解析に失敗しました (layout may have changed)".to_string()
            }),
        )],
        ExtractorPayload::Ok {
            session_percent,
            weekly_percent,
            reset_text,
            models,
        } => build_ok_snapshots(
            session_percent,
            weekly_percent,
            reset_text,
            &models,
            now,
            warn_pct,
            crit_pct,
        ),
    }
}

fn build_ok_snapshots(
    session_percent: Option<f64>,
    weekly_percent: Option<f64>,
    reset_text: Option<String>,
    models: &[String],
    now: &OffsetDateTime,
    warn_pct: f64,
    crit_pct: f64,
) -> Vec<UsageSnapshot> {
    let account_label = build_account_label(models);
    let observed_at = format_rfc3339(now);

    let mut out = Vec::with_capacity(2);
    if let Some(snap) = build_window_snapshot(
        session_percent,
        UsageWindow::FiveHours,
        "session",
        &account_label,
        &observed_at,
        reset_text.as_deref(),
        warn_pct,
        crit_pct,
    ) {
        out.push(snap);
    }
    if let Some(snap) = build_window_snapshot(
        weekly_percent,
        UsageWindow::Weekly,
        "weekly",
        &account_label,
        &observed_at,
        reset_text.as_deref(),
        warn_pct,
        crit_pct,
    ) {
        out.push(snap);
    }
    out
}

/// Combine the labels the extractor surfaced into a single string.
/// Defensive against zero / duplicate inputs.
fn build_account_label(models: &[String]) -> String {
    if models.is_empty() {
        return CODEX_WEB_DEFAULT_ACCOUNT_LABEL.to_string();
    }
    // Preserve insertion order; deduplicate case-insensitively because the
    // JS side already does the case-insensitive dedup but a stray external
    // change to the page could re-introduce duplicates.
    let mut seen: Vec<String> = Vec::with_capacity(models.len());
    for m in models {
        let trimmed = m.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if !seen
            .iter()
            .any(|existing| existing.to_ascii_lowercase() == key)
        {
            seen.push(trimmed.to_string());
        }
    }
    if seen.is_empty() {
        return CODEX_WEB_DEFAULT_ACCOUNT_LABEL.to_string();
    }
    format!("{} · {}", CODEX_WEB_DEFAULT_ACCOUNT_LABEL, seen.join(", "))
}

#[allow(clippy::too_many_arguments)]
fn build_window_snapshot(
    remaining_percent: Option<f64>,
    window: UsageWindow,
    window_slug: &str,
    account_label: &str,
    observed_at: &str,
    reset_text: Option<&str>,
    warn_pct: f64,
    crit_pct: f64,
) -> Option<UsageSnapshot> {
    let pct = remaining_percent?;
    // Clamp defensively — the JS already enforces 0..=100 but we have to
    // assume an unstable interface.
    let pct = pct.clamp(0.0, 100.0);
    let status = classify_status(None, None, Some(pct), warn_pct, crit_pct);
    Some(UsageSnapshot {
        provider_id: format!("{CODEX_WEB_PROVIDER_ID}:{window_slug}"),
        provider_kind: ProviderKind::WebviewChatgptCodex,
        account_label: account_label.to_string(),
        window,
        metric: UsageMetric::Percent,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: Some(pct),
        reset_at: reset_text.map(|s| s.to_string()),
        observed_at: observed_at.to_string(),
        source: UsageSource::WebviewScrape,
        // §8.7 hard rule: WebView-scraped rows are always low confidence.
        confidence: Confidence::Low,
        status: match status {
            SnapshotStatus::NoData => SnapshotStatus::NoData,
            other => other,
        },
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn now_fixture() -> OffsetDateTime {
        datetime!(2026-05-15 12:00:00 UTC)
    }

    fn parse(value: serde_json::Value) -> Vec<UsageSnapshot> {
        snapshots_from_payload(&value, &now_fixture(), 30.0, 10.0)
    }

    #[test]
    fn id_and_kind_match_spec_slug() {
        let provider = CodexWebProvider::new();
        assert_eq!(provider.id(), "webview-chatgpt-codex");
        assert_eq!(provider.kind(), ProviderKind::WebviewChatgptCodex);
    }

    #[test]
    fn min_refresh_interval_is_600s_per_spec() {
        let provider = CodexWebProvider::new();
        assert_eq!(
            provider.min_refresh_interval(),
            Duration::from_secs(600),
            "PROJECT_SPEC §8.7 default is 600 s; floor is enforced at the settings boundary"
        );
    }

    #[test]
    fn host_allowlist_permits_chatgpt_origins() {
        assert!(CODEX_HOST_ALLOWLIST.permits("chatgpt.com"));
        assert!(CODEX_HOST_ALLOWLIST.permits("auth.chatgpt.com"));
        assert!(CODEX_HOST_ALLOWLIST.permits("api.openai.com"));
        assert!(CODEX_HOST_ALLOWLIST.permits("auth0.openai.com"));
        assert!(CODEX_HOST_ALLOWLIST.permits("cdn.oaistatic.com"));
        assert!(CODEX_HOST_ALLOWLIST.permits("cdn.openai.com"));
        assert!(!CODEX_HOST_ALLOWLIST.permits("example.com"));
        assert!(!CODEX_HOST_ALLOWLIST.permits("anthropic.com"));
    }

    #[test]
    fn scraper_config_uses_static_strings_and_kind() {
        let cfg = codex_scraper_config();
        assert_eq!(cfg.provider_kind, ProviderKind::WebviewChatgptCodex);
        assert_eq!(cfg.login_url, "https://chatgpt.com/auth/login");
        assert_eq!(
            cfg.scrape_url,
            "https://chatgpt.com/codex/cloud/settings/analytics"
        );
        // The extractor JS is non-empty: a regression here means
        // `include_str!` silently broke.
        assert!(cfg.extractor_js.contains("QHJSON:"));
    }

    #[test]
    fn parse_ok_yields_session_and_weekly_snapshots() {
        let snaps = parse(serde_json::json!({
            "status": "ok",
            "sessionPercent": 42.0,
            "weeklyPercent": 18.0,
            "resetText": "Resets in 2h 30m",
            "models": ["GPT-5-Codex", "o3"],
        }));
        assert_eq!(snaps.len(), 2);

        let session = snaps
            .iter()
            .find(|s| s.window == UsageWindow::FiveHours)
            .expect("session snapshot present");
        assert_eq!(session.provider_kind, ProviderKind::WebviewChatgptCodex);
        assert_eq!(session.source, UsageSource::WebviewScrape);
        assert_eq!(session.confidence, Confidence::Low);
        assert_eq!(session.metric, UsageMetric::Percent);
        assert_eq!(session.remaining_percent, Some(42.0));
        assert_eq!(session.status, SnapshotStatus::Ok);
        assert_eq!(session.account_label, "Codex (ChatGPT) · GPT-5-Codex, o3");
        assert_eq!(session.reset_at.as_deref(), Some("Resets in 2h 30m"));
        assert_eq!(session.provider_id, "webview-chatgpt-codex:session");

        let weekly = snaps
            .iter()
            .find(|s| s.window == UsageWindow::Weekly)
            .expect("weekly snapshot present");
        assert_eq!(weekly.remaining_percent, Some(18.0));
        // 18% is below the 30% warn threshold → warning.
        assert_eq!(weekly.status, SnapshotStatus::Warning);
        assert_eq!(weekly.provider_id, "webview-chatgpt-codex:weekly");
    }

    #[test]
    fn parse_ok_omits_window_when_percent_missing() {
        // Only weekly present; session must NOT appear in the output (vs.
        // appearing as a noisy NoData row — the overlay can already render
        // a missing row from the absence of a snapshot).
        let snaps = parse(serde_json::json!({
            "status": "ok",
            "weeklyPercent": 8.5,
            "models": [],
        }));
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].window, UsageWindow::Weekly);
        // 8.5 < 10 critical threshold.
        assert_eq!(snaps[0].status, SnapshotStatus::Critical);
        // No model labels → default account label.
        assert_eq!(snaps[0].account_label, "Codex (ChatGPT)");
    }

    #[test]
    fn parse_ok_clamps_out_of_range_percent() {
        let snaps = parse(serde_json::json!({
            "status": "ok",
            "sessionPercent": 142.0,
            "weeklyPercent": -7.0,
        }));
        assert_eq!(snaps.len(), 2);
        let session = snaps
            .iter()
            .find(|s| s.window == UsageWindow::FiveHours)
            .unwrap();
        assert_eq!(session.remaining_percent, Some(100.0));
        let weekly = snaps
            .iter()
            .find(|s| s.window == UsageWindow::Weekly)
            .unwrap();
        assert_eq!(weekly.remaining_percent, Some(0.0));
        assert_eq!(weekly.status, SnapshotStatus::Critical);
    }

    #[test]
    fn parse_cloudflare_emits_single_error_snapshot() {
        let snaps = parse(serde_json::json!({ "status": "cloudflare" }));
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert_eq!(snap.source, UsageSource::Unavailable);
        let msg = snap.message.as_deref().unwrap_or("");
        assert!(msg.contains("Cloudflare"), "message was: {msg}");
    }

    #[test]
    fn parse_logged_out_emits_no_data_with_relogin_hint() {
        let snaps = parse(serde_json::json!({ "status": "logged-out" }));
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        // §8.7 — even no-data rows from a WebView provider must carry the
        // `WebviewScrape` badge so the source filter in the overlay stays
        // truthful.
        assert_eq!(snap.source, UsageSource::WebviewScrape);
        let msg = snap.message.as_deref().unwrap_or("");
        assert!(msg.contains("ログイン"), "message was: {msg}");
    }

    #[test]
    fn parse_layout_changed_emits_error_with_message() {
        let snaps = parse(serde_json::json!({
            "status": "layout-changed",
            "message": "layout may have changed",
        }));
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::Error);
        assert_eq!(snap.message.as_deref(), Some("layout may have changed"));
    }

    #[test]
    fn parse_layout_changed_uses_default_message_when_absent() {
        let snaps = parse(serde_json::json!({ "status": "layout-changed" }));
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::Error);
        let msg = snap.message.as_deref().unwrap_or("");
        assert!(msg.contains("layout"), "message was: {msg}");
    }

    #[test]
    fn parse_unknown_status_falls_through_to_error() {
        // Defence in depth: a future extractor revision may add a status we
        // don't yet know. We expect a single Error snapshot rather than a
        // panic.
        let snaps = parse(serde_json::json!({ "status": "wat" }));
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::Error);
    }

    #[test]
    fn parse_garbage_payload_falls_through_to_error() {
        // A non-object payload (e.g. an unexpected `null` from the title
        // poller) must still produce a clean Error row.
        let snaps = parse(serde_json::json!(null));
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::Error);
    }

    #[test]
    fn account_label_dedups_case_insensitively() {
        // The JS side already dedups, but the parser tolerates duplicate
        // entries arriving from a future regression. Order is preserved.
        let label = build_account_label(&[
            "GPT-5".to_string(),
            "gpt-5".to_string(),
            "  ".to_string(),
            "GPT-5-Codex".to_string(),
        ]);
        assert_eq!(label, "Codex (ChatGPT) · GPT-5, GPT-5-Codex");
    }

    #[test]
    fn account_label_falls_back_when_only_blank_models() {
        let label = build_account_label(&["".to_string(), "   ".to_string()]);
        assert_eq!(label, "Codex (ChatGPT)");
    }

    #[tokio::test]
    async fn refresh_without_scraper_emits_nodata_row() {
        // Pre-#30 state: provider exists but no scraper is wired. We must
        // still produce one row so the overlay shows the provider.
        let provider = CodexWebProvider::new();
        let storage = Arc::new(crate::storage::Storage::open_in_memory().unwrap());
        let ctx = ProviderContext::new(storage);
        let snaps = provider.refresh(&ctx).await.unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].status, SnapshotStatus::NoData);
        assert_eq!(snaps[0].provider_kind, ProviderKind::WebviewChatgptCodex);
    }
}
