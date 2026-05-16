//! Core data model for usage snapshots (mirrors `docs/PROJECT_SPEC.md` §7).
//!
//! Every snapshot must carry both `source` (where the number came from) and
//! `confidence` (how trustworthy it is). The frontend mirrors these enums in
//! `src/lib/types.ts` — the kebab-case serde rename here must stay in sync.

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const FALLBACK_TIMESTAMP: &str = "1970-01-01T00:00:00Z";

/// Format an `OffsetDateTime` as an RFC 3339 string, falling back to the epoch
/// when the formatter rejects the value (cannot reasonably happen for
/// `now_utc()` but keeps the call sites infallible).
pub fn format_rfc3339(dt: &OffsetDateTime) -> String {
    dt.format(&Rfc3339)
        .unwrap_or_else(|_| FALLBACK_TIMESTAMP.to_string())
}

#[allow(dead_code)]
pub fn now_rfc3339() -> String {
    format_rfc3339(&OffsetDateTime::now_utc())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    WebviewClaudeAi,
    WebviewChatgptCodex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageMetric {
    Requests,
    Tokens,
    InputTokens,
    OutputTokens,
    Messages,
    Percent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSource {
    Unavailable,
    WebviewScrape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotStatus {
    Ok,
    Warning,
    Critical,
    NoData,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageWindow {
    OneMinute,
    FiveHours,
    Daily,
    Weekly,
    Monthly,
    Api,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider_id: String,
    pub provider_kind: ProviderKind,
    pub account_label: String,
    pub window: UsageWindow,
    pub metric: UsageMetric,
    pub limit: Option<i64>,
    pub used: Option<i64>,
    pub remaining: Option<i64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub observed_at: String,
    pub source: UsageSource,
    pub confidence: Confidence,
    pub status: SnapshotStatus,
    pub message: Option<String>,
}

pub const DEFAULT_WARN_PCT: f64 = 30.0;
pub const DEFAULT_CRITICAL_PCT: f64 = 10.0;

/// Resolve a remaining-percent figure from limit/remaining/explicit fields.
/// Returns `None` when no usable data is present.
#[allow(dead_code)]
pub fn compute_remaining_percent(
    limit: Option<i64>,
    remaining: Option<i64>,
    remaining_percent: Option<f64>,
) -> Option<f64> {
    if let Some(pct) = remaining_percent {
        return Some(pct);
    }
    match (limit, remaining) {
        (Some(l), Some(r)) if l > 0 => {
            #[allow(clippy::cast_precision_loss)]
            Some((r as f64 / l as f64) * 100.0)
        }
        _ => None,
    }
}

/// Pure status classifier (testable). Both `None` for limit and remaining and
/// `None` for the explicit percent collapses to `NoData`. Boundary values use
/// strict `<` against the thresholds (so 30 / 10 are warning / critical
/// respectively when the value is below them).
#[allow(dead_code)]
pub fn classify_status(
    limit: Option<i64>,
    remaining: Option<i64>,
    remaining_percent: Option<f64>,
    warn_pct: f64,
    crit_pct: f64,
) -> SnapshotStatus {
    let pct = compute_remaining_percent(limit, remaining, remaining_percent);
    match pct {
        None => SnapshotStatus::NoData,
        Some(p) if p < crit_pct => SnapshotStatus::Critical,
        Some(p) if p < warn_pct => SnapshotStatus::Warning,
        Some(_) => SnapshotStatus::Ok,
    }
}

/// Build a `NoData` snapshot for a provider that legitimately has nothing to
/// report yet. Used by WebView providers when login is required or no
/// usage data has been observed for the current window.
#[allow(dead_code)]
pub fn no_data_snapshot(
    provider_id: &str,
    provider_kind: ProviderKind,
    account_label: &str,
    source: UsageSource,
    now: &OffsetDateTime,
    message: impl Into<String>,
) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: provider_id.to_string(),
        provider_kind,
        account_label: account_label.to_string(),
        window: UsageWindow::Unknown,
        metric: UsageMetric::Unknown,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at: format_rfc3339(now),
        source,
        confidence: Confidence::Low,
        status: SnapshotStatus::NoData,
        message: Some(message.into()),
    }
}

/// Build a snapshot that represents a provider-level failure without crashing
/// the overlay. The scheduler converts provider errors into this so the UI
/// surfaces a single `Error` row instead of bringing down the whole refresh
/// loop.
pub fn error_snapshot(
    provider_id: &str,
    provider_kind: ProviderKind,
    now: &OffsetDateTime,
    message: impl Into<String>,
) -> UsageSnapshot {
    let observed_at = format_rfc3339(now);
    UsageSnapshot {
        provider_id: provider_id.to_string(),
        provider_kind,
        account_label: provider_id.to_string(),
        window: UsageWindow::Unknown,
        metric: UsageMetric::Unknown,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at,
        source: UsageSource::Unavailable,
        confidence: Confidence::Low,
        status: SnapshotStatus::Error,
        message: Some(message.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn now_fixture() -> OffsetDateTime {
        datetime!(2026-05-13 12:00:00 UTC)
    }

    #[test]
    fn classify_no_data_when_all_none() {
        assert_eq!(
            classify_status(None, None, None, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT),
            SnapshotStatus::NoData
        );
    }

    #[test]
    fn classify_ok_above_warn_threshold() {
        assert_eq!(
            classify_status(Some(100), Some(80), None, 30.0, 10.0),
            SnapshotStatus::Ok
        );
    }

    #[test]
    fn classify_warning_below_warn_above_crit() {
        // 25/100 = 25% → warning (below 30, above 10).
        assert_eq!(
            classify_status(Some(100), Some(25), None, 30.0, 10.0),
            SnapshotStatus::Warning
        );
    }

    #[test]
    fn classify_critical_below_crit() {
        assert_eq!(
            classify_status(Some(100), Some(5), None, 30.0, 10.0),
            SnapshotStatus::Critical
        );
    }

    #[test]
    fn classify_boundary_30_is_ok() {
        // strictly below the threshold means 30.0 itself is still OK.
        assert_eq!(
            classify_status(Some(100), Some(30), None, 30.0, 10.0),
            SnapshotStatus::Ok
        );
    }

    #[test]
    fn classify_boundary_10_is_warning() {
        assert_eq!(
            classify_status(Some(100), Some(10), None, 30.0, 10.0),
            SnapshotStatus::Warning
        );
    }

    #[test]
    fn classify_uses_explicit_percent_when_provided() {
        // Limit + remaining are inconsistent with the explicit percent — the
        // explicit value wins.
        assert_eq!(
            classify_status(Some(100), Some(80), Some(5.0), 30.0, 10.0),
            SnapshotStatus::Critical
        );
    }

    #[test]
    fn classify_zero_limit_falls_back_to_no_data() {
        assert_eq!(
            classify_status(Some(0), Some(0), None, 30.0, 10.0),
            SnapshotStatus::NoData
        );
    }

    #[test]
    fn provider_kind_serde_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ProviderKind::WebviewClaudeAi).unwrap(),
            "\"webview-claude-ai\""
        );
        assert_eq!(
            serde_json::to_string(&ProviderKind::WebviewChatgptCodex).unwrap(),
            "\"webview-chatgpt-codex\""
        );
        assert_eq!(
            serde_json::from_str::<ProviderKind>("\"webview-claude-ai\"").unwrap(),
            ProviderKind::WebviewClaudeAi
        );
    }

    #[test]
    fn usage_metric_serde_kebab_case() {
        assert_eq!(
            serde_json::to_string(&UsageMetric::InputTokens).unwrap(),
            "\"input-tokens\""
        );
        assert_eq!(
            serde_json::to_string(&UsageMetric::OutputTokens).unwrap(),
            "\"output-tokens\""
        );
    }

    #[test]
    fn snapshot_status_serde_kebab_case() {
        assert_eq!(
            serde_json::to_string(&SnapshotStatus::NoData).unwrap(),
            "\"no-data\""
        );
        assert_eq!(
            serde_json::from_str::<SnapshotStatus>("\"critical\"").unwrap(),
            SnapshotStatus::Critical
        );
    }

    #[test]
    fn usage_window_serde_kebab_case() {
        assert_eq!(
            serde_json::to_string(&UsageWindow::OneMinute).unwrap(),
            "\"one-minute\""
        );
        assert_eq!(
            serde_json::to_string(&UsageWindow::FiveHours).unwrap(),
            "\"five-hours\""
        );
    }

    #[test]
    fn confidence_serde_kebab_case() {
        assert_eq!(serde_json::to_string(&Confidence::Low).unwrap(), "\"low\"");
        assert_eq!(serde_json::to_string(&Confidence::High).unwrap(), "\"high\"");
    }

    #[test]
    fn usage_source_serde_kebab_case() {
        assert_eq!(
            serde_json::to_string(&UsageSource::WebviewScrape).unwrap(),
            "\"webview-scrape\""
        );
        assert_eq!(
            serde_json::to_string(&UsageSource::Unavailable).unwrap(),
            "\"unavailable\""
        );
    }

    #[test]
    fn usage_snapshot_serializes_camel_case() {
        let snap = error_snapshot(
            "webview-claude-ai",
            ProviderKind::WebviewClaudeAi,
            &now_fixture(),
            "boom",
        );
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json.get("providerId").is_some());
        assert!(json.get("providerKind").is_some());
        assert!(json.get("accountLabel").is_some());
        assert!(json.get("remainingPercent").is_some());
        assert_eq!(json.get("status").and_then(|v| v.as_str()), Some("error"));
        assert_eq!(json.get("source").and_then(|v| v.as_str()), Some("unavailable"));
    }

    #[test]
    fn no_data_snapshot_carries_provided_source() {
        let snap = no_data_snapshot(
            "webview-claude-ai:default",
            ProviderKind::WebviewClaudeAi,
            "Claude (Pro)",
            UsageSource::WebviewScrape,
            &now_fixture(),
            "login required",
        );
        assert_eq!(snap.provider_kind, ProviderKind::WebviewClaudeAi);
        assert_eq!(snap.source, UsageSource::WebviewScrape);
        assert_eq!(snap.confidence, Confidence::Low);
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.account_label, "Claude (Pro)");
        assert!(snap.limit.is_none());
        assert!(snap.used.is_none());
        assert!(snap.remaining.is_none());
        assert!(snap.remaining_percent.is_none());
        assert_eq!(snap.message.as_deref(), Some("login required"));
    }
}
