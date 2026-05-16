//! Provider trait + context shared across all integrations.
//!
//! v1 ships opt-in WebView providers only (see `docs/PROJECT_SPEC.md` §8).
//! Concrete provider implementations live under `webview::`; this module
//! defines the trait surface and registers the default provider set.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use time::OffsetDateTime;

use crate::model::{ProviderKind, UsageSnapshot, DEFAULT_CRITICAL_PCT, DEFAULT_WARN_PCT};
use crate::provider_settings::ProviderSettingsStore;

pub mod webview;

/// 60 seconds is the floor specified by AGENTS.md — every provider must
/// respect this unless it has a strong reason to be slower. WebView providers
/// raise this to a 300s floor / 600s default per spec §8.
pub const DEFAULT_REFRESH_INTERVAL_SECS: u64 = 60;

#[async_trait]
pub trait UsageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn kind(&self) -> ProviderKind;
    /// Per-provider lower bound. The scheduler will not refresh more often.
    fn min_refresh_interval(&self) -> Duration {
        Duration::from_secs(DEFAULT_REFRESH_INTERVAL_SECS)
    }
    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

#[allow(dead_code)]
pub struct ProviderContext {
    pub clock: Arc<dyn Clock>,
    pub warn_pct: f64,
    pub critical_pct: f64,
}

impl ProviderContext {
    pub fn new() -> Self {
        Self {
            clock: Arc::new(SystemClock),
            warn_pct: DEFAULT_WARN_PCT,
            critical_pct: DEFAULT_CRITICAL_PCT,
        }
    }
}

/// Bundle returned alongside the provider list so `lib.rs` can attach a
/// Tauri `AppHandle` to the WebView-backed providers once the app is fully
/// constructed. The handle isn't available when `default_providers` runs
/// (the scheduler is spawned from inside `setup()`), so we delay binding it.
pub struct DefaultProviders {
    pub providers: Vec<Arc<dyn UsageProvider>>,
    pub claude_web: Arc<webview::claude_web::ClaudeWebProvider>,
    pub codex_web: Arc<webview::codex_web::CodexWebProvider>,
}

/// Build the default provider list. `data_dir` is the app's data directory;
/// WebView providers keep their per-provider session storage under
/// `data_dir/webview-<provider>/` on Windows / Linux, or a
/// `dataStoreIdentifier`-backed `WKWebsiteDataStore` on macOS (spec §8).
///
/// WebView providers are always registered with the scheduler so they
/// participate in the refresh loop, but their `refresh()` short-circuits to
/// an empty `Vec` while the opt-in toggle is off. That keeps the provider
/// order stable across enable/disable cycles and avoids having to respawn
/// the scheduler when the user flips a toggle.
pub fn default_providers(
    data_dir: &Path,
    provider_settings: Arc<ProviderSettingsStore>,
) -> DefaultProviders {
    let claude_web = Arc::new(webview::claude_web::ClaudeWebProvider::new(
        data_dir.to_path_buf(),
        Arc::clone(&provider_settings),
    ));
    let codex_web = Arc::new(webview::codex_web::CodexWebProvider::new(
        data_dir.to_path_buf(),
        Arc::clone(&provider_settings),
    ));
    let providers: Vec<Arc<dyn UsageProvider>> = vec![
        Arc::clone(&claude_web) as Arc<dyn UsageProvider>,
        Arc::clone(&codex_web) as Arc<dyn UsageProvider>,
    ];
    DefaultProviders {
        providers,
        claude_web,
        codex_web,
    }
}
