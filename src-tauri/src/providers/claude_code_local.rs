//! Claude Code local provider — best-effort cumulative token usage parsed
//! from `~/.claude/projects/<encoded-cwd>/<session>.jsonl` files.
//!
//! Scope (spec §8.4): we only emit a single cumulative-tokens row tagged
//! `source = local-log`, `confidence = medium`. 5-hour / weekly windows are
//! intentionally not estimated here — Claude Code session logs carry no
//! reliable reset marker, so the spec forbids presenting estimated remaining
//! as exact. If the data directory is absent or empty we degrade to a single
//! `NoData` row with a clear message.
//!
//! Hard rules followed (AGENTS.md):
//! - No shelling out to `ccusage` or any external CLI / Python.
//! - Only `.jsonl` files under `~/.claude/projects` are opened.
//! - Malformed JSON lines are skipped, never panicked on.
//! - No secrets are read or stored; only the four numeric token fields.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::Deserialize;
use time::OffsetDateTime;

use crate::model::{
    error_snapshot, format_rfc3339, Confidence, ProviderKind, SnapshotStatus, UsageMetric,
    UsageSnapshot, UsageSource, UsageWindow,
};
use crate::providers::{ProviderContext, UsageProvider};

pub const CLAUDE_CODE_LOCAL_PROVIDER_ID: &str = "claude-code-local";
const ACCOUNT_LABEL: &str = "local";

/// Phase 4a provider. Walks `<root>/<project>/<uuid>.jsonl` once per refresh
/// and emits one snapshot row. `with_root` is exposed for tests.
pub struct ClaudeCodeLocalProvider {
    root: Option<PathBuf>,
}

impl ClaudeCodeLocalProvider {
    pub fn new() -> Self {
        Self {
            root: default_root(),
        }
    }

    #[cfg(test)]
    pub fn with_root(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }
}

impl Default for ClaudeCodeLocalProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl UsageProvider for ClaudeCodeLocalProvider {
    fn id(&self) -> &'static str {
        CLAUDE_CODE_LOCAL_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCodeLocal
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let root = self.root.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || match root {
            Some(path) => scan_root(&path),
            None => ScanOutcome::Absent {
                reason: "no home directory resolved for ~/.claude/projects".to_string(),
            },
        })
        .await
        .map_err(|e| anyhow::anyhow!("claude-code-local task join error: {e}"))?;

        Ok(vec![outcome.into_snapshot(&ctx.clock.now())])
    }
}

/// Resolve `<HOME>/.claude/projects` without pulling in the `dirs` crate.
/// Returns `None` when no usable home variable is set.
fn default_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(".claude").join("projects"))
}

#[derive(Debug)]
enum ScanOutcome {
    /// The expected directory does not exist (or is not a directory).
    Absent { reason: String },
    /// The directory exists but no usage events were parseable.
    Empty { searched_root: PathBuf },
    /// Found usage events. `total_tokens` is saturated to `i64::MAX`.
    Found {
        total_tokens: i64,
        file_count: u64,
    },
    /// Top-level scan failed (e.g. permission denied on the root dir).
    Error(String),
}

/// Walk `<root>/*/<uuid>.jsonl`. Sub-directory or file errors are skipped
/// individually so a single broken file never aborts the scan.
fn scan_root(root: &Path) -> ScanOutcome {
    if !root.exists() {
        return ScanOutcome::Absent {
            reason: format!(
                "Claude Code data directory not found (looked at {})",
                root.display()
            ),
        };
    }
    if !root.is_dir() {
        return ScanOutcome::Absent {
            reason: format!("expected a directory at {}", root.display()),
        };
    }

    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(err) => return ScanOutcome::Error(format!("read_dir failed: {err}")),
    };

    let mut total: u64 = 0;
    let mut file_count: u64 = 0;
    let mut any_event = false;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let inner = match fs::read_dir(&path) {
            Ok(i) => i,
            Err(_) => continue, // skip unreadable project dirs without aborting
        };
        for inner_entry in inner.flatten() {
            let file_path = inner_entry.path();
            if !is_jsonl_file(&file_path) {
                continue;
            }
            file_count += 1;
            let (events, sum) = read_session_file(&file_path);
            if events > 0 {
                any_event = true;
            }
            total = total.saturating_add(sum);
        }
    }

    if !any_event {
        return ScanOutcome::Empty {
            searched_root: root.to_path_buf(),
        };
    }

    ScanOutcome::Found {
        total_tokens: saturating_u64_to_i64(total),
        file_count,
    }
}

fn is_jsonl_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
}

/// Read a single JSONL session and return `(usage_event_count, token_sum)`.
/// Any IO or parse failure for a line is silently skipped — the spec
/// explicitly forbids panicking on malformed local files.
fn read_session_file(path: &Path) -> (u64, u64) {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0),
    };
    let mut events: u64 = 0;
    let mut sum: u64 = 0;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<EventEnvelope>(trimmed) else {
            continue;
        };
        let Some(usage) = parsed.message.and_then(|m| m.usage) else {
            continue;
        };
        events += 1;
        sum = sum.saturating_add(usage.total());
    }
    (events, sum)
}

fn saturating_u64_to_i64(value: u64) -> i64 {
    if value > i64::MAX as u64 {
        i64::MAX
    } else {
        value as i64
    }
}

impl ScanOutcome {
    fn into_snapshot(self, now: &OffsetDateTime) -> UsageSnapshot {
        let observed_at = format_rfc3339(now);
        match self {
            ScanOutcome::Absent { reason } => no_data_snapshot(
                observed_at,
                UsageSource::Unavailable,
                Some(reason),
            ),
            ScanOutcome::Empty { searched_root } => no_data_snapshot(
                observed_at,
                UsageSource::LocalLog,
                Some(format!(
                    "no Claude Code usage events found under {}",
                    searched_root.display()
                )),
            ),
            ScanOutcome::Found {
                total_tokens,
                file_count,
            } => UsageSnapshot {
                provider_id: CLAUDE_CODE_LOCAL_PROVIDER_ID.to_string(),
                provider_kind: ProviderKind::ClaudeCodeLocal,
                account_label: ACCOUNT_LABEL.to_string(),
                window: UsageWindow::Unknown,
                metric: UsageMetric::Tokens,
                limit: None,
                used: Some(total_tokens),
                remaining: None,
                remaining_percent: None,
                reset_at: None,
                observed_at,
                source: UsageSource::LocalLog,
                confidence: Confidence::Medium,
                // We can't compute remaining without a known plan limit, but
                // hiding the row would make Claude Code invisible. `Ok`
                // signals "data present, no warning thresholds to evaluate."
                status: SnapshotStatus::Ok,
                message: Some(format!(
                    "cumulative tokens across {file_count} session file(s) (no reset window inferred)"
                )),
            },
            ScanOutcome::Error(message) => error_snapshot(
                CLAUDE_CODE_LOCAL_PROVIDER_ID,
                ProviderKind::ClaudeCodeLocal,
                now,
                format!("claude code local scan failed: {message}"),
            ),
        }
    }
}

fn no_data_snapshot(
    observed_at: String,
    source: UsageSource,
    message: Option<String>,
) -> UsageSnapshot {
    UsageSnapshot {
        provider_id: CLAUDE_CODE_LOCAL_PROVIDER_ID.to_string(),
        provider_kind: ProviderKind::ClaudeCodeLocal,
        account_label: ACCOUNT_LABEL.to_string(),
        window: UsageWindow::Unknown,
        metric: UsageMetric::Tokens,
        limit: None,
        used: None,
        remaining: None,
        remaining_percent: None,
        reset_at: None,
        observed_at,
        source,
        confidence: Confidence::Low,
        status: SnapshotStatus::NoData,
        message,
    }
}

#[derive(Deserialize, Default)]
struct EventEnvelope {
    #[serde(default)]
    message: Option<MessageEnvelope>,
}

#[derive(Deserialize, Default)]
struct MessageEnvelope {
    #[serde(default)]
    usage: Option<UsageFields>,
}

#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "snake_case")]
struct UsageFields {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

impl UsageFields {
    fn total(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_creation_input_tokens)
            .saturating_add(self.cache_read_input_tokens)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use std::fs;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn fixtures_dir() -> PathBuf {
        // `tests/fixtures/claude-code/` at the repo root — `CARGO_MANIFEST_DIR`
        // is `<repo>/src-tauri`, so step up once.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("manifest dir has a parent")
            .join("tests")
            .join("fixtures")
            .join("claude-code")
    }

    fn ctx() -> ProviderContext {
        ProviderContext::new(Arc::new(Storage::open_in_memory().unwrap()))
    }

    #[tokio::test]
    async fn absent_root_returns_no_data() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let provider = ClaudeCodeLocalProvider::with_root(missing);
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        let snap = &snapshots[0];
        assert_eq!(snap.provider_kind, ProviderKind::ClaudeCodeLocal);
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::Unavailable);
        assert_eq!(snap.confidence, Confidence::Low);
        assert!(snap.message.as_deref().unwrap().contains("not found"));
        assert_eq!(snap.account_label, ACCOUNT_LABEL);
    }

    #[tokio::test]
    async fn no_root_resolved_returns_no_data() {
        // `with_root` always sets Some; simulate the `default_root` returning
        // None by constructing the provider directly.
        let provider = ClaudeCodeLocalProvider { root: None };
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        let snap = &snapshots[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::Unavailable);
        assert!(snap
            .message
            .as_deref()
            .unwrap()
            .contains("no home directory"));
    }

    #[tokio::test]
    async fn empty_dir_returns_no_data_with_local_log_source() {
        let provider =
            ClaudeCodeLocalProvider::with_root(fixtures_dir().join("empty"));
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        let snap = &snapshots[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::LocalLog);
        assert!(snap
            .message
            .as_deref()
            .unwrap()
            .contains("no Claude Code usage events"));
    }

    #[tokio::test]
    async fn parses_valid_jsonl_and_sums_tokens() {
        let provider =
            ClaudeCodeLocalProvider::with_root(fixtures_dir().join("normal"));
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        let snap = &snapshots[0];
        assert_eq!(snap.status, SnapshotStatus::Ok);
        assert_eq!(snap.source, UsageSource::LocalLog);
        assert_eq!(snap.confidence, Confidence::Medium);
        assert_eq!(snap.metric, UsageMetric::Tokens);
        assert_eq!(snap.window, UsageWindow::Unknown);
        // normal fixture: 3 usage events with
        //   row1: input=10 output=20 cache_create=100 cache_read=5    = 135
        //   row2: input=8  output=42 cache_create=200 cache_read=10   = 260
        //   row3: input=4  output=18 cache_create=0   cache_read=1000 = 1022
        // total = 1417
        assert_eq!(snap.used, Some(1417));
        assert!(snap.limit.is_none());
        assert!(snap.remaining.is_none());
        assert!(snap.reset_at.is_none());
        assert!(snap
            .message
            .as_deref()
            .unwrap()
            .contains("cumulative tokens"));
    }

    #[tokio::test]
    async fn malformed_lines_are_skipped_without_panic() {
        let provider =
            ClaudeCodeLocalProvider::with_root(fixtures_dir().join("malformed"));
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots.len(), 1);
        let snap = &snapshots[0];
        // malformed fixture contains 1 valid usage event with total 150 plus
        // garbage lines: status must still be Ok with used=Some(150).
        assert_eq!(snap.status, SnapshotStatus::Ok);
        assert_eq!(snap.used, Some(150));
    }

    #[tokio::test]
    async fn no_usage_events_returns_no_data() {
        let provider =
            ClaudeCodeLocalProvider::with_root(fixtures_dir().join("no-usage"));
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        let snap = &snapshots[0];
        assert_eq!(snap.status, SnapshotStatus::NoData);
        assert_eq!(snap.source, UsageSource::LocalLog);
    }

    #[tokio::test]
    async fn non_jsonl_files_are_ignored_even_if_they_contain_valid_json() {
        // Build a synthetic root with a `.txt` file that would parse as a
        // valid usage event if we read it. The provider must not open it.
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("decoy.txt"),
            r#"{"message":{"usage":{"input_tokens":999}}}"#,
        )
        .unwrap();
        // Also drop a .jsonl with usage so we exercise the positive branch.
        fs::write(
            project.join("real.jsonl"),
            r#"{"message":{"usage":{"input_tokens":1,"output_tokens":2}}}"#,
        )
        .unwrap();

        let provider = ClaudeCodeLocalProvider::with_root(dir.path().to_path_buf());
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        let snap = &snapshots[0];
        assert_eq!(snap.status, SnapshotStatus::Ok);
        assert_eq!(snap.used, Some(3), ".txt content must not be counted");
    }

    #[tokio::test]
    async fn huge_token_counts_saturate_to_i64_max() {
        // `u64::MAX` would overflow `i64`; the provider must clamp instead of
        // panicking.
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("huge.jsonl"),
            format!(
                r#"{{"message":{{"usage":{{"input_tokens":{}}}}}}}"#,
                u64::MAX
            ),
        )
        .unwrap();
        let provider = ClaudeCodeLocalProvider::with_root(dir.path().to_path_buf());
        let snapshots = provider.refresh(&ctx()).await.unwrap();
        assert_eq!(snapshots[0].used, Some(i64::MAX));
    }

    #[tokio::test]
    async fn provider_kind_and_id_are_stable() {
        let provider = ClaudeCodeLocalProvider::with_root(PathBuf::from("/nonexistent"));
        assert_eq!(provider.id(), "claude-code-local");
        assert_eq!(provider.kind(), ProviderKind::ClaudeCodeLocal);
    }
}
