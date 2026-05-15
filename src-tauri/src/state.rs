//! Application state (provider snapshots + scheduler trigger).
//!
//! Overlay settings live on the separate `AppState` in `lib.rs`. Tauri's
//! typed `State<T>` retrieves each one independently.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, RwLock};

use crate::model::UsageSnapshot;
use crate::scheduler::SchedulerHandle;

pub const USAGE_UPDATED_EVENT: &str = "usage://updated";

pub struct ProviderState {
    pub latest: Arc<RwLock<Vec<UsageSnapshot>>>,
    pub scheduler: SchedulerHandle,
    /// Refresh interval in seconds. Shared with the scheduler so
    /// `set_refresh_interval` updates take effect on the next iteration
    /// without respawning the loop.
    pub refresh_interval_seconds: Arc<AtomicU64>,
}

impl ProviderState {
    pub fn new(
        latest: Arc<RwLock<Vec<UsageSnapshot>>>,
        scheduler: SchedulerHandle,
        refresh_interval_seconds: Arc<AtomicU64>,
    ) -> Self {
        Self {
            latest,
            scheduler,
            refresh_interval_seconds,
        }
    }
}
