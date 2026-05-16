//! Phase 2 application state (provider snapshots + scheduler trigger).
//!
//! Phase 1's `AppState` (overlay settings) lives in `lib.rs`. Phase 2 keeps
//! its own state struct so the two don't collide — Tauri's typed `State<T>`
//! retrieves each one independently.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, RwLock};

use crate::model::UsageSnapshot;
use crate::providers::webview::claude_web::ClaudeWebProvider;
use crate::scheduler::SchedulerHandle;
use crate::storage::Storage;

pub const USAGE_UPDATED_EVENT: &str = "usage://updated";

pub struct ProviderState {
    pub storage: Arc<Storage>,
    pub latest: Arc<RwLock<Vec<UsageSnapshot>>>,
    pub scheduler: SchedulerHandle,
    /// Refresh interval in seconds. Shared with the scheduler so
    /// `set_refresh_interval` updates take effect on the next iteration
    /// without respawning the loop.
    pub refresh_interval_seconds: Arc<AtomicU64>,
}

impl ProviderState {
    pub fn new(
        storage: Arc<Storage>,
        latest: Arc<RwLock<Vec<UsageSnapshot>>>,
        scheduler: SchedulerHandle,
        refresh_interval_seconds: Arc<AtomicU64>,
    ) -> Self {
        Self {
            storage,
            latest,
            scheduler,
            refresh_interval_seconds,
        }
    }
}

/// Tauri-managed handle to the WebView-backed providers. Kept separate from
/// [`ProviderState`] so the `open_provider_login_window` and
/// `delete_provider_data` Tauri commands can resolve the right provider via
/// `State<WebviewProviders>` without taking a lock on the snapshot list.
pub struct WebviewProviders {
    pub claude_web: Arc<ClaudeWebProvider>,
}

impl WebviewProviders {
    pub fn new(claude_web: Arc<ClaudeWebProvider>) -> Self {
        Self { claude_web }
    }
}
