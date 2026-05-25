//! Application state (provider snapshots + scheduler trigger).
//!
//! Overlay settings live on the separate `AppState` in `lib.rs`. Tauri's
//! typed `State<T>` retrieves each one independently.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, RwLock};

use crate::model::UsageSnapshot;
use crate::providers::webview::claude_web::ClaudeWebProvider;
use crate::providers::webview::codex_web::CodexWebProvider;
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

/// Tauri-managed handle to the WebView-backed providers. Kept separate from
/// [`ProviderState`] so the `open_provider_login_window` and
/// `delete_provider_data` Tauri commands can resolve the right provider via
/// `State<WebviewProviders>` without taking a lock on the snapshot list.
pub struct WebviewProviders {
    pub claude_web: Arc<ClaudeWebProvider>,
    pub codex_web: Arc<CodexWebProvider>,
}

impl WebviewProviders {
    pub fn new(claude_web: Arc<ClaudeWebProvider>, codex_web: Arc<CodexWebProvider>) -> Self {
        Self {
            claude_web,
            codex_web,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use tokio::sync::mpsc;

    use crate::provider_settings::ProviderSettingsStore;
    use crate::providers::webview::claude_web::CLAUDE_WEB_PROVIDER_ID;
    use crate::providers::webview::codex_web::CODEX_WEB_PROVIDER_ID;
    use crate::providers::UsageProvider;

    #[test]
    fn provider_state_new_keeps_shared_handles() {
        let latest = Arc::new(RwLock::new(Vec::new()));
        let interval = Arc::new(AtomicU64::new(90));
        let (tx, _rx) = mpsc::channel(1);
        let state = ProviderState::new(
            Arc::clone(&latest),
            SchedulerHandle { trigger_tx: tx },
            Arc::clone(&interval),
        );

        state.refresh_interval_seconds.store(120, Ordering::Relaxed);
        assert_eq!(interval.load(Ordering::Relaxed), 120);
        assert!(Arc::ptr_eq(&state.latest, &latest));
    }

    #[test]
    fn webview_providers_new_keeps_provider_instances() {
        let tmp = tempfile::TempDir::new().unwrap();
        let settings = Arc::new(ProviderSettingsStore::load(tmp.path()).unwrap());
        let claude = Arc::new(ClaudeWebProvider::new(
            tmp.path().join("claude"),
            Arc::clone(&settings),
        ));
        let codex = Arc::new(CodexWebProvider::new(
            tmp.path().join("codex"),
            Arc::clone(&settings),
        ));

        let providers = WebviewProviders::new(Arc::clone(&claude), Arc::clone(&codex));

        assert_eq!(providers.claude_web.id(), CLAUDE_WEB_PROVIDER_ID);
        assert_eq!(providers.codex_web.id(), CODEX_WEB_PROVIDER_ID);
        assert!(Arc::ptr_eq(&providers.claude_web, &claude));
        assert!(Arc::ptr_eq(&providers.codex_web, &codex));
    }
}
