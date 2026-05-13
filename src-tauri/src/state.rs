//! Phase 2 application state (provider snapshots + scheduler trigger).
//!
//! Phase 1's `AppState` (overlay settings) lives in `lib.rs`. Phase 2 keeps
//! its own state struct so the two don't collide — Tauri's typed `State<T>`
//! retrieves each one independently.

use std::sync::{Arc, RwLock};

use crate::model::UsageSnapshot;
use crate::scheduler::SchedulerHandle;
use crate::storage::Storage;

pub const USAGE_UPDATED_EVENT: &str = "usage://updated";

pub struct ProviderState {
    pub storage: Arc<Storage>,
    pub latest: Arc<RwLock<Vec<UsageSnapshot>>>,
    pub scheduler: SchedulerHandle,
    /// Refresh interval in seconds. Phase 2 keeps this in memory only —
    /// persisting requires extending Phase 1's settings.json schema, deferred
    /// to a follow-up.
    pub refresh_interval_seconds: RwLock<u64>,
}

impl ProviderState {
    pub fn new(
        storage: Arc<Storage>,
        latest: Arc<RwLock<Vec<UsageSnapshot>>>,
        scheduler: SchedulerHandle,
        refresh_interval_seconds: u64,
    ) -> Self {
        Self {
            storage,
            latest,
            scheduler,
            refresh_interval_seconds: RwLock::new(refresh_interval_seconds),
        }
    }
}
