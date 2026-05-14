//! Provider trait + context shared across all integrations (Phase 2).
//!
//! The Phase 2 default implementation only ships `ManualProvider`. Phase 3
//! will add `OpenAi` / `Anthropic` header providers behind the same trait —
//! the `CredentialGetter` and `Clock` traits exist now so those can be
//! injected without changing this signature.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use time::OffsetDateTime;

use crate::model::{ProviderKind, UsageSnapshot, DEFAULT_CRITICAL_PCT, DEFAULT_WARN_PCT};
use crate::storage::Storage;

pub mod manual;
pub mod openai_api;

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
    // Unused in Phase 2 — manual provider needs no secrets — but kept on the
    // trait so Phase 3 header providers slot in without an API churn.
    #[allow(dead_code)]
    fn get(&self, key: &str) -> Option<String>;
}

pub struct NoopCredentialGetter;

impl CredentialGetter for NoopCredentialGetter {
    fn get(&self, _key: &str) -> Option<String> {
        None
    }
}

// `storage` and `credentials` are unused by the manual provider but are
// part of the Phase 3 contract — header providers need to look up cached
// snapshots and API keys through this struct.
#[allow(dead_code)]
pub struct ProviderContext {
    pub storage: Arc<Storage>,
    pub clock: Arc<dyn Clock>,
    pub credentials: Arc<dyn CredentialGetter>,
    pub warn_pct: f64,
    pub critical_pct: f64,
}

impl ProviderContext {
    #[allow(dead_code)]
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

/// Build the list of providers that ship by default. Phase 3a adds the
/// OpenAI API header provider; its snapshot file path is rooted under the
/// app's data directory so Phase 3b's proxy/import flow can write to the
/// same location without extra plumbing.
pub fn default_providers(
    storage: Arc<Storage>,
    data_dir: &Path,
) -> Vec<Arc<dyn UsageProvider>> {
    vec![
        Arc::new(manual::ManualProvider::new(storage)),
        Arc::new(openai_api::OpenAiApiProvider::new(
            openai_api::OpenAiApiProvider::default_snapshot_path(data_dir),
        )),
    ]
}
