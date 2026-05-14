//! Codex CLI local provider (Phase 4b).
//!
//! Codex CLI does not write quota / rate-limit information into the local
//! `~/.codex/` directory — only conversation metadata. Per PROJECT_SPEC.md
//! §8.5 / §14 we therefore only read `session_index.jsonl` (the one stable
//! structured file), count the sessions touched in the last 24 h, and emit
//! a single `Estimate` snapshot. `limit` / `remaining` stay `None` so the
//! UI cannot mistake the value for a real remaining quota, and we surface
//! "directory missing" / "no sessions" as explicit `NoData` snapshots
//! (not empty vecs) so the overlay row stays visible with a useful message.

use std::io::{BufRead, BufReader, ErrorKind};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::model::{
    error_snapshot, format_rfc3339, nodata_snapshot, Confidence, ProviderKind, SnapshotStatus,
    UsageMetric, UsageSnapshot, UsageSource, UsageWindow,
};
use crate::providers::{ProviderContext, UsageProvider};

pub const CODEX_LOCAL_PROVIDER_ID: &str = "codex-local";
const CODEX_LOCAL_ACCOUNT_LABEL: &str = "Codex CLI";
const SESSION_INDEX_FILENAME: &str = "session_index.jsonl";
const ESTIMATE_WINDOW_SECS: i64 = 24 * 60 * 60;

trait CodexHomeResolver: Send + Sync {
    fn resolve(&self) -> Option<PathBuf>;
}

struct SystemCodexHomeResolver;

impl CodexHomeResolver for SystemCodexHomeResolver {
    fn resolve(&self) -> Option<PathBuf> {
        if let Ok(custom) = std::env::var("CODEX_HOME") {
            if !custom.is_empty() {
                return Some(PathBuf::from(custom));
            }
        }
        dirs::home_dir().map(|h| h.join(".codex"))
    }
}

pub struct CodexLocalProvider {
    home_resolver: Arc<dyn CodexHomeResolver>,
}

impl CodexLocalProvider {
    pub fn new() -> Self {
        Self {
            home_resolver: Arc::new(SystemCodexHomeResolver),
        }
    }

    #[cfg(test)]
    fn with_resolver(resolver: Arc<dyn CodexHomeResolver>) -> Self {
        Self {
            home_resolver: resolver,
        }
    }
}

impl Default for CodexLocalProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl UsageProvider for CodexLocalProvider {
    fn id(&self) -> &'static str {
        CODEX_LOCAL_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::CodexLocal
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let resolver = Arc::clone(&self.home_resolver);
        let clock = Arc::clone(&ctx.clock);
        let snapshots = tauri::async_runtime::spawn_blocking(move || {
            let now = clock.now();
            collect_snapshots(resolver.as_ref(), &now)
        })
        .await
        .map_err(|e| anyhow::anyhow!("codex_local provider task join error: {e}"))?;
        Ok(snapshots)
    }
}

#[derive(Debug, Deserialize)]
struct SessionEntry<'a> {
    updated_at: &'a str,
}

fn nodata(now: &OffsetDateTime, message: impl Into<String>) -> UsageSnapshot {
    nodata_snapshot(
        CODEX_LOCAL_PROVIDER_ID,
        ProviderKind::CodexLocal,
        CODEX_LOCAL_ACCOUNT_LABEL,
        now,
        message,
    )
}

fn error(now: &OffsetDateTime, message: impl Into<String>) -> UsageSnapshot {
    error_snapshot(
        CODEX_LOCAL_PROVIDER_ID,
        ProviderKind::CodexLocal,
        now,
        message,
    )
}

fn collect_snapshots(
    resolver: &dyn CodexHomeResolver,
    now: &OffsetDateTime,
) -> Vec<UsageSnapshot> {
    let Some(home) = resolver.resolve() else {
        return vec![nodata(
            now,
            "Codex CLI home directory could not be resolved (no $CODEX_HOME and no detectable home directory)",
        )];
    };

    let index_path = home.join(SESSION_INDEX_FILENAME);
    let file = match std::fs::File::open(&index_path) {
        Ok(f) => f,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return vec![nodata(
                now,
                format!(
                    "Codex CLI session index not found at {} — start a Codex session to populate it",
                    index_path.display()
                ),
            )];
        }
        Err(err) => {
            return vec![error(
                now,
                format!("failed to open Codex session index: {err}"),
            )];
        }
    };

    let cutoff = *now - time::Duration::seconds(ESTIMATE_WINDOW_SECS);
    let mut count: i64 = 0;
    for line in BufReader::new(file).lines() {
        // Read errors (e.g., invalid UTF-8 mid-stream) skip the line so one
        // bad byte does not blank the snapshot.
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) else {
            continue;
        };
        let Ok(ts) = OffsetDateTime::parse(entry.updated_at, &Rfc3339) else {
            continue;
        };
        // Clamp to (cutoff, now] — accept anything in the 24h window ending
        // at `now`, drop future-dated rows that would otherwise inflate the
        // count whenever the writer's clock had skewed forward.
        if ts >= cutoff && ts <= *now {
            count += 1;
        }
    }

    if count == 0 {
        return vec![nodata(now, "No Codex CLI sessions touched in the last 24h")];
    }
    vec![estimate_snapshot(count, now)]
}

fn estimate_snapshot(count: i64, now: &OffsetDateTime) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: format!("{CODEX_LOCAL_PROVIDER_ID}:default"),
        provider_kind: ProviderKind::CodexLocal,
        account_label: CODEX_LOCAL_ACCOUNT_LABEL.to_string(),
        window: UsageWindow::Daily,
        // The unit is "sessions touched in the last 24h", not requests or
        // messages — one Codex session can wrap many of either. `Unknown`
        // keeps the FE from suffixing a misleading unit; the snapshot
        // message spells "session(s)" out for the user.
        metric: UsageMetric::Unknown,
        limit: None,
        used: Some(count),
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at: format_rfc3339(now),
        source: UsageSource::Estimate,
        confidence: Confidence::Low,
        // No `limit` is known locally, so we surface this as `NoData` rather
        // than `Ok` — the UI must not infer severity from a count alone.
        status: SnapshotStatus::NoData,
        message: Some(format!(
            "Estimate: {count} Codex CLI session(s) in last 24h (no local quota data — counted from session_index.jsonl)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{Clock, NoopCredentialGetter};
    use crate::storage::Storage;
    use std::path::Path;
    use tempfile::TempDir;
    use time::macros::datetime;

    struct FixedClock(OffsetDateTime);
    impl Clock for FixedClock {
        fn now(&self) -> OffsetDateTime {
            self.0
        }
    }

    struct FixtureResolver {
        path: Option<PathBuf>,
    }
    impl CodexHomeResolver for FixtureResolver {
        fn resolve(&self) -> Option<PathBuf> {
            self.path.clone()
        }
    }

    fn fixed_now() -> OffsetDateTime {
        datetime!(2026-05-14 12:00:00 UTC)
    }

    fn ctx_with_clock(clock: Arc<dyn Clock>) -> ProviderContext {
        ProviderContext {
            storage: Arc::new(Storage::open_in_memory().unwrap()),
            clock,
            credentials: Arc::new(NoopCredentialGetter),
            warn_pct: crate::model::DEFAULT_WARN_PCT,
            critical_pct: crate::model::DEFAULT_CRITICAL_PCT,
        }
    }

    fn copy_fixture_to(home: &Path, fixture_name: &str) {
        let src = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/codex")
            .join(fixture_name);
        let dst = home.join(SESSION_INDEX_FILENAME);
        std::fs::copy(&src, &dst)
            .unwrap_or_else(|e| panic!("copy {} -> {}: {e}", src.display(), dst.display()));
    }

    async fn run_with(resolver: FixtureResolver) -> Vec<UsageSnapshot> {
        let provider = CodexLocalProvider::with_resolver(Arc::new(resolver));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        provider.refresh(&ctx).await.unwrap()
    }

    #[tokio::test]
    async fn missing_resolver_returns_nodata() {
        let snaps = run_with(FixtureResolver { path: None }).await;
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.provider_kind, ProviderKind::CodexLocal);
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::LocalLog);
        assert_eq!(snap.confidence, Confidence::Low);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("home directory"));
    }

    #[tokio::test]
    async fn empty_directory_returns_nodata() {
        let tmp = TempDir::new().unwrap();
        let snaps = run_with(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        })
        .await;
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::LocalLog);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("session index not found"));
    }

    #[tokio::test]
    async fn empty_jsonl_file_returns_nodata() {
        let tmp = TempDir::new().unwrap();
        copy_fixture_to(tmp.path(), "session_index_empty.jsonl");
        let snaps = run_with(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        })
        .await;
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::LocalLog);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("No Codex CLI sessions"));
    }

    #[tokio::test]
    async fn valid_sessions_produce_estimate() {
        let tmp = TempDir::new().unwrap();
        copy_fixture_to(tmp.path(), "session_index_valid.jsonl");
        let snaps = run_with(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        })
        .await;
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.provider_kind, ProviderKind::CodexLocal);
        assert_eq!(snap.provider_id, "codex-local:default");
        assert_eq!(snap.account_label, CODEX_LOCAL_ACCOUNT_LABEL);
        assert_eq!(snap.source, UsageSource::Estimate);
        assert_eq!(snap.confidence, Confidence::Low);
        assert_eq!(snap.metric, UsageMetric::Unknown);
        // 2 of 4 fixture rows fall inside (cutoff, now]: one row is older
        // than 24h, one is future-dated (clock-skew guard) — both excluded.
        assert_eq!(snap.used, Some(2));
        assert!(snap.limit.is_none());
        assert!(snap.remaining.is_none());
        assert!(snap.remaining_percent.is_none());
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert!(snap
            .message
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("estimate"));
    }

    #[tokio::test]
    async fn malformed_lines_do_not_panic() {
        let tmp = TempDir::new().unwrap();
        copy_fixture_to(tmp.path(), "session_index_malformed.jsonl");
        let snaps = run_with(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        })
        .await;
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.source, UsageSource::Estimate);
        assert_eq!(snap.used, Some(2));
    }

    #[test]
    fn provider_metadata_is_stable() {
        let provider = CodexLocalProvider::new();
        assert_eq!(provider.id(), "codex-local");
        assert_eq!(provider.kind(), ProviderKind::CodexLocal);
    }
}
