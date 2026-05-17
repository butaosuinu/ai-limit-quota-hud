//! Per-provider refresh loop with exponential backoff.
//!
//! - Each provider has a minimum interval (defaults to 60s per AGENTS.md;
//!   WebView providers raise that to a 300s floor / 600s default per spec §8).
//! - Repeated failures double the effective interval, capped at 1 hour.
//! - A success resets the backoff for that provider.
//! - Failures are isolated: one provider erroring out turns into an `Error`
//!   snapshot row, never a panic or a cross-provider stall.
//! - `trigger_tx.try_send(())` debounces explicit triggers (channel capacity = 1).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::model::{error_snapshot, UsageSnapshot};
use crate::providers::{Clock, ProviderContext, SystemClock, UsageProvider};
use crate::state::USAGE_UPDATED_EVENT;

// Must exceed `scraper::DEFAULT_REFRESH_TIMEOUT` (25 s) so a slow but
// successful WebView extract isn't cancelled into a false failure that
// triggers exponential backoff.
const REFRESH_TIMEOUT_SECS: u64 = 30;
const BACKOFF_CAP_SECS: u64 = 3600;
const MAX_BACKOFF_SHIFT: u32 = 6;
/// 連続失敗中でも last-good snapshot を表示し続ける猶予期間。
/// この時間を超えても回復しなかった時点で、従来通り Error/NoData 行が UI
/// に出る。Backoff (`BACKOFF_CAP_SECS`) より十分短く取ってあり、grace 内
/// に複数回の再試行チャンスがある関係を維持する。
const GRACE_PERIOD_SECS: u64 = 600;

/// Handle held by the rest of the app — lets commands wake the scheduler
/// immediately after a settings change or explicit refresh request.
pub struct SchedulerHandle {
    pub trigger_tx: mpsc::Sender<()>,
}

pub struct SchedulerDeps {
    pub app: AppHandle,
    pub providers: Vec<Arc<dyn UsageProvider>>,
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
        latest,
        interval_seconds,
    } = deps;
    if providers.is_empty() {
        // Keep the handle alive so `trigger` calls don't error out, but skip
        // the timer loop entirely — there is nothing to refresh.
        while trigger_rx.recv().await.is_some() {}
        return;
    }
    let mut state = SchedulerState::default();
    // Tick once immediately so a fresh app shows snapshots without waiting
    // 60 seconds for the first interval to elapse.
    refresh_once(
        &app,
        &providers,
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
                // Explicit triggers (settings changes, refresh_now) must
                // bypass the per-provider throttle so the next tick is
                // immediate.
                state.force_next = true;
            }
        }
        let forced = state.consume_force_flag();
        refresh_once(
            &app,
            &providers,
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
    /// その provider が連続失敗を始めた時刻。Grace period の起点として使う。
    /// 成功で取れた瞬間に削除される。
    failing_since: HashMap<&'static str, std::time::Instant>,
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
    latest: &Arc<RwLock<Vec<UsageSnapshot>>>,
    clock: &Arc<dyn Clock>,
    state: &mut SchedulerState,
    force: bool,
) {
    let now = std::time::Instant::now();
    // Snapshot the previous `latest` once at the top of the tick — only this
    // function writes to `latest`, so the value won't change underneath us.
    // Reused for both the grace-period check (do we still have a good snapshot
    // to fall back on?) and the merge below.
    let prev_snapshots: Vec<UsageSnapshot> = {
        let guard = latest.read().expect("latest snapshots lock poisoned");
        guard.clone()
    };
    let grace = Duration::from_secs(GRACE_PERIOD_SECS);
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
            clock: Arc::clone(clock),
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
        // Normalize every failure shape into a `Vec<UsageSnapshot>` so the
        // grace-period decision below can treat them uniformly. WebView
        // providers already wrap their failures in `Ok(vec![error_snapshot])`
        // — the explicit `Err` arms here cover the trait surface for any
        // future provider that returns errors directly.
        let now_ts = clock.now();
        let mk_error = |msg: String| vec![error_snapshot(id, provider.kind(), &now_ts, msg)];
        let snapshots = match outcome {
            Ok(Ok(s)) => s,
            Ok(Err(err)) => {
                log::warn!("provider `{id}` refresh failed: {err}");
                mk_error(format!("provider unavailable: {err}"))
            }
            Err(_) => {
                log::warn!("provider `{id}` refresh timed out");
                mk_error("provider refresh timed out".into())
            }
        };
        if should_apply_grace(&snapshots) {
            let since = *state.failing_since.entry(id).or_insert(now);
            let has_prev_good = provider_has_good_snapshot(&prev_snapshots, id);
            let in_grace = within_grace_period(Some(since), now, grace);
            // Explicit refresh (refresh_now / settings change) bypasses grace
            // so the user sees the actual current state rather than stale data.
            if !force && has_prev_good && in_grace {
                let elapsed = now.duration_since(since).as_secs();
                log::info!(
                    "provider `{id}` within grace period ({elapsed}s / {GRACE_PERIOD_SECS}s), keeping last-good snapshot"
                );
                // Skip per_provider insert → merge_refreshed_snapshots carries
                // forward the prev rows for this provider unchanged.
                continue;
            }
            // Grace exhausted (or never qualified): increment failure count so
            // exponential backoff kicks in for subsequent ticks, and surface
            // the failure snapshot to the UI.
            if !in_grace && has_prev_good {
                log::warn!("provider `{id}` grace period exceeded, surfacing failure");
            }
            let count = state.failure_count.entry(id).or_insert(0);
            *count = count.saturating_add(1);
        } else {
            state.failure_count.insert(id, 0);
            state.failing_since.remove(id);
        }
        per_provider.insert(id, snapshots);
    }
    if per_provider.is_empty() {
        return;
    }
    let (combined, changed) = {
        let mut guard = latest.write().expect("latest snapshots lock poisoned");
        // `prev_snapshots` captured at the top of the tick is still authoritative
        // here because this function is the sole writer of `latest` — reuse it
        // instead of cloning the guard a second time.
        let next = merge_refreshed_snapshots(&prev_snapshots, providers, &mut per_provider);
        let changed = !snapshots_equivalent(&prev_snapshots, &next);
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
    crate::menu_bar::refresh_tray_title(app, &combined);
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
            // `webview-claude-ai:<account>` grouped under their owning provider.
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

/// Snapshot provider IDs may be namespaced like `webview-claude-ai:<account>`.
/// The first segment is the owning provider — used so we replace rows owned
/// by the provider that just refreshed without disturbing other providers.
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

/// 結果 vec が「全て Error / NoData で構成されており、grace 判定の対象」か。
/// 空 vec (provider 無効化時) は false を返す — 従来通り prev rows を削除
/// したいので grace は適用しない。
fn should_apply_grace(snapshots: &[UsageSnapshot]) -> bool {
    !snapshots.is_empty() && snapshots.iter().all(|s| s.status.is_failure())
}

/// prev snapshots に、当該 provider の「good」(Ok / Warning / Critical) 行
/// が 1 つでも残っているか。namespaced provider_id (`webview-claude-ai:default`
/// など) は root 部分で照合する。
fn provider_has_good_snapshot(prev: &[UsageSnapshot], provider_id: &str) -> bool {
    prev.iter()
        .any(|s| provider_root_id(&s.provider_id) == provider_id && s.status.is_good())
}

/// `failing_since` から `now` までの経過時間が `grace` 未満か。
/// 境界は strict less-than: 経過時間がちょうど grace に到達した瞬間に false。
fn within_grace_period(
    failing_since: Option<std::time::Instant>,
    now: std::time::Instant,
    grace: Duration,
) -> bool {
    match failing_since {
        Some(start) => now.duration_since(start) < grace,
        None => false,
    }
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
        snap_with_status(provider_id, SnapshotStatus::Ok)
    }

    fn snap_with_status(provider_id: &str, status: SnapshotStatus) -> UsageSnapshot {
        UsageSnapshot {
            provider_id: provider_id.to_string(),
            provider_kind: ProviderKind::WebviewClaudeAi,
            account_label: provider_id.to_string(),
            window: UsageWindow::Unknown,
            metric: UsageMetric::Unknown,
            limit: None,
            used: None,
            remaining: None,
            remaining_percent: None,
            reset_at: None,
            observed_at: "2026-05-13T12:00:00Z".into(),
            source: UsageSource::WebviewScrape,
            confidence: Confidence::Low,
            status,
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
        assert_eq!(
            provider_root_id("webview-claude-ai:default"),
            "webview-claude-ai"
        );
        assert_eq!(provider_root_id("webview-claude-ai"), "webview-claude-ai");
        assert_eq!(
            provider_root_id("webview-chatgpt-codex:work"),
            "webview-chatgpt-codex"
        );
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
                kind: ProviderKind::WebviewClaudeAi,
            }),
            Arc::new(FakeProvider {
                id: "b",
                kind: ProviderKind::WebviewChatgptCodex,
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
                kind: ProviderKind::WebviewClaudeAi,
            }),
            Arc::new(FakeProvider {
                id: "b",
                kind: ProviderKind::WebviewChatgptCodex,
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
            kind: ProviderKind::WebviewClaudeAi,
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

    // ---- grace period helpers ----

    #[test]
    fn should_apply_grace_true_when_all_error() {
        let snapshots = vec![snap_with_status("a:1", SnapshotStatus::Error)];
        assert!(should_apply_grace(&snapshots));
    }

    #[test]
    fn should_apply_grace_true_when_all_no_data() {
        let snapshots = vec![
            snap_with_status("a:1", SnapshotStatus::NoData),
            snap_with_status("a:2", SnapshotStatus::NoData),
        ];
        assert!(should_apply_grace(&snapshots));
    }

    #[test]
    fn should_apply_grace_true_when_mixed_error_and_no_data() {
        let snapshots = vec![
            snap_with_status("a:1", SnapshotStatus::Error),
            snap_with_status("a:2", SnapshotStatus::NoData),
        ];
        assert!(should_apply_grace(&snapshots));
    }

    #[test]
    fn should_apply_grace_false_when_any_ok() {
        // One Ok in the bunch means the provider has *some* data — don't carry
        // forward stale rows, surface what we just got.
        let snapshots = vec![
            snap_with_status("a:1", SnapshotStatus::Ok),
            snap_with_status("a:2", SnapshotStatus::Error),
        ];
        assert!(!should_apply_grace(&snapshots));
    }

    #[test]
    fn should_apply_grace_false_when_empty() {
        // Empty = provider disabled (or never produced anything). Preserve
        // the existing "clear my rows" behavior — do not enter grace.
        assert!(!should_apply_grace(&[]));
    }

    #[test]
    fn provider_has_good_filters_by_root_id() {
        let prev = vec![
            snap_with_status("webview-claude-ai:default", SnapshotStatus::Ok),
            snap_with_status("webview-chatgpt-codex:default", SnapshotStatus::Ok),
        ];
        assert!(provider_has_good_snapshot(&prev, "webview-claude-ai"));
        assert!(provider_has_good_snapshot(&prev, "webview-chatgpt-codex"));
        assert!(!provider_has_good_snapshot(&prev, "webview-unknown"));
    }

    #[test]
    fn provider_has_good_ignores_error_and_no_data() {
        let prev = vec![
            snap_with_status("a:1", SnapshotStatus::Error),
            snap_with_status("a:2", SnapshotStatus::NoData),
        ];
        assert!(!provider_has_good_snapshot(&prev, "a"));
    }

    #[test]
    fn provider_has_good_true_for_ok_warning_critical() {
        for status in [
            SnapshotStatus::Ok,
            SnapshotStatus::Warning,
            SnapshotStatus::Critical,
        ] {
            let prev = vec![snap_with_status("a:1", status)];
            assert!(
                provider_has_good_snapshot(&prev, "a"),
                "expected `a` to be good for status {status:?}"
            );
        }
    }

    #[test]
    fn within_grace_false_when_failing_since_none() {
        let now = std::time::Instant::now();
        assert!(!within_grace_period(None, now, Duration::from_secs(600)));
    }

    #[test]
    fn within_grace_true_just_before_expiry() {
        let start = std::time::Instant::now();
        let grace = Duration::from_secs(600);
        let now = start + grace - Duration::from_millis(1);
        assert!(within_grace_period(Some(start), now, grace));
    }

    #[test]
    fn within_grace_false_at_exact_expiry() {
        // strict `<` comparison: hitting the boundary is no longer "within".
        let start = std::time::Instant::now();
        let grace = Duration::from_secs(600);
        let now = start + grace;
        assert!(!within_grace_period(Some(start), now, grace));
    }

    #[test]
    fn within_grace_false_after_expiry() {
        let start = std::time::Instant::now();
        let grace = Duration::from_secs(600);
        let now = start + grace + Duration::from_secs(1);
        assert!(!within_grace_period(Some(start), now, grace));
    }
}
