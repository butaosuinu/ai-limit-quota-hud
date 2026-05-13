//! Provider trait + context shared across all integrations (Phase 2).
//!
//! The Phase 2 default implementation only ships `ManualProvider`. Phase 3
//! will add `OpenAi` / `Anthropic` header providers behind the same trait —
//! the `CredentialGetter` and `Clock` traits exist now so those can be
//! injected without changing this signature.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use time::OffsetDateTime;

use crate::model::{ProviderKind, UsageSnapshot, DEFAULT_CRITICAL_PCT, DEFAULT_WARN_PCT};
use crate::storage::Storage;

pub mod manual;

/// 60 seconds is the floor specified by AGENTS.md — every provider must
/// respect this unless it has a strong reason to be slower.
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

/// Abstraction over the OS credential store. Phase 2 only carries the
/// no-op implementation; Phase 3 will swap in a `keyring`-backed one.
pub trait CredentialGetter: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct NoopCredentialGetter;

impl CredentialGetter for NoopCredentialGetter {
    fn get(&self, _key: &str) -> Option<String> {
        None
    }
}

pub struct ProviderContext {
    pub storage: Arc<Storage>,
    pub clock: Arc<dyn Clock>,
    pub credentials: Arc<dyn CredentialGetter>,
    pub warn_pct: f64,
    pub critical_pct: f64,
}

impl ProviderContext {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            clock: Arc::new(SystemClock),
            credentials: Arc::new(NoopCredentialGetter),
            warn_pct: DEFAULT_WARN_PCT,
            critical_pct: DEFAULT_CRITICAL_PCT,
        }
    }
}

/// Build the list of providers that ship with Phase 2. Phase 3+ extends this
/// with conditional providers gated on credential presence so startup remains
/// network-free for users without configured API keys.
pub fn default_providers(storage: Arc<Storage>) -> Vec<Arc<dyn UsageProvider>> {
    vec![Arc::new(manual::ManualProvider::new(storage))]
}
