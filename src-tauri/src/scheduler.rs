//! Per-provider refresh loop with exponential backoff (Phase 2).
//!
//! - Each provider has a minimum interval (defaults to 60s per AGENTS.md).
//! - Repeated failures double the effective interval, capped at 1 hour.
//! - A success resets the backoff for that provider.
//! - Failures are isolated: one provider erroring out turns into an `Error`
//!   snapshot row, never a panic or a cross-provider stall.
//! - `trigger_tx.try_send(())` debounces manual nudges (channel capacity = 1).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::model::{error_snapshot, UsageSnapshot};
use crate::providers::{Clock, ProviderContext, SystemClock, UsageProvider};
use crate::state::USAGE_UPDATED_EVENT;
use crate::storage::Storage;

const REFRESH_TIMEOUT_SECS: u64 = 15;
const BACKOFF_CAP_SECS: u64 = 3600;
const MAX_BACKOFF_SHIFT: u32 = 6;

/// Handle held by the rest of the app — lets commands wake the scheduler
/// immediately after a CRUD mutation.
pub struct SchedulerHandle {
    pub trigger_tx: mpsc::Sender<()>,
}

pub struct SchedulerDeps {
    pub app: AppHandle,
    pub providers: Vec<Arc<dyn UsageProvider>>,
    pub storage: Arc<Storage>,
    pub latest: Arc<RwLock<Vec<UsageSnapshot>>>,
    /// Shared with `ProviderState::refresh_interval_seconds` so that
    /// `set_refresh_interval` is picked up on the next iteration without
    /// needing to respawn the scheduler.
    pub interval_seconds: Arc<AtomicU64>,
}

/// Spawn the refresh loop on the Tauri-managed tokio runtime.
pub fn spawn(deps: SchedulerDeps) -> SchedulerHandle {
    let (trigger_tx, trigger_rx) = mpsc::channel(1);
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    tauri::async_runtime::spawn(run_loop(deps, clock, trigger_rx));
    SchedulerHandle { trigger_tx }
}

async fn run_loop(
    deps: SchedulerDeps,
    clock: Arc<dyn Clock>,
    mut trigger_rx: mpsc::Receiver<()>,
) {
    let SchedulerDeps {
        app,
        providers,
        storage,
        latest,
        interval_seconds,
    } = deps;
    let mut state = SchedulerState::default();
    // Tick once immediately so a fresh app shows snapshots without waiting
    // 60 seconds for the first interval to elapse.
    refresh_once(
        &app,
        &providers,
        &storage,
        &latest,
        &clock,
        &mut state,
        /* force = */ true,
    )
    .await;
    loop {
        let interval = Duration::from_secs(interval_seconds.load(Ordering::Relaxed));
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            recv = trigger_rx.recv() => {
                if recv.is_none() {
                    return;
                }
                // Drain any extra triggers that arrived while we were sleeping.
                while trigger_rx.try_recv().is_ok() {}
                // Manual nudges (CRUD mutations) must bypass the per-provider
                // throttle so newly written rows surface immediately.
                state.force_next = true;
            }
        }
        let forced = state.consume_force_flag();
        refresh_once(
            &app,
            &providers,
            &storage,
            &latest,
            &clock,
            &mut state,
            forced,
        )
        .await;
    }
}

#[derive(Default)]
struct SchedulerState {
    last_run: HashMap<&'static str, std::time::Instant>,
    failure_count: HashMap<&'static str, u32>,
    /// Set by `trigger_now` so the next iteration ignores the per-provider
    /// throttle and refreshes immediately.
    force_next: bool,
}

impl SchedulerState {
    fn consume_force_flag(&mut self) -> bool {
        std::mem::take(&mut self.force_next)
    }
}

async fn refresh_once(
    app: &AppHandle,
    providers: &[Arc<dyn UsageProvider>],
    storage: &Arc<Storage>,
    latest: &Arc<RwLock<Vec<UsageSnapshot>>>,
    clock: &Arc<dyn Clock>,
    state: &mut SchedulerState,
    force: bool,
) {
    let now = std::time::Instant::now();
    let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> = HashMap::new();
    for provider in providers {
        let id = provider.id();
        if !force {
            let failures = *state.failure_count.get(id).unwrap_or(&0);
            let effective = effective_interval(provider.min_refresh_interval(), failures);
            if let Some(last) = state.last_run.get(id) {
                if now.duration_since(*last) < effective {
                    continue;
                }
            }
        }
        let ctx = ProviderContext {
            storage: Arc::clone(storage),
            clock: Arc::clone(clock),
            credentials: Arc::new(crate::providers::NoopCredentialGetter),
            warn_pct: crate::model::DEFAULT_WARN_PCT,
            critical_pct: crate::model::DEFAULT_CRITICAL_PCT,
        };
        let refresh_future = provider.refresh(&ctx);
        let outcome = tokio::time::timeout(
            Duration::from_secs(REFRESH_TIMEOUT_SECS),
            refresh_future,
        )
        .await;
        state.last_run.insert(id, std::time::Instant::now());
        match outcome {
            Ok(Ok(snapshots)) => {
                state.failure_count.insert(id, 0);
                per_provider.insert(id, snapshots);
            }
            Ok(Err(err)) => {
                let count = state.failure_count.entry(id).or_insert(0);
                *count = count.saturating_add(1);
                log::warn!("provider `{id}` refresh failed: {err}");
                per_provider.insert(
                    id,
                    vec![error_snapshot(
                        id,
                        provider.kind(),
                        &clock.now(),
                        format!("provider unavailable: {err}"),
                    )],
                );
            }
            Err(_) => {
                let count = state.failure_count.entry(id).or_insert(0);
                *count = count.saturating_add(1);
                log::warn!("provider `{id}` refresh timed out");
                per_provider.insert(
                    id,
                    vec![error_snapshot(
                        id,
                        provider.kind(),
                        &clock.now(),
                        "provider refresh timed out",
                    )],
                );
            }
        }
    }
    if per_provider.is_empty() {
        return;
    }
    let (combined, changed) = {
        let mut guard = latest.write().expect("latest snapshots lock poisoned");
        let prev = guard.clone();
        let next = merge_refreshed_snapshots(&prev, providers, &mut per_provider);
        let changed = !snapshots_equivalent(&prev, &next);
        *guard = next;
        (guard.clone(), changed)
    };
    // Skip the emit when nothing meaningful changed — providers refresh on a
    // 60s tick and would otherwise hand the frontend a fresh array reference
    // every cycle, re-rendering the overlay for no reason.
    if !changed {
        return;
    }
    if let Err(err) = app.emit(USAGE_UPDATED_EVENT, &combined) {
        log::warn!("emit `{USAGE_UPDATED_EVENT}` failed: {err}");
    }
}

/// Rebuild the snapshot list in provider declaration order, preferring the
/// freshly-refreshed snapshots and falling back to the previous ones for
/// providers that did not run this cycle. Doing this in one pass — rather
/// than `retain` + `extend` — keeps row positions stable on partial
/// refreshes so `snapshots_equivalent` doesn't flip-flop on unchanged data.
fn merge_refreshed_snapshots(
    prev: &[UsageSnapshot],
    providers: &[Arc<dyn UsageProvider>],
    per_provider: &mut HashMap<&'static str, Vec<UsageSnapshot>>,
) -> Vec<UsageSnapshot> {
    let mut next = Vec::with_capacity(prev.len());
    for provider in providers {
        let id = provider.id();
        if let Some(snapshots) = per_provider.remove(id) {
            next.extend(snapshots);
        } else {
            // Carry the previous snapshots for this provider forward — by
            // filtering on `provider_root_id` we keep namespaced rows like
            // `manual:<uuid>` grouped under their owning provider.
            next.extend(
                prev.iter()
                    .filter(|snap| provider_root_id(&snap.provider_id) == id)
                    .cloned(),
            );
        }
    }
    next
}

/// Compare two snapshot lists ignoring `observed_at`. That field ticks every
/// refresh even when nothing else changed, so a naive `==` would defeat the
/// change-detection guard.
fn snapshots_equivalent(a: &[UsageSnapshot], b: &[UsageSnapshot]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| {
        x.provider_id == y.provider_id
            && x.provider_kind == y.provider_kind
            && x.account_label == y.account_label
            && x.window == y.window
            && x.metric == y.metric
            && x.limit == y.limit
            && x.used == y.used
            && x.remaining == y.remaining
            && x.remaining_percent == y.remaining_percent
            && x.reset_at == y.reset_at
            && x.source == y.source
            && x.confidence == y.confidence
            && x.status == y.status
            && x.message == y.message
    })
}

/// Snapshot provider IDs may be namespaced like `manual:<uuid>`. The first
/// segment is the owning provider — used so we replace rows owned by the
/// provider that just refreshed without disturbing other providers.
fn provider_root_id(provider_id: &str) -> &str {
    provider_id.split(':').next().unwrap_or(provider_id)
}

fn effective_interval(min: Duration, failures: u32) -> Duration {
    if failures == 0 {
        return min;
    }
    let shift = failures.min(MAX_BACKOFF_SHIFT);
    let multiplier = 1u64 << shift;
    let scaled = min.saturating_mul(multiplier.try_into().unwrap_or(u32::MAX));
    let cap = Duration::from_secs(BACKOFF_CAP_SECS);
    scaled.min(cap)
}

/// Send a one-shot wake-up to the scheduler. Returns immediately even if a
/// trigger is already pending (capacity 1, `try_send` debounces).
pub fn trigger(handle: &SchedulerHandle) {
    let _ = handle.trigger_tx.try_send(());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Confidence, ProviderKind, SnapshotStatus, UsageMetric, UsageSource, UsageWindow,
    };
    use async_trait::async_trait;

    struct FakeProvider {
        id: &'static str,
        kind: ProviderKind,
    }

    #[async_trait]
    impl UsageProvider for FakeProvider {
        fn id(&self) -> &'static str {
            self.id
        }
        fn kind(&self) -> ProviderKind {
            self.kind
        }
        async fn refresh(
            &self,
            _ctx: &ProviderContext,
        ) -> anyhow::Result<Vec<UsageSnapshot>> {
            Ok(vec![])
        }
    }

    fn snap(provider_id: &str) -> UsageSnapshot {
        UsageSnapshot {
            provider_id: provider_id.to_string(),
            provider_kind: ProviderKind::Manual,
            account_label: provider_id.to_string(),
            window: UsageWindow::Unknown,
            metric: UsageMetric::Unknown,
            limit: None,
            used: None,
            remaining: None,
            remaining_percent: None,
            reset_at: None,
            observed_at: "2026-05-13T12:00:00Z".into(),
            source: UsageSource::Manual,
            confidence: Confidence::Low,
            status: SnapshotStatus::Ok,
            message: None,
        }
    }

    #[test]
    fn effective_interval_grows_then_caps() {
        let base = Duration::from_secs(60);
        assert_eq!(effective_interval(base, 0), base);
        assert_eq!(effective_interval(base, 1), Duration::from_secs(120));
        assert_eq!(effective_interval(base, 2), Duration::from_secs(240));
        assert_eq!(effective_interval(base, 3), Duration::from_secs(480));
        assert_eq!(effective_interval(base, 6), Duration::from_secs(3600));
        // Beyond the shift cap we stay at the cap.
        assert_eq!(effective_interval(base, 30), Duration::from_secs(3600));
    }

    #[test]
    fn provider_root_id_splits_on_colon() {
        assert_eq!(provider_root_id("manual:abc-uuid"), "manual");
        assert_eq!(provider_root_id("manual"), "manual");
        assert_eq!(provider_root_id("openai-api:account"), "openai-api");
    }

    #[test]
    fn merge_keeps_provider_order_on_partial_refresh() {
        // providers declared as [A, B]; only A refreshed this cycle. The
        // previous list had A's rows first, then B's. After merging the new
        // A rows must remain in front of B's untouched rows — otherwise
        // `snapshots_equivalent` flags spurious changes.
        let providers: Vec<Arc<dyn UsageProvider>> = vec![
            Arc::new(FakeProvider {
                id: "a",
                kind: ProviderKind::Manual,
            }),
            Arc::new(FakeProvider {
                id: "b",
                kind: ProviderKind::Manual,
            }),
        ];
        let prev = vec![snap("a:1"), snap("a:2"), snap("b:1")];
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> =
            HashMap::new();
        per_provider.insert("a", vec![snap("a:3")]);
        let next = merge_refreshed_snapshots(&prev, &providers, &mut per_provider);
        assert_eq!(
            next.iter().map(|s| s.provider_id.as_str()).collect::<Vec<_>>(),
            vec!["a:3", "b:1"],
        );
    }

    #[test]
    fn merge_keeps_provider_order_when_second_refreshes() {
        // Symmetric: B refreshes, A doesn't. A's rows still come first
        // because providers are declared in [A, B] order.
        let providers: Vec<Arc<dyn UsageProvider>> = vec![
            Arc::new(FakeProvider {
                id: "a",
                kind: ProviderKind::Manual,
            }),
            Arc::new(FakeProvider {
                id: "b",
                kind: ProviderKind::Manual,
            }),
        ];
        let prev = vec![snap("a:1"), snap("b:1"), snap("b:2")];
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> =
            HashMap::new();
        per_provider.insert("b", vec![snap("b:3"), snap("b:4")]);
        let next = merge_refreshed_snapshots(&prev, &providers, &mut per_provider);
        assert_eq!(
            next.iter().map(|s| s.provider_id.as_str()).collect::<Vec<_>>(),
            vec!["a:1", "b:3", "b:4"],
        );
    }

    #[test]
    fn merge_yields_identical_list_when_no_provider_refreshes() {
        // No entries in per_provider → all rows carried over unchanged.
        let providers: Vec<Arc<dyn UsageProvider>> = vec![Arc::new(FakeProvider {
            id: "a",
            kind: ProviderKind::Manual,
        })];
        let prev = vec![snap("a:1"), snap("a:2")];
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> =
            HashMap::new();
        let next = merge_refreshed_snapshots(&prev, &providers, &mut per_provider);
        assert!(snapshots_equivalent(&prev, &next));
    }

    #[test]
    fn snapshots_equivalent_ignores_observed_at() {
        let mut a = snap("a:1");
        let mut b = snap("a:1");
        a.observed_at = "2026-05-13T00:00:00Z".into();
        b.observed_at = "2026-05-14T00:00:00Z".into();
        assert!(snapshots_equivalent(&[a], &[b]));
    }

    #[test]
    fn snapshots_equivalent_detects_status_change() {
        let mut a = snap("a:1");
        let mut b = snap("a:1");
        a.status = SnapshotStatus::Ok;
        b.status = SnapshotStatus::Critical;
        assert!(!snapshots_equivalent(&[a], &[b]));
    }
}
