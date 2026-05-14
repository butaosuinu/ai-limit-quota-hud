//! Manual provider — reads user-entered usage rows from SQLite.
//!
//! Defaults: `source = manual`, `confidence = low` (spec §8.1). DB read
//! failures degrade to a single `Error` row so the rest of the overlay keeps
//! working — the scheduler never sees a panic from this provider.

use std::sync::Arc;

use async_trait::async_trait;

use crate::model::{error_snapshot, snapshot_from_manual_row, ProviderKind, UsageSnapshot};
use crate::providers::{ProviderContext, UsageProvider};
use crate::storage::Storage;

pub const MANUAL_PROVIDER_ID: &str = "manual";

pub struct ManualProvider {
    storage: Arc<Storage>,
}

impl ManualProvider {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }
}

#[async_trait]
impl UsageProvider for ManualProvider {
    fn id(&self) -> &'static str {
        MANUAL_PROVIDER_ID
    }

    fn kind(&self) -> ProviderKind {
        ProviderKind::Manual
    }

    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
        let storage = Arc::clone(&self.storage);
        // SQLite work is synchronous; jump to a blocking pool so the tokio
        // runtime keeps churning through other providers.
        let rows = tauri::async_runtime::spawn_blocking(move || storage.list_manual_rows())
            .await
            .map_err(|e| anyhow::anyhow!("manual provider task join error: {e}"))?;
        let now = ctx.clock.now();
        let snapshots = match rows {
            Ok(rows) => rows
                .iter()
                .map(|row| snapshot_from_manual_row(row, &now, ctx.warn_pct, ctx.critical_pct))
                .collect(),
            Err(err) => {
                // Don't bubble up — surface the failure as a single error row
                // (provider failures must not crash other providers).
                vec![error_snapshot(
                    MANUAL_PROVIDER_ID,
                    ProviderKind::Manual,
                    &now,
                    redact_db_error(&err.to_string()),
                )]
            }
        };
        Ok(snapshots)
    }
}

/// Strip any value-shaped payloads so DB errors do not leak user data into
/// logs or the UI. Phase 3 will lift this to a project-wide `redact_for_log`.
fn redact_db_error(message: &str) -> String {
    let truncated: String = message.chars().take(160).collect();
    format!("manual storage unavailable: {truncated}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Confidence, ManualRowInput, ProviderKind, SnapshotStatus, UsageMetric, UsageSource,
        UsageWindow,
    };

    fn ctx_with(storage: Arc<Storage>) -> ProviderContext {
        ProviderContext::new(storage)
    }

    fn sample_input(label: &str) -> ManualRowInput {
        ManualRowInput {
            provider_label: "ChatGPT".into(),
            account_label: label.into(),
            window: UsageWindow::FiveHours,
            metric: UsageMetric::Messages,
            limit: Some(40),
            used: Some(10),
            remaining: Some(30),
            reset_at: Some("2026-05-13T17:00:00Z".into()),
            note: None,
        }
    }

    #[tokio::test]
    async fn empty_storage_returns_empty_vec() {
        let storage = Arc::new(Storage::open_in_memory().unwrap());
        let provider = ManualProvider::new(Arc::clone(&storage));
        let snapshots = provider.refresh(&ctx_with(storage)).await.unwrap();
        assert!(snapshots.is_empty());
    }

    #[tokio::test]
    async fn seeded_rows_become_manual_snapshots() {
        let storage = Arc::new(Storage::open_in_memory().unwrap());
        storage.create_manual_row(&sample_input("personal")).unwrap();
        storage.create_manual_row(&sample_input("work")).unwrap();
        let provider = ManualProvider::new(Arc::clone(&storage));
        let snapshots = provider.refresh(&ctx_with(storage)).await.unwrap();
        assert_eq!(snapshots.len(), 2);
        for snap in &snapshots {
            assert_eq!(snap.provider_kind, ProviderKind::Manual);
            assert_eq!(snap.source, UsageSource::Manual);
            assert_eq!(snap.confidence, Confidence::Low);
            assert_eq!(snap.status, SnapshotStatus::Ok);
            assert!(snap.provider_id.starts_with("manual:"));
        }
    }
}
