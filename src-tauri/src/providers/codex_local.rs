//! Codex CLI local provider (Phase 4b).
//!
//! Codex CLI does not write quota / rate-limit information into the local
//! `~/.codex/` directory — only conversation metadata (`session_index.jsonl`,
//! `history.jsonl`). Per AGENTS.md / PROJECT_SPEC.md §8.5 we therefore:
//!
//! - Discover the Codex home (`$CODEX_HOME` then `~/.codex/`).
//! - Parse the stable `session_index.jsonl` schema (`{id, thread_name,
//!   updated_at}`) and count sessions touched in the last 24 hours.
//! - Emit a single `source = Estimate`, `confidence = Low` snapshot. Limit and
//!   remaining stay `None` so the UI cannot mistake the value for a "real"
//!   remaining quota.
//! - Return an explicit `NoData` snapshot (not an empty vec) when the
//!   directory or index file is missing, so the overlay still shows a row
//!   with a useful "why nothing is here" message.
//!
//! Only `session_index.jsonl` is read. We never touch `auth.json`,
//! `config.toml`, the SQLite log DB, or any file with `token`/`secret`/etc.
//! in its name — that satisfies the §14 rule "read only expected directories
//! and file extensions".

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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
pub const CODEX_LOCAL_ACCOUNT_LABEL: &str = "Codex CLI";
const SESSION_INDEX_FILENAME: &str = "session_index.jsonl";
const ESTIMATE_WINDOW_SECS: i64 = 24 * 60 * 60;

/// Resolves the directory that the Codex CLI writes its state into. Split
/// out as a trait so unit tests can point the provider at a `TempDir`
/// instead of the real `~/.codex/`.
pub trait CodexHomeResolver: Send + Sync {
    fn resolve(&self) -> Option<PathBuf>;
}

pub struct SystemCodexHomeResolver;

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
    pub fn with_resolver(resolver: Arc<dyn CodexHomeResolver>) -> Self {
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

    fn min_refresh_interval(&self) -> Duration {
        // Filesystem reads are cheap but Codex writes the index on every
        // session — 60s is plenty to surface changes.
        Duration::from_secs(60)
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
struct SessionEntry {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    thread_name: Option<String>,
    updated_at: String,
}

fn collect_snapshots(
    resolver: &dyn CodexHomeResolver,
    now: &OffsetDateTime,
) -> Vec<UsageSnapshot> {
    let Some(home) = resolver.resolve() else {
        return vec![nodata_snapshot(
            CODEX_LOCAL_PROVIDER_ID,
            ProviderKind::CodexLocal,
            CODEX_LOCAL_ACCOUNT_LABEL,
            now,
            "Codex CLI home directory could not be resolved (no $CODEX_HOME and no detectable home directory)",
        )];
    };

    let index_path = home.join(SESSION_INDEX_FILENAME);
    if !index_path.exists() {
        return vec![nodata_snapshot(
            CODEX_LOCAL_PROVIDER_ID,
            ProviderKind::CodexLocal,
            CODEX_LOCAL_ACCOUNT_LABEL,
            now,
            format!(
                "Codex CLI session index not found at {} — start a Codex session to populate it",
                index_path.display()
            ),
        )];
    }

    let file = match std::fs::File::open(&index_path) {
        Ok(f) => f,
        Err(err) => {
            return vec![error_snapshot(
                CODEX_LOCAL_PROVIDER_ID,
                ProviderKind::CodexLocal,
                now,
                format!("failed to open Codex session index: {err}"),
            )];
        }
    };

    let cutoff = *now - time::Duration::seconds(ESTIMATE_WINDOW_SECS);
    let mut count: i64 = 0;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            // Read error mid-stream (e.g., invalid UTF-8). Skip rather than
            // panic — a single bad byte should not blank the snapshot.
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) else {
            continue;
        };
        let Ok(ts) = OffsetDateTime::parse(&entry.updated_at, &Rfc3339) else {
            continue;
        };
        if ts >= cutoff {
            count += 1;
        }
    }

    if count == 0 {
        return vec![nodata_snapshot(
            CODEX_LOCAL_PROVIDER_ID,
            ProviderKind::CodexLocal,
            CODEX_LOCAL_ACCOUNT_LABEL,
            now,
            "No Codex CLI sessions touched in the last 24h",
        )];
    }

    vec![estimate_snapshot(count, now)]
}

fn estimate_snapshot(count: i64, now: &OffsetDateTime) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: format!("{CODEX_LOCAL_PROVIDER_ID}:default"),
        provider_kind: ProviderKind::CodexLocal,
        account_label: CODEX_LOCAL_ACCOUNT_LABEL.to_string(),
        window: UsageWindow::Daily,
        metric: UsageMetric::Requests,
        limit: None,
        used: Some(count),
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at: format_rfc3339(now),
        source: UsageSource::Estimate,
        confidence: Confidence::Low,
        // No `limit` is known locally — we deliberately surface this as
        // `NoData` ("there is a number but we cannot judge severity") rather
        // than `Ok`, matching `classify_status(None, None, None, ..)`.
        status: SnapshotStatus::NoData,
        message: Some(format!(
            "Estimate: {count} Codex CLI session(s) in last 24h (no local quota data — counted from session_index.jsonl)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Confidence, ProviderKind, SnapshotStatus, UsageMetric, UsageSource};
    use crate::providers::{
        Clock, CredentialGetter, NoopCredentialGetter, ProviderContext, SystemClock,
    };
    use crate::storage::Storage;
    use std::path::Path;
    use std::sync::Arc;
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
        let storage = Arc::new(Storage::open_in_memory().unwrap());
        ProviderContext {
            storage,
            clock,
            credentials: Arc::new(NoopCredentialGetter),
            warn_pct: crate::model::DEFAULT_WARN_PCT,
            critical_pct: crate::model::DEFAULT_CRITICAL_PCT,
        }
    }

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tests/fixtures/codex")
    }

    fn copy_fixture_to(home: &Path, fixture_name: &str) {
        let src = fixture_dir().join(fixture_name);
        let dst = home.join(SESSION_INDEX_FILENAME);
        std::fs::copy(&src, &dst).unwrap_or_else(|e| {
            panic!("copy {} -> {}: {e}", src.display(), dst.display())
        });
    }

    #[tokio::test]
    async fn missing_resolver_returns_nodata() {
        let provider = CodexLocalProvider::with_resolver(Arc::new(FixtureResolver { path: None }));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        let snaps = provider.refresh(&ctx).await.unwrap();
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
        let provider = CodexLocalProvider::with_resolver(Arc::new(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        }));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        let snaps = provider.refresh(&ctx).await.unwrap();
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
        let provider = CodexLocalProvider::with_resolver(Arc::new(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        }));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        let snaps = provider.refresh(&ctx).await.unwrap();
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
        let provider = CodexLocalProvider::with_resolver(Arc::new(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        }));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        let snaps = provider.refresh(&ctx).await.unwrap();
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.provider_kind, ProviderKind::CodexLocal);
        assert_eq!(snap.provider_id, "codex-local:default");
        assert_eq!(snap.account_label, CODEX_LOCAL_ACCOUNT_LABEL);
        assert_eq!(snap.source, UsageSource::Estimate);
        assert_eq!(snap.confidence, Confidence::Low);
        assert_eq!(snap.metric, UsageMetric::Requests);
        // 2 of the 3 fixture rows fall inside the 24h window from the fixed clock.
        assert_eq!(snap.used, Some(2));
        assert!(snap.limit.is_none());
        assert!(snap.remaining.is_none());
        assert!(snap.remaining_percent.is_none());
        assert_eq!(snap.status, SnapshotStatus::NoData);
        // Message must mark this as an estimate (acceptance criterion).
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
        let provider = CodexLocalProvider::with_resolver(Arc::new(FixtureResolver {
            path: Some(tmp.path().to_path_buf()),
        }));
        let ctx = ctx_with_clock(Arc::new(FixedClock(fixed_now())));
        let snaps = provider.refresh(&ctx).await.unwrap();
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        // The fixture contains 2 valid in-window entries plus several junk
        // lines (truncated JSON, empty line, missing fields, bad timestamp).
        // Junk must be skipped silently — never panic.
        assert_eq!(snap.source, UsageSource::Estimate);
        assert_eq!(snap.used, Some(2));
    }

    #[test]
    fn provider_metadata_is_stable() {
        let provider = CodexLocalProvider::new();
        assert_eq!(provider.id(), "codex-local");
        assert_eq!(provider.kind(), ProviderKind::CodexLocal);
        assert_eq!(provider.min_refresh_interval(), Duration::from_secs(60));
    }

    // Silence unused-import warnings for items only used via trait bounds.
    #[allow(dead_code)]
    fn _trait_object_compiles(_: Arc<dyn CredentialGetter>, _: SystemClock) {}
}
