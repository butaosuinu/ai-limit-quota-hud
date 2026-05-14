//! Anthropic API response-header provider (spec §8.3).
//!
//! Parses `anthropic-ratelimit-*` headers from a previously observed snapshot
//! and emits one `UsageSnapshot` per metric family (requests / tokens /
//! input-tokens / output-tokens). Never makes a live HTTP call — the cache is
//! only populated by an in-process `record(...)` hook for now; the import
//! pipeline (Tauri command + storage table) is a later phase.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use time::OffsetDateTime;

use crate::model::{
    classify_status, compute_remaining_percent, format_rfc3339, Confidence, ProviderKind,
    SnapshotStatus, UsageMetric, UsageSnapshot, UsageSource, UsageWindow,
};
use crate::providers::{ProviderContext, UsageProvider};

pub const ANTHROPIC_API_PROVIDER_ID: &str = "anthropic-api";

/// The four header families spec §8.3 calls out, paired with the slug that
/// appears between `anthropic-ratelimit-` and `-{limit,remaining,reset}`.
const FAMILIES: &[(UsageMetric, &str)] = &[
    (UsageMetric::Requests, "requests"),
    (UsageMetric::Tokens, "tokens"),
    (UsageMetric::InputTokens, "input-tokens"),
    (UsageMetric::OutputTokens, "output-tokens"),
];

/// A previously observed set of Anthropic response headers, tagged with the
/// account it belongs to and when the response was captured.
#[derive(Debug, Clone)]
pub struct ObservedHeaders {
    pub account_label: String,
    pub observed_at: OffsetDateTime,
    pub headers: HashMap<String, String>,
}

pub struct AnthropicApiProvider {
    cache: Arc<RwLock<Option<ObservedHeaders>>>,
}

impl AnthropicApiProvider {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// Replace the cached observation. Tests use this directly; the runtime
    /// import pipeline will call it once the Phase 3c command/storage lands.
    #[allow(dead_code)]
    pub fn record(&self, observed: ObservedHeaders) {
        *self.cache.write().expect("anthropic header cache poisoned") = Some(observed);
    }
}

impl Default for AnthropicApiProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl UsageProvider for AnthropicApiProvider {
    fn id(&self) -> &'static str {
        ANTHROPIC_API_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::AnthropicApi
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        // No observed headers yet → produce nothing. Keeps the overlay clean
        // on first launch and enforces the "no startup probe" rule: this
        // provider never reaches the network on its own.
        let observed = {
            let guard = self.cache.read().expect("anthropic header cache poisoned");
            guard.clone()
        };
        let Some(observed) = observed else {
            return Ok(vec![]);
        };
        Ok(parse_anthropic_headers(
            &observed,
            ctx.warn_pct,
            ctx.critical_pct,
        ))
    }
}

/// Parse an observed header snapshot into one `UsageSnapshot` per family.
/// A family with none of its three headers present is returned as a `NoData`
/// row so the UI can render "Anthropic — input tokens — no data" instead of
/// silently dropping the family.
pub fn parse_anthropic_headers(
    observed: &ObservedHeaders,
    warn_pct: f64,
    crit_pct: f64,
) -> Vec<UsageSnapshot> {
    FAMILIES
        .iter()
        .map(|(metric, slug)| build_family_snapshot(observed, *metric, slug, warn_pct, crit_pct))
        .collect()
}

fn build_family_snapshot(
    observed: &ObservedHeaders,
    metric: UsageMetric,
    slug: &str,
    warn_pct: f64,
    crit_pct: f64,
) -> UsageSnapshot {
    let limit_key = format!("anthropic-ratelimit-{slug}-limit");
    let remaining_key = format!("anthropic-ratelimit-{slug}-remaining");
    let reset_key = format!("anthropic-ratelimit-{slug}-reset");

    let limit = observed
        .headers
        .get(&limit_key)
        .and_then(|s| s.trim().parse::<i64>().ok());
    let remaining = observed
        .headers
        .get(&remaining_key)
        .and_then(|s| s.trim().parse::<i64>().ok());
    let reset_at = observed
        .headers
        .get(&reset_key)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let provider_id = format!(
        "{ANTHROPIC_API_PROVIDER_ID}:{}:{slug}",
        observed.account_label
    );
    let observed_at = format_rfc3339(&observed.observed_at);
    let family_present = limit.is_some() || remaining.is_some() || reset_at.is_some();

    if !family_present {
        return UsageSnapshot {
            provider_id,
            provider_kind: ProviderKind::AnthropicApi,
            account_label: observed.account_label.clone(),
            window: UsageWindow::Api,
            metric,
            limit: None,
            used: None,
            remaining: None,
            remaining_percent: None,
            reset_at: None,
            observed_at,
            source: UsageSource::ResponseHeader,
            confidence: Confidence::High,
            status: SnapshotStatus::NoData,
            message: Some(format!(
                "anthropic-ratelimit-{slug}-* headers not present in observed snapshot"
            )),
        };
    }

    let remaining_percent = compute_remaining_percent(limit, remaining, None);
    let status = classify_status(limit, remaining, remaining_percent, warn_pct, crit_pct);

    UsageSnapshot {
        provider_id,
        provider_kind: ProviderKind::AnthropicApi,
        account_label: observed.account_label.clone(),
        window: UsageWindow::Api,
        metric,
        limit,
        // Anthropic only sends limit + remaining; we leave `used` empty rather
        // than back-computing limit-remaining so the snapshot mirrors the wire
        // truth and the UI can distinguish "header didn't say" from "we did
        // the math."
        used: None,
        remaining,
        remaining_percent,
        reset_at,
        observed_at,
        source: UsageSource::ResponseHeader,
        confidence: Confidence::High,
        status,
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use time::macros::datetime;

    use super::*;
    use crate::model::{
        Confidence, ProviderKind, SnapshotStatus, UsageMetric, UsageSource, UsageWindow,
        DEFAULT_CRITICAL_PCT, DEFAULT_WARN_PCT,
    };
    use crate::providers::{ProviderContext, UsageProvider, DEFAULT_REFRESH_INTERVAL_SECS};
    use crate::storage::Storage;

    fn fixture_path(name: &str) -> PathBuf {
        // CARGO_MANIFEST_DIR points at src-tauri/; fixtures live at repo root.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("anthropic-api")
            .join(name)
    }

    fn load_fixture(name: &str) -> HashMap<String, String> {
        let raw = std::fs::read_to_string(fixture_path(name))
            .unwrap_or_else(|e| panic!("failed to read fixture {name}: {e}"));
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse fixture {name}: {e}"))
    }

    fn observed_at_fixture() -> OffsetDateTime {
        datetime!(2026-05-14 17:30:00 UTC)
    }

    fn observed_from_fixture(name: &str) -> ObservedHeaders {
        ObservedHeaders {
            account_label: "team-anthropic".to_string(),
            observed_at: observed_at_fixture(),
            headers: load_fixture(name),
        }
    }

    fn ctx() -> ProviderContext {
        // Storage is unused by this provider but ProviderContext requires it.
        let storage = Arc::new(Storage::open_in_memory().expect("in-memory storage"));
        ProviderContext::new(storage)
    }

    fn snap_for(snapshots: &[UsageSnapshot], metric: UsageMetric) -> &UsageSnapshot {
        snapshots
            .iter()
            .find(|s| s.metric == metric)
            .unwrap_or_else(|| panic!("missing snapshot for {metric:?}"))
    }

    #[test]
    fn parse_complete_emits_four_ok_snapshots() {
        let observed = observed_from_fixture("headers-complete.json");
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        assert_eq!(snapshots.len(), 4);
        for snap in &snapshots {
            assert_eq!(snap.provider_kind, ProviderKind::AnthropicApi);
            assert_eq!(snap.account_label, "team-anthropic");
            assert_eq!(snap.window, UsageWindow::Api);
            assert_eq!(snap.source, UsageSource::ResponseHeader);
            assert_eq!(snap.confidence, Confidence::High);
            assert_eq!(snap.status, SnapshotStatus::Ok);
            assert!(snap.message.is_none());
        }

        let requests = snap_for(&snapshots, UsageMetric::Requests);
        assert_eq!(requests.limit, Some(50));
        assert_eq!(requests.remaining, Some(47));
        assert_eq!(requests.reset_at.as_deref(), Some("2026-05-14T18:00:00Z"));
        assert_eq!(
            requests.provider_id,
            "anthropic-api:team-anthropic:requests"
        );

        let tokens = snap_for(&snapshots, UsageMetric::Tokens);
        assert_eq!(tokens.limit, Some(40_000));
        assert_eq!(tokens.remaining, Some(32_000));

        let input_tokens = snap_for(&snapshots, UsageMetric::InputTokens);
        assert_eq!(input_tokens.limit, Some(20_000));
        assert_eq!(input_tokens.remaining, Some(12_000));

        let output_tokens = snap_for(&snapshots, UsageMetric::OutputTokens);
        assert_eq!(output_tokens.limit, Some(8_000));
        assert_eq!(output_tokens.remaining, Some(6_000));
    }

    #[test]
    fn parse_partial_marks_missing_families_as_no_data() {
        let observed = observed_from_fixture("headers-partial.json");
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        assert_eq!(snapshots.len(), 4);

        let requests = snap_for(&snapshots, UsageMetric::Requests);
        assert_eq!(requests.status, SnapshotStatus::Ok);
        assert_eq!(requests.limit, Some(50));
        assert_eq!(requests.remaining, Some(30));

        let tokens = snap_for(&snapshots, UsageMetric::Tokens);
        assert_eq!(tokens.status, SnapshotStatus::Ok);
        assert_eq!(tokens.limit, Some(40_000));

        for metric in [UsageMetric::InputTokens, UsageMetric::OutputTokens] {
            let snap = snap_for(&snapshots, metric);
            assert_eq!(snap.status, SnapshotStatus::NoData);
            assert!(snap.limit.is_none());
            assert!(snap.remaining.is_none());
            assert!(snap.reset_at.is_none());
            // Source/confidence stay attached so the row still carries the
            // spec-mandated provenance metadata.
            assert_eq!(snap.source, UsageSource::ResponseHeader);
            assert_eq!(snap.confidence, Confidence::High);
            let msg = snap.message.as_deref().expect("NoData carries message");
            assert!(msg.contains("not present"), "message was: {msg}");
        }
    }

    fn observed_with(headers: &[(&str, &str)]) -> ObservedHeaders {
        ObservedHeaders {
            account_label: "primary".to_string(),
            observed_at: observed_at_fixture(),
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        }
    }

    #[test]
    fn parse_requests_family_only() {
        let observed = observed_with(&[
            ("anthropic-ratelimit-requests-limit", "100"),
            ("anthropic-ratelimit-requests-remaining", "80"),
            ("anthropic-ratelimit-requests-reset", "2026-05-14T19:00:00Z"),
        ]);
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        let requests = snap_for(&snapshots, UsageMetric::Requests);
        assert_eq!(requests.limit, Some(100));
        assert_eq!(requests.remaining, Some(80));
        assert_eq!(requests.status, SnapshotStatus::Ok);
        for metric in [
            UsageMetric::Tokens,
            UsageMetric::InputTokens,
            UsageMetric::OutputTokens,
        ] {
            assert_eq!(snap_for(&snapshots, metric).status, SnapshotStatus::NoData);
        }
    }

    #[test]
    fn parse_tokens_family_only() {
        let observed = observed_with(&[
            ("anthropic-ratelimit-tokens-limit", "10000"),
            ("anthropic-ratelimit-tokens-remaining", "2500"),
        ]);
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        let tokens = snap_for(&snapshots, UsageMetric::Tokens);
        // 2500/10000 = 25% → warning band (< 30, >= 10).
        assert_eq!(tokens.status, SnapshotStatus::Warning);
        assert!(tokens.reset_at.is_none());
    }

    #[test]
    fn parse_input_tokens_family_only() {
        let observed = observed_with(&[
            ("anthropic-ratelimit-input-tokens-limit", "1000"),
            ("anthropic-ratelimit-input-tokens-remaining", "50"),
        ]);
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        let input = snap_for(&snapshots, UsageMetric::InputTokens);
        assert_eq!(input.status, SnapshotStatus::Critical);
        assert_eq!(input.remaining, Some(50));
    }

    #[test]
    fn parse_output_tokens_family_only() {
        let observed = observed_with(&[
            ("anthropic-ratelimit-output-tokens-limit", "2000"),
            ("anthropic-ratelimit-output-tokens-remaining", "2000"),
            (
                "anthropic-ratelimit-output-tokens-reset",
                "2026-05-14T20:00:00Z",
            ),
        ]);
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);

        let output = snap_for(&snapshots, UsageMetric::OutputTokens);
        assert_eq!(output.status, SnapshotStatus::Ok);
        assert_eq!(output.remaining, Some(2000));
        assert_eq!(output.reset_at.as_deref(), Some("2026-05-14T20:00:00Z"));
    }

    #[tokio::test]
    async fn provider_returns_empty_when_cache_unset() {
        let provider = AnthropicApiProvider::new();
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert!(
            snapshots.is_empty(),
            "no observation should yield no rows so the overlay stays clean and startup is probe-free"
        );
    }

    #[tokio::test]
    async fn provider_returns_four_after_record() {
        let provider = AnthropicApiProvider::new();
        provider.record(observed_from_fixture("headers-complete.json"));
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 4);
        for snap in &snapshots {
            assert_eq!(snap.status, SnapshotStatus::Ok);
            assert_eq!(snap.source, UsageSource::ResponseHeader);
        }
    }

    #[test]
    fn non_numeric_limit_falls_through_to_no_data() {
        // limit fails to parse → effectively missing; remaining also missing
        // → no usable data → NoData for the family. reset_at empty too.
        let observed = observed_with(&[
            ("anthropic-ratelimit-requests-limit", "not-a-number"),
            ("anthropic-ratelimit-requests-reset", "   "),
        ]);
        let snapshots = parse_anthropic_headers(&observed, DEFAULT_WARN_PCT, DEFAULT_CRITICAL_PCT);
        let requests = snap_for(&snapshots, UsageMetric::Requests);
        assert_eq!(requests.status, SnapshotStatus::NoData);
        assert!(requests.limit.is_none());
        assert!(requests.reset_at.is_none());
    }

    #[test]
    fn provider_uses_framework_default_min_interval() {
        let provider = AnthropicApiProvider::new();
        assert_eq!(
            provider.min_refresh_interval(),
            Duration::from_secs(DEFAULT_REFRESH_INTERVAL_SECS)
        );
        assert_eq!(provider.id(), ANTHROPIC_API_PROVIDER_ID);
        assert_eq!(provider.kind(), ProviderKind::AnthropicApi);
    }
}
