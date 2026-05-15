//! Provider trait + context shared across all integrations.
//!
//! v1 ships opt-in WebView providers only (see `docs/PROJECT_SPEC.md` §8).
//! The trait, `ProviderContext`, and `default_providers` are kept as the
//! integration seam; WebView provider implementations will register
//! themselves here when they land.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use time::OffsetDateTime;

use crate::model::{ProviderKind, UsageSnapshot};

/// 60 seconds is the floor specified by AGENTS.md — every provider must
/// respect this unless it has a strong reason to be slower. WebView providers
/// further raise this to a 300s floor / 600s default per spec §8.
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

/// Build the default provider list. `data_dir` is the app's data directory
/// reserved for WebView providers (which keep a `webview-<provider>/` session
/// store on Windows / Linux, or a `dataStoreIdentifier`-backed
/// `WKWebsiteDataStore` on macOS — see spec §8). WebView provider
/// implementations register themselves here when they land.
pub fn default_providers(_data_dir: &Path) -> Vec<Arc<dyn UsageProvider>> {
    Vec::new()
}
