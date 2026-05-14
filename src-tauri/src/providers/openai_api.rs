//! OpenAI API response-header provider (spec §8.2).
//!
//! Header lookup is case-insensitive: real-world captures often arrive with
//! mixed case (`X-RateLimit-Limit-Requests`) but OpenAI documents them in
//! lowercase, so callers should not have to normalize before importing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::model::{
    classify_status, compute_remaining_percent, error_snapshot, format_rfc3339, Confidence,
    ProviderKind, SnapshotStatus, UsageMetric, UsageSnapshot, UsageSource, UsageWindow,
};
use crate::providers::{ProviderContext, UsageProvider};

pub const OPENAI_PROVIDER_ID: &str = "openai-api";
const OPENAI_SNAPSHOT_FILE: &str = "observed_headers/openai-api.json";
const DEFAULT_ACCOUNT_LABEL: &str = "OpenAI API";
/// Cap on reset durations parsed from headers. OpenAI rate-limit windows are
/// measured in minutes/hours; anything beyond a year is malformed and would
/// risk panicking `Duration::seconds_f64` / `OffsetDateTime::checked_add`.
const MAX_RESET_SECONDS: f64 = 31_536_000.0;

struct MetricSpec {
    limit_key: &'static str,
    remaining_key: &'static str,
    reset_key: &'static str,
    metric: UsageMetric,
    slug: &'static str,
}

const METRIC_SPECS: &[MetricSpec] = &[
    MetricSpec {
        limit_key: "x-ratelimit-limit-requests",
        remaining_key: "x-ratelimit-remaining-requests",
        reset_key: "x-ratelimit-reset-requests",
        metric: UsageMetric::Requests,
        slug: "requests",
    },
    MetricSpec {
        limit_key: "x-ratelimit-limit-tokens",
        remaining_key: "x-ratelimit-remaining-tokens",
        reset_key: "x-ratelimit-reset-tokens",
        metric: UsageMetric::Tokens,
        slug: "tokens",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedHeaderSnapshot {
    pub account_label: String,
    pub observed_at: String,
    pub headers: HashMap<String, String>,
}

pub fn load_snapshot_from_path(path: &Path) -> anyhow::Result<Option<ObservedHeaderSnapshot>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).context("reading OpenAI header snapshot"),
    };
    let snapshot: ObservedHeaderSnapshot = serde_json::from_slice(&bytes)
        .context("parsing OpenAI header snapshot JSON")?;
    Ok(Some(snapshot))
}

pub fn parse_openai_headers(
    snapshot: &ObservedHeaderSnapshot,
    warn_pct: f64,
    crit_pct: f64,
) -> Vec<UsageSnapshot> {
    let normalized = normalize_headers(&snapshot.headers);
    // A malformed `observed_at` falls back to `now` so a single bad timestamp
    // doesn't collapse the whole snapshot to `Error`.
    let observed_at = OffsetDateTime::parse(&snapshot.observed_at, &Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc());

    let mut out: Vec<UsageSnapshot> = METRIC_SPECS
        .iter()
        .filter_map(|spec| {
            build_metric_snapshot(
                spec,
                &normalized,
                &snapshot.account_label,
                &observed_at,
                warn_pct,
                crit_pct,
            )
        })
        .collect();

    if out.is_empty() {
        out.push(no_data_snapshot(
            &snapshot.account_label,
            &observed_at,
            "no recognised x-ratelimit-* headers in snapshot",
        ));
    }
    out
}

/// Lowercase header keys for case-insensitive lookup. Entries are visited
/// in sorted original-key order so case-variant collisions (e.g. both
/// `x-ratelimit-limit-requests` and `X-RateLimit-Limit-Requests`) resolve
/// deterministically — the lexicographically-last original key wins.
fn normalize_headers(raw: &HashMap<String, String>) -> HashMap<String, String> {
    let mut entries: Vec<(&String, &String)> = raw.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
        .into_iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect()
}

fn build_metric_snapshot(
    spec: &MetricSpec,
    headers: &HashMap<String, String>,
    account_label: &str,
    observed_at: &OffsetDateTime,
    warn_pct: f64,
    crit_pct: f64,
) -> Option<UsageSnapshot> {
    let limit = parse_i64(headers.get(spec.limit_key))?;
    let remaining = parse_i64(headers.get(spec.remaining_key))?;
    // Negative or maliciously crafted values would overflow `limit - remaining`
    // in debug builds and kill the scheduler task; reject them so the snapshot
    // is dropped rather than corrupting the overlay.
    if limit < 0 || remaining < 0 {
        return None;
    }
    let used = limit.saturating_sub(remaining).max(0);
    let remaining_percent = compute_remaining_percent(Some(limit), Some(remaining), None);
    let status = classify_status(
        Some(limit),
        Some(remaining),
        remaining_percent,
        warn_pct,
        crit_pct,
    );
    let (reset_at, message) = match headers.get(spec.reset_key) {
        Some(raw) => match parse_reset_duration(raw) {
            Some(dur) => match observed_at.checked_add(dur) {
                Some(reset_dt) => (Some(format_rfc3339(&reset_dt)), None),
                None => (None, Some(format!("`{}` value out of range", spec.reset_key))),
            },
            None => (None, Some(format!("could not parse `{}` value", spec.reset_key))),
        },
        None => (None, None),
    };
    Some(UsageSnapshot {
        provider_id: format!("{OPENAI_PROVIDER_ID}:{}", spec.slug),
        provider_kind: ProviderKind::OpenAiApi,
        account_label: display_account_label(account_label),
        window: UsageWindow::Api,
        metric: spec.metric,
        limit: Some(limit),
        used: Some(used),
        remaining: Some(remaining),
        remaining_percent,
        reset_at,
        observed_at: format_rfc3339(observed_at),
        source: UsageSource::ResponseHeader,
        confidence: Confidence::High,
        status,
        message,
    })
}

fn display_account_label(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        DEFAULT_ACCOUNT_LABEL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn no_data_snapshot(
    account_label: &str,
    observed_at: &OffsetDateTime,
    message: &str,
) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: OPENAI_PROVIDER_ID.to_string(),
        provider_kind: ProviderKind::OpenAiApi,
        account_label: display_account_label(account_label),
        window: UsageWindow::Api,
        metric: UsageMetric::Unknown,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at: format_rfc3339(observed_at),
        source: UsageSource::ResponseHeader,
        confidence: Confidence::High,
        status: SnapshotStatus::NoData,
        message: Some(message.to_string()),
    }
}

fn parse_i64(value: Option<&String>) -> Option<i64> {
    value?.trim().parse::<i64>().ok()
}

/// Parses Go-style duration strings (`6m0s`, `1.5s`, `10ms`, `1d2h3m4.567s`).
/// Supported units: `d`, `h`, `m`, `s`, `ms`. Strict: the whole input must
/// consume cleanly as one or more `<number><unit>` segments — partial parses
/// (`"1m30"`, `"1s junk"`) return `None` so the caller surfaces a parse
/// warning instead of an incorrect countdown.
pub fn parse_reset_duration(input: &str) -> Option<Duration> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let bytes = input.as_bytes();
    let mut idx = 0;
    let mut total_seconds: f64 = 0.0;

    while idx < bytes.len() {
        let num_start = idx;
        while idx < bytes.len() && (bytes[idx].is_ascii_digit() || bytes[idx] == b'.') {
            idx += 1;
        }
        if num_start == idx {
            return None;
        }
        let number: f64 = std::str::from_utf8(&bytes[num_start..idx])
            .ok()?
            .parse()
            .ok()?;

        let unit_start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_alphabetic() {
            idx += 1;
        }
        if unit_start == idx {
            return None;
        }
        let unit = std::str::from_utf8(&bytes[unit_start..idx]).ok()?;
        let multiplier = match unit {
            "d" => 86_400.0,
            "h" => 3_600.0,
            "m" => 60.0,
            "s" => 1.0,
            "ms" => 0.001,
            _ => return None,
        };
        total_seconds += number * multiplier;
        if !total_seconds.is_finite() || total_seconds < 0.0 || total_seconds > MAX_RESET_SECONDS {
            return None;
        }
    }

    Some(Duration::seconds_f64(total_seconds))
}

pub struct OpenAiApiProvider {
    snapshot_path: PathBuf,
}

impl OpenAiApiProvider {
    pub fn new(snapshot_path: PathBuf) -> Self {
        Self { snapshot_path }
    }

    pub fn default_snapshot_path(data_dir: &Path) -> PathBuf {
        data_dir.join(OPENAI_SNAPSHOT_FILE)
    }
}

#[async_trait]
impl UsageProvider for OpenAiApiProvider {
    fn id(&self) -> &'static str {
        OPENAI_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAiApi
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let path = self.snapshot_path.clone();
        let loaded = tauri::async_runtime::spawn_blocking(move || load_snapshot_from_path(&path))
            .await
            .map_err(|e| anyhow::anyhow!("openai-api provider task join error: {e}"))?;
        let now = ctx.clock.now();
        match loaded {
            Ok(Some(snapshot)) => Ok(parse_openai_headers(&snapshot, ctx.warn_pct, ctx.critical_pct)),
            Ok(None) => Ok(vec![no_data_snapshot(
                DEFAULT_ACCOUNT_LABEL,
                &now,
                "no observed headers — import a snapshot to enable",
            )]),
            Err(err) => Ok(vec![error_snapshot(
                OPENAI_PROVIDER_ID,
                ProviderKind::OpenAiApi,
                &now,
                format!("could not read observed headers: {err}"),
            )]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use std::sync::Arc;
    use tempfile::tempdir;

    const WARN: f64 = 30.0;
    const CRIT: f64 = 10.0;

    fn snapshot_with(headers: &[(&str, &str)], observed_at: &str) -> ObservedHeaderSnapshot {
        ObservedHeaderSnapshot {
            account_label: "personal".into(),
            observed_at: observed_at.into(),
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        }
    }

    #[test]
    fn full_snapshot_emits_requests_and_tokens() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "59"),
                ("x-ratelimit-reset-requests", "1s"),
                ("x-ratelimit-limit-tokens", "150000"),
                ("x-ratelimit-remaining-tokens", "149984"),
                ("x-ratelimit-reset-tokens", "6m0s"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 2);

        let req = out.iter().find(|s| s.metric == UsageMetric::Requests).unwrap();
        assert_eq!(req.provider_kind, ProviderKind::OpenAiApi);
        assert_eq!(req.provider_id, "openai-api:requests");
        assert_eq!(req.source, UsageSource::ResponseHeader);
        assert_eq!(req.confidence, Confidence::High);
        assert_eq!(req.window, UsageWindow::Api);
        assert_eq!(req.limit, Some(60));
        assert_eq!(req.remaining, Some(59));
        assert_eq!(req.used, Some(1));
        assert_eq!(req.status, SnapshotStatus::Ok);
        assert_eq!(req.reset_at.as_deref(), Some("2026-05-13T12:00:01Z"));
        assert_eq!(req.account_label, "personal");

        let tok = out.iter().find(|s| s.metric == UsageMetric::Tokens).unwrap();
        assert_eq!(tok.provider_id, "openai-api:tokens");
        assert_eq!(tok.limit, Some(150_000));
        assert_eq!(tok.remaining, Some(149_984));
        assert_eq!(tok.reset_at.as_deref(), Some("2026-05-13T12:06:00Z"));
        assert_eq!(tok.status, SnapshotStatus::Ok);
    }

    #[test]
    fn only_request_headers_emits_one_snapshot() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "12"),
                ("x-ratelimit-reset-requests", "45s"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, UsageMetric::Requests);
        assert_eq!(out[0].status, SnapshotStatus::Warning);
        assert_eq!(out[0].reset_at.as_deref(), Some("2026-05-13T12:00:45Z"));
    }

    #[test]
    fn only_token_headers_emits_one_snapshot() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-tokens", "1000"),
                ("x-ratelimit-remaining-tokens", "50"),
                ("x-ratelimit-reset-tokens", "10s"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, UsageMetric::Tokens);
        assert_eq!(out[0].status, SnapshotStatus::Critical);
    }

    #[test]
    fn missing_all_returns_no_data() {
        let snap = snapshot_with(&[], "2026-05-13T12:00:00Z");
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::NoData);
        assert_eq!(out[0].metric, UsageMetric::Unknown);
        assert_eq!(out[0].provider_kind, ProviderKind::OpenAiApi);
        assert!(out[0].message.as_deref().unwrap_or("").contains("no recognised"));
    }

    #[test]
    fn keys_are_case_insensitive() {
        let snap = snapshot_with(
            &[
                ("X-RateLimit-Limit-Requests", "60"),
                ("X-RateLimit-Remaining-Requests", "59"),
                ("X-RateLimit-Reset-Requests", "1s"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, UsageMetric::Requests);
        assert_eq!(out[0].remaining, Some(59));
    }

    #[test]
    fn non_numeric_limit_skips_metric() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "abc"),
                ("x-ratelimit-remaining-requests", "10"),
                ("x-ratelimit-limit-tokens", "1000"),
                ("x-ratelimit-remaining-tokens", "950"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, UsageMetric::Tokens);
    }

    #[test]
    fn missing_remaining_skips_metric() {
        let snap = snapshot_with(
            &[("x-ratelimit-limit-requests", "60")],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::NoData);
    }

    #[test]
    fn unparseable_reset_keeps_metric_but_drops_reset_at() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "59"),
                ("x-ratelimit-reset-requests", "garbage"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reset_at, None);
        assert!(out[0].message.as_deref().unwrap_or("").contains("reset-requests"));
        assert_eq!(out[0].status, SnapshotStatus::Ok);
    }

    #[test]
    fn invalid_observed_at_falls_back_to_now() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "59"),
                ("x-ratelimit-reset-requests", "1s"),
            ],
            "not-a-timestamp",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        let reset = out[0].reset_at.as_deref().unwrap();
        OffsetDateTime::parse(reset, &Rfc3339).expect("reset_at should be RFC3339");
    }

    #[test]
    fn reset_duration_parses_simple_seconds() {
        let d = parse_reset_duration("1s").unwrap();
        assert_eq!(d.whole_seconds(), 1);
    }

    #[test]
    fn reset_duration_parses_combined_units() {
        let d = parse_reset_duration("6m0s").unwrap();
        assert_eq!(d.whole_seconds(), 360);
    }

    #[test]
    fn reset_duration_parses_fractional() {
        let d = parse_reset_duration("1.5s").unwrap();
        assert_eq!(d.whole_milliseconds(), 1500);
    }

    #[test]
    fn reset_duration_parses_full_day() {
        let d = parse_reset_duration("1d2h3m4s").unwrap();
        assert_eq!(d.whole_seconds(), 93_784);
    }

    #[test]
    fn reset_duration_parses_milliseconds() {
        let d = parse_reset_duration("250ms").unwrap();
        assert_eq!(d.whole_milliseconds(), 250);
    }

    #[test]
    fn reset_duration_empty_returns_none() {
        assert!(parse_reset_duration("").is_none());
    }

    #[test]
    fn reset_duration_pure_garbage_returns_none() {
        assert!(parse_reset_duration("garbage").is_none());
    }

    #[test]
    fn reset_duration_zero_is_valid() {
        let d = parse_reset_duration("0s").unwrap();
        assert_eq!(d.whole_seconds(), 0);
    }

    #[test]
    fn reset_duration_trailing_digits_without_unit_rejected() {
        assert!(parse_reset_duration("1m30").is_none());
        assert!(parse_reset_duration("1s0").is_none());
    }

    #[test]
    fn reset_duration_trailing_garbage_rejected() {
        assert!(parse_reset_duration("1s junk").is_none());
        assert!(parse_reset_duration("1ms_more").is_none());
    }

    #[test]
    fn reset_duration_unknown_unit_rejected() {
        assert!(parse_reset_duration("1w").is_none());
        assert!(parse_reset_duration("1s2w").is_none());
    }

    #[test]
    fn negative_limit_or_remaining_skips_metric() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "-1"),
                ("x-ratelimit-limit-tokens", "-5"),
                ("x-ratelimit-remaining-tokens", "100"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::NoData);
    }

    #[test]
    fn extreme_values_do_not_panic() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", &i64::MAX.to_string()),
                ("x-ratelimit-remaining-requests", "0"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].used, Some(i64::MAX));
    }

    #[test]
    fn reset_duration_trims_surrounding_whitespace() {
        let d = parse_reset_duration("  1s  ").unwrap();
        assert_eq!(d.whole_seconds(), 1);
        let d = parse_reset_duration(" 250ms").unwrap();
        assert_eq!(d.whole_milliseconds(), 250);
        let d = parse_reset_duration("6m0s\n").unwrap();
        assert_eq!(d.whole_seconds(), 360);
    }

    #[test]
    fn reset_duration_rejects_overflow_inputs() {
        assert!(parse_reset_duration("99999999999999999s").is_none());
        assert!(parse_reset_duration("999999d").is_none());
    }

    #[test]
    fn out_of_range_reset_drops_reset_at_without_panic() {
        // observed_at near PositiveInfinity is impossible; instead force
        // checked_add to refuse by using a max-cap reset on an already-late
        // observed_at. We use a snapshot whose reset value is just at the
        // 1-year cap and verify no panic occurs; if the parser rejected an
        // out-of-cap value we'd land in the "could not parse" message path.
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "59"),
                ("x-ratelimit-reset-requests", "99999999999999999s"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reset_at, None);
        assert!(out[0].message.as_deref().unwrap_or("").contains("reset-requests"));
    }

    #[test]
    fn empty_account_label_falls_back_to_default() {
        let snap = snapshot_with(
            &[
                ("x-ratelimit-limit-requests", "60"),
                ("x-ratelimit-remaining-requests", "59"),
            ],
            "2026-05-13T12:00:00Z",
        );
        let mut snap = snap;
        snap.account_label = "".into();
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out[0].account_label, DEFAULT_ACCOUNT_LABEL);
    }

    #[test]
    fn whitespace_account_label_falls_back_to_default() {
        let mut snap = snapshot_with(&[], "2026-05-13T12:00:00Z");
        snap.account_label = "   ".into();
        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out[0].account_label, DEFAULT_ACCOUNT_LABEL);
    }

    #[test]
    fn case_collision_resolves_deterministically() {
        // Both casings of the same header are present with different values.
        // The normalizer iterates entries in sorted original-key order, so
        // whichever original key sorts last wins. We assert this happens the
        // same way on every run (multiple constructions of the same input).
        let make = || {
            let mut headers = HashMap::new();
            headers.insert("x-ratelimit-limit-requests".to_string(), "100".to_string());
            headers.insert("X-RateLimit-Limit-Requests".to_string(), "999".to_string());
            headers.insert("x-ratelimit-remaining-requests".to_string(), "50".to_string());
            ObservedHeaderSnapshot {
                account_label: "personal".into(),
                observed_at: "2026-05-13T12:00:00Z".into(),
                headers,
            }
        };
        let limits: Vec<i64> = (0..16)
            .map(|_| parse_openai_headers(&make(), WARN, CRIT)[0].limit.unwrap())
            .collect();
        let first = limits[0];
        assert!(limits.iter().all(|&v| v == first));
        // Sorted ASCII puts uppercase 'X' before lowercase 'x'; lex-last wins
        // so the lowercase variant ("100") is the deterministic answer.
        assert_eq!(first, 100);
    }

    fn fixtures_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("openai_api")
    }

    #[test]
    fn load_snapshot_missing_returns_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("absent.json");
        assert!(load_snapshot_from_path(&path).unwrap().is_none());
    }

    #[test]
    fn load_snapshot_parses_full_fixture() {
        let path = fixtures_dir().join("headers_full.json");
        let snap = load_snapshot_from_path(&path)
            .unwrap()
            .expect("fixture should load");
        assert_eq!(snap.account_label, "personal");
        assert_eq!(snap.observed_at, "2026-05-13T12:00:00Z");
        assert_eq!(snap.headers.len(), 6);

        let out = parse_openai_headers(&snap, WARN, CRIT);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn load_snapshot_invalid_json_errors() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bad.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert!(load_snapshot_from_path(&path).is_err());
    }

    fn ctx_with_defaults() -> ProviderContext {
        let storage = Arc::new(Storage::open_in_memory().unwrap());
        ProviderContext::new(storage)
    }

    #[tokio::test]
    async fn provider_refresh_no_file_returns_no_data() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("openai-api.json");
        let provider = OpenAiApiProvider::new(path);
        let out = provider.refresh(&ctx_with_defaults()).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::NoData);
        assert_eq!(out[0].provider_kind, ProviderKind::OpenAiApi);
        assert_eq!(out[0].account_label, DEFAULT_ACCOUNT_LABEL);
    }

    #[tokio::test]
    async fn provider_refresh_with_fixture_emits_parsed_snapshots() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("openai-api.json");
        let fixture = fixtures_dir().join("headers_full.json");
        std::fs::copy(&fixture, &path).unwrap();
        let provider = OpenAiApiProvider::new(path);
        let out = provider.refresh(&ctx_with_defaults()).await.unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|s| s.metric == UsageMetric::Requests));
        assert!(out.iter().any(|s| s.metric == UsageMetric::Tokens));
        for s in &out {
            assert_eq!(s.source, UsageSource::ResponseHeader);
            assert_eq!(s.confidence, Confidence::High);
        }
    }

    #[tokio::test]
    async fn provider_refresh_with_empty_headers_returns_no_data() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("openai-api.json");
        let fixture = fixtures_dir().join("headers_empty.json");
        std::fs::copy(&fixture, &path).unwrap();
        let provider = OpenAiApiProvider::new(path);
        let out = provider.refresh(&ctx_with_defaults()).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::NoData);
    }

    #[tokio::test]
    async fn provider_refresh_with_corrupt_file_returns_error_snapshot() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("openai-api.json");
        std::fs::write(&path, b"{not json").unwrap();
        let provider = OpenAiApiProvider::new(path);
        let out = provider.refresh(&ctx_with_defaults()).await.unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, SnapshotStatus::Error);
        assert_eq!(out[0].provider_id, OPENAI_PROVIDER_ID);
    }
}
