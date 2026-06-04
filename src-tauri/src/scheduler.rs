//! Per-provider refresh loop with exponential backoff.
//!
//! - Each provider has a minimum interval (defaults to 60s per AGENTS.md).
//! - Repeated failures (Error or NoData) that surface to the UI double the
//!   effective interval, capped at 10 minutes (`BACKOFF_CAP_SECS`).
//! - A success resets the backoff for that provider.
//! - Failures are isolated: one provider erroring out turns into an `Error`
//!   snapshot row, never a panic or a cross-provider stall.
//! - During the grace window (`GRACE_PERIOD_SECS`) the previous good rows
//!   stay on screen instead of an Error/NoData row. Backoff does NOT grow
//!   while grace is hiding the failure — otherwise the first surfaced retry
//!   after grace would land at the cap (e.g. 10 min) instead of the base
//!   interval, which contradicts the user-visible promise that recovery is
//!   prompt once the system gives up on hiding.
//! - Explicit refreshes (`refresh_now` / settings change / login flow
//!   `scheduler::trigger`) bypass grace so the user sees the current state
//!   — but the resulting Insert still feeds backoff. The startup tick is
//!   also forced (so the user doesn't wait 60s for the first row) and we
//!   want its failures to count, otherwise an app that opens into a broken
//!   provider would retry at base interval forever.
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
/// Backoff cap. Applies to both Error (Cloudflare / timeout / DOM
/// extract failure) and NoData (session expired / page returned no
/// rows). Capped at 10 minutes — beyond that the user perceives the
/// app as "stuck" and the next retry never lands soon enough to pick
/// up a freshly-resolved Cloudflare challenge or session refresh.
/// Recovery from a true session-expiry is faster than the backoff
/// suggests because `open_provider_login_window` triggers a forced
/// refresh as soon as the user lands back on the target origin.
const BACKOFF_CAP_SECS: u64 = 600;
/// Overflow guard on the shift in `effective_interval`. Strictly
/// speaking only `< 64` is needed (`1u64 << 64` is UB), but we keep it
/// well under that so `1u64 << shift` fits in `u32` for the
/// `Duration::saturating_mul` call. With the current base=60s and
/// cap=600s the cap actually clamps at `failures=4`; this constant
/// only protects against very large failure counts.
const MAX_BACKOFF_SHIFT: u32 = 4;
// Compile-time guarantee for the `as u32` cast in `effective_interval`.
const _: () = assert!(MAX_BACKOFF_SHIFT < 32);
/// 連続失敗中でも last-good snapshot を表示し続ける猶予期間。
/// この時間を超えても回復しなかった時点で、Error/NoData 行が UI に出る。
/// Grace 中は backoff を育てない (詳細はモジュール doc を参照) — grace
/// 切れ直後の最初の再試行を base interval で打てるよう保つ。
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
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn spawn(deps: SchedulerDeps) -> SchedulerHandle {
    let (trigger_tx, trigger_rx) = mpsc::channel(1);
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    tauri::async_runtime::spawn(run_loop(deps, clock, trigger_rx));
    SchedulerHandle { trigger_tx }
}

#[cfg_attr(coverage_nightly, coverage(off))]
async fn run_loop(deps: SchedulerDeps, clock: Arc<dyn Clock>, mut trigger_rx: mpsc::Receiver<()>) {
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
        &app, &providers, &latest, &clock, &mut state, /* force = */ true,
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
        refresh_once(&app, &providers, &latest, &clock, &mut state, forced).await;
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

#[cfg_attr(coverage_nightly, coverage(off))]
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
        let outcome =
            tokio::time::timeout(Duration::from_secs(REFRESH_TIMEOUT_SECS), refresh_future).await;
        // Re-sample `Instant::now()` after the await so the grace-period
        // bookkeeping reflects when *this* provider's failure was observed —
        // not when the surrounding `refresh_once` tick started. Sequential
        // provider refreshes can each block up to `REFRESH_TIMEOUT_SECS`, so
        // a single tick-start instant would shrink the grace window for any
        // provider that runs after a slow / timed-out earlier provider.
        let observed = std::time::Instant::now();
        state.last_run.insert(id, observed);
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
        let decision = apply_refresh_outcome(
            state,
            id,
            &prev_snapshots,
            &snapshots,
            force,
            observed,
            grace,
        );
        match decision {
            OutcomeDecision::CarryForward => continue,
            OutcomeDecision::Insert => {
                per_provider.insert(id, snapshots);
            }
        }
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
    let cap = Duration::from_secs(BACKOFF_CAP_SECS);
    let shift = failures.min(MAX_BACKOFF_SHIFT);
    // `MAX_BACKOFF_SHIFT < 32` (compile-time assert above) → `1u64 << shift`
    // fits in u32 without overflow → cast is lossless.
    let multiplier: u32 = 1u32 << shift;
    let scaled = min.saturating_mul(multiplier);
    // `.min(cap)` caps overall growth; `.max(min)` guarantees backoff never
    // *shortens* the interval below the provider's own floor when `min > cap`
    // (latent footgun if a future provider raises its `min_refresh_interval`
    // above 600s).
    scaled.min(cap).max(min)
}

/// この tick で当該 provider から得られた結果の分類。
/// `is_failure()` で SnapshotStatus に新 variant が追加されても
/// 分類が自動追従する (model.rs の権威 partition に委譲)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshOutcome {
    /// 1 つでも good (Ok/Warning/Critical) が含まれる、または空 vec
    /// (provider 無効化時の "rows をクリアしたい" ケース)。
    /// `failure_count` と `failing_since` をリセットする。
    Good,
    /// 全行が failure (Error/NoData)。Grace で last-good を carry forward
    /// しつつ、grace 内でも backoff は育てて vendor を保護する。
    /// 真の session 切れからの復旧は `open_provider_login_window` 経由の
    /// nav callback が force=true 強制更新を発火するので backoff には
    /// 影響されない。
    Failure,
}

fn classify_outcome(snapshots: &[UsageSnapshot]) -> RefreshOutcome {
    if snapshots.is_empty() {
        return RefreshOutcome::Good;
    }
    if snapshots.iter().all(|s| s.status.is_failure()) {
        RefreshOutcome::Failure
    } else {
        RefreshOutcome::Good
    }
}

/// `apply_refresh_outcome` の出力 — refresh_once 側で per_provider への
/// insert を行うか、prev 行を carry forward するかを示す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutcomeDecision {
    /// per_provider に snapshots を入れる (新しい行を UI に出す)。
    Insert,
    /// per_provider に入れない (merge_refreshed_snapshots が prev 行を
    /// そのまま carry forward する)。grace 中の失敗用。
    CarryForward,
}

/// Pure state-machine: tick の結果を受け取り、scheduler state を更新し、
/// per_provider への insert 判定を返す。`refresh_once` の外側 (AppHandle
/// emit / menu_bar 等) と切り離してあるので unit テストで Ok → Failure →
/// Failure → Ok のような scripted シーケンスを直接検証できる。
fn apply_refresh_outcome(
    state: &mut SchedulerState,
    id: &'static str,
    prev_snapshots: &[UsageSnapshot],
    snapshots: &[UsageSnapshot],
    force: bool,
    observed: std::time::Instant,
    grace: Duration,
) -> OutcomeDecision {
    match classify_outcome(snapshots) {
        RefreshOutcome::Good => {
            state.failure_count.insert(id, 0);
            state.failing_since.remove(id);
            OutcomeDecision::Insert
        }
        RefreshOutcome::Failure => {
            let has_prev_good = provider_has_good_snapshot(prev_snapshots, id);
            // failing_since は has_prev_good=true の時だけ anchor する。
            // prev に good 行が無い (初回 startup や provider 切替直後) 場合
            // grace 判定で使われないので、dead state を残さない。
            let since = if has_prev_good {
                Some(*state.failing_since.entry(id).or_insert(observed))
            } else {
                None
            };
            let in_grace = within_grace_period(since, observed, grace);
            // Grace 中の `continue` (= CarryForward) では backoff を育てない。
            // 理由: grace 切れ直後の最初の再試行が cap (600s) まで遅延すると、
            // 元々 grace は「ユーザーには見せないがバックグラウンドで素直に
            // 再試行する」窓だった意図に反する。Grace 外 (Insert 経路) でだけ
            // failure_count を育てて exponential backoff を成立させる。
            // Explicit refresh (force=true) も backoff には寄与しない — user
            // が能動的に retry したのを罰しない。
            if !force && has_prev_good && in_grace {
                let elapsed = since
                    .map(|s| observed.duration_since(s).as_secs())
                    .unwrap_or(0);
                log::info!(
                    "provider `{id}` within grace period ({elapsed}s / {GRACE_PERIOD_SECS}s), keeping last-good snapshot"
                );
                return OutcomeDecision::CarryForward;
            }
            // Insert 経路では failure_count を必ず育てる — force=true の経路も
            // 含む。startup tick (force=true) で失敗した時に次の auto tick が
            // base interval で打ち返したら exponential backoff の意味を失う。
            // refresh_now の連打で backoff が積もるリスクは残るが、それは
            // vendor 側の HTTP rate limit に任せるべき問題。
            let count = state.failure_count.entry(id).or_insert(0);
            *count = count.saturating_add(1);
            if !in_grace && has_prev_good {
                log::warn!("provider `{id}` grace period exceeded, surfacing failure");
            }
            OutcomeDecision::Insert
        }
    }
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
        async fn refresh(&self, _ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>> {
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
        // BACKOFF_CAP_SECS = 600 → 600s から先は cap で頭打ち。
        assert_eq!(effective_interval(base, 4), Duration::from_secs(600));
        assert_eq!(effective_interval(base, 6), Duration::from_secs(600));
        assert_eq!(effective_interval(base, 30), Duration::from_secs(600));
    }

    #[test]
    fn effective_interval_never_shorter_than_base() {
        // Latent footgun: if a future provider sets min_refresh_interval
        // above BACKOFF_CAP_SECS (e.g. 900s as a vendor-side rate-limit
        // courtesy), backoff must not silently *shorten* the wait below
        // that floor. The `.max(min)` tail enforces it.
        let big = Duration::from_secs(900);
        assert_eq!(effective_interval(big, 0), big);
        assert_eq!(effective_interval(big, 1), big);
        assert_eq!(effective_interval(big, 4), big);
        assert_eq!(effective_interval(big, 30), big);
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
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> = HashMap::new();
        per_provider.insert("a", vec![snap("a:3")]);
        let next = merge_refreshed_snapshots(&prev, &providers, &mut per_provider);
        assert_eq!(
            next.iter()
                .map(|s| s.provider_id.as_str())
                .collect::<Vec<_>>(),
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
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> = HashMap::new();
        per_provider.insert("b", vec![snap("b:3"), snap("b:4")]);
        let next = merge_refreshed_snapshots(&prev, &providers, &mut per_provider);
        assert_eq!(
            next.iter()
                .map(|s| s.provider_id.as_str())
                .collect::<Vec<_>>(),
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
        let mut per_provider: HashMap<&'static str, Vec<UsageSnapshot>> = HashMap::new();
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

    #[test]
    fn snapshots_equivalent_detects_each_observable_field_change() {
        let base = snap("a:1");
        let cases: Vec<UsageSnapshot> = vec![
            {
                let mut s = base.clone();
                s.provider_id = "a:2".into();
                s
            },
            {
                let mut s = base.clone();
                s.provider_kind = ProviderKind::WebviewChatgptCodex;
                s
            },
            {
                let mut s = base.clone();
                s.account_label = "other".into();
                s
            },
            {
                let mut s = base.clone();
                s.window = UsageWindow::Weekly;
                s
            },
            {
                let mut s = base.clone();
                s.metric = UsageMetric::Percent;
                s
            },
            {
                let mut s = base.clone();
                s.limit = Some(100);
                s
            },
            {
                let mut s = base.clone();
                s.used = Some(10);
                s
            },
            {
                let mut s = base.clone();
                s.remaining = Some(90);
                s
            },
            {
                let mut s = base.clone();
                s.remaining_percent = Some(90.0);
                s
            },
            {
                let mut s = base.clone();
                s.reset_at = Some("2026-05-13T17:00:00Z".into());
                s
            },
            {
                let mut s = base.clone();
                s.source = UsageSource::Unavailable;
                s
            },
            {
                let mut s = base.clone();
                s.confidence = Confidence::Medium;
                s
            },
            {
                let mut s = base.clone();
                s.message = Some("changed".into());
                s
            },
        ];

        for changed in cases {
            assert!(!snapshots_equivalent(
                std::slice::from_ref(&base),
                std::slice::from_ref(&changed)
            ));
        }
    }

    // ---- outcome classification ----

    #[test]
    fn classify_outcome_all_error_is_failure() {
        let snapshots = vec![snap_with_status("a:1", SnapshotStatus::Error)];
        assert_eq!(classify_outcome(&snapshots), RefreshOutcome::Failure);
    }

    #[test]
    fn classify_outcome_all_no_data_is_failure() {
        // NoData も Error と同じ Failure 扱い: backoff + grace 両方適用。
        // Session 切れからの復旧は scraper.rs の login flow callback が
        // force=true 強制更新を発火するので backoff には影響されない。
        let snapshots = vec![
            snap_with_status("a:1", SnapshotStatus::NoData),
            snap_with_status("a:2", SnapshotStatus::NoData),
        ];
        assert_eq!(classify_outcome(&snapshots), RefreshOutcome::Failure);
    }

    #[test]
    fn classify_outcome_mixed_error_and_no_data_is_failure() {
        let snapshots = vec![
            snap_with_status("a:1", SnapshotStatus::Error),
            snap_with_status("a:2", SnapshotStatus::NoData),
        ];
        assert_eq!(classify_outcome(&snapshots), RefreshOutcome::Failure);
    }

    #[test]
    fn classify_outcome_any_good_is_good() {
        // 1 行でも good (Ok/Warning/Critical) が混ざれば Good 扱い。
        for good in [
            SnapshotStatus::Ok,
            SnapshotStatus::Warning,
            SnapshotStatus::Critical,
        ] {
            let snapshots = vec![
                snap_with_status("a:1", good),
                snap_with_status("a:2", SnapshotStatus::Error),
            ];
            assert_eq!(
                classify_outcome(&snapshots),
                RefreshOutcome::Good,
                "expected Good for mix of {good:?} + Error"
            );
        }
    }

    #[test]
    fn classify_outcome_warning_only_is_good() {
        let snapshots = vec![snap_with_status("a:1", SnapshotStatus::Warning)];
        assert_eq!(classify_outcome(&snapshots), RefreshOutcome::Good);
    }

    #[test]
    fn classify_outcome_empty_is_good() {
        // Empty = provider 無効化時。"rows をクリアしたい" 用途で
        // failure_count もリセットされてほしいので Good 扱い。
        assert_eq!(classify_outcome(&[]), RefreshOutcome::Good);
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

    // ---- apply_refresh_outcome integration: state-machine sequences ----
    //
    // refresh_once は AppHandle / emit を絡めるため直接 unit テストし辛い。
    // 状態遷移の中核 (failure_count / failing_since / decision) は
    // apply_refresh_outcome に抽出してあるので、ここで scripted シーケンス
    // を流して整合性を検証する。code review findings #1-#4 と #13 の
    // regression-fix を anchor する。

    const TEST_GRACE: Duration = Duration::from_secs(600);

    fn ok_snap(id: &str) -> UsageSnapshot {
        snap_with_status(id, SnapshotStatus::Ok)
    }

    fn err_snap(id: &str) -> UsageSnapshot {
        snap_with_status(id, SnapshotStatus::Error)
    }

    fn nodata_snap(id: &str) -> UsageSnapshot {
        snap_with_status(id, SnapshotStatus::NoData)
    }

    #[test]
    fn apply_outcome_good_resets_failure_state() {
        let mut state = SchedulerState::default();
        state.failure_count.insert("a", 3);
        state.failing_since.insert("a", std::time::Instant::now());
        let prev: Vec<UsageSnapshot> = vec![];
        let snaps = vec![ok_snap("a:1")];
        let now = std::time::Instant::now();
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, false, now, TEST_GRACE);
        assert_eq!(d, OutcomeDecision::Insert);
        assert_eq!(state.failure_count.get("a").copied(), Some(0));
        assert!(!state.failing_since.contains_key("a"));
    }

    #[test]
    fn apply_outcome_failure_without_prev_good_inserts_and_skips_anchor() {
        // Startup-first-tick Error: prev は空、has_prev_good=false。
        // failing_since は anchor されない (finding #13)。
        let mut state = SchedulerState::default();
        let prev: Vec<UsageSnapshot> = vec![];
        let snaps = vec![err_snap("a:1")];
        let now = std::time::Instant::now();
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, false, now, TEST_GRACE);
        assert_eq!(d, OutcomeDecision::Insert);
        assert_eq!(state.failure_count.get("a").copied(), Some(1));
        assert!(
            !state.failing_since.contains_key("a"),
            "failing_since anchor を has_prev_good=false で残してはいけない"
        );
    }

    #[test]
    fn apply_outcome_failure_with_prev_good_carries_forward_under_grace() {
        // Good → Error sequence。prev に Ok があるので grace 発火、
        // OutcomeDecision::CarryForward が返る。
        let mut state = SchedulerState::default();
        let prev = vec![ok_snap("a:1")];
        let snaps = vec![err_snap("a:1")];
        let now = std::time::Instant::now();
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, false, now, TEST_GRACE);
        assert_eq!(d, OutcomeDecision::CarryForward);
        assert_eq!(
            state.failure_count.get("a").copied(),
            None,
            "grace 中 (CarryForward) は backoff を育てない — \
             grace 切れ直後の最初の retry が base interval で打てる必要がある"
        );
        assert!(state.failing_since.contains_key("a"));
    }

    #[test]
    fn apply_outcome_force_bypasses_grace_inserts() {
        // refresh_now (force=true) は grace を bypass、Insert に倒す。
        let mut state = SchedulerState::default();
        let prev = vec![ok_snap("a:1")];
        let snaps = vec![err_snap("a:1")];
        let now = std::time::Instant::now();
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, true, now, TEST_GRACE);
        assert_eq!(d, OutcomeDecision::Insert);
        assert_eq!(
            state.failure_count.get("a").copied(),
            // force=true でも Insert (grace bypass) すれば backoff は育てる。
            // 起動 tick の Failure を仮に放置すると、次回 auto tick が base
            // interval で打ち返してしまい exponential backoff の意味を失う。
            Some(1),
            "force=true でも Insert なら failure_count を育てる"
        );
    }

    #[test]
    fn apply_outcome_failure_after_grace_window_surfaces() {
        // failing_since が grace 期間を超えた状態で再度 Failure → Insert。
        // anchor は or_insert で no-op、original の時点に維持される。
        let mut state = SchedulerState::default();
        // Forward-walking arithmetic to avoid `Instant - Duration` underflow on
        // freshly-booted CI hosts where the monotonic clock origin is small.
        let started = std::time::Instant::now();
        let now = started + TEST_GRACE + Duration::from_secs(1);
        state.failing_since.insert("a", started);
        state.failure_count.insert("a", 5);
        let prev = vec![ok_snap("a:1")];
        let snaps = vec![err_snap("a:1")];
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, false, now, TEST_GRACE);
        assert_eq!(d, OutcomeDecision::Insert);
        assert_eq!(state.failure_count.get("a").copied(), Some(6));
        assert_eq!(
            state.failing_since.get("a").copied(),
            Some(started),
            "or_insert は anchor を再書き込みしない — original t0 を維持"
        );
    }

    #[test]
    fn apply_outcome_nodata_treated_like_error_under_grace() {
        // Finding #1 regression-fix: NoData も Failure 扱いなので、prev に
        // Good があれば grace で carry forward される。NoData が prev Ok
        // を破壊しない。
        let mut state = SchedulerState::default();
        let prev = vec![ok_snap("a:1")];
        let snaps = vec![nodata_snap("a:1")];
        let now = std::time::Instant::now();
        let d = apply_refresh_outcome(&mut state, "a", &prev, &snaps, false, now, TEST_GRACE);
        assert_eq!(
            d,
            OutcomeDecision::CarryForward,
            "NoData も grace の対象 — prev Ok を carry forward"
        );
        // CarryForward 中は backoff を育てない (grace 切れ後の最初の retry
        // を base interval で打てるよう保つ)。
        assert_eq!(state.failure_count.get("a").copied(), None);
    }

    #[test]
    fn apply_outcome_error_then_nodata_does_not_reset_failing_since() {
        // Finding #3 regression-fix: Error → NoData → Error で grace clock
        // が re-anchor されてはいけない。両方 Failure 扱いなので failing_since
        // は最初の Error 時点のまま維持される。
        let mut state = SchedulerState::default();
        let prev = vec![ok_snap("a:1")];
        let t0 = std::time::Instant::now();
        // Tick1 Error: anchor at t0
        apply_refresh_outcome(
            &mut state,
            "a",
            &prev,
            &vec![err_snap("a:1")],
            false,
            t0,
            TEST_GRACE,
        );
        let anchored_at = *state
            .failing_since
            .get("a")
            .expect("failing_since anchored");
        // Tick2 NoData: prev に Ok があれば CarryForward。anchor は維持される。
        let t1 = t0 + Duration::from_secs(60);
        let d = apply_refresh_outcome(
            &mut state,
            "a",
            &prev,
            &vec![nodata_snap("a:1")],
            false,
            t1,
            TEST_GRACE,
        );
        assert_eq!(d, OutcomeDecision::CarryForward);
        assert_eq!(
            state.failing_since.get("a").copied(),
            Some(anchored_at),
            "NoData が failing_since を re-anchor してはいけない"
        );
        // Tick3 Error: anchor は依然 t0、grace clock は 120s 経過
        let t2 = t0 + Duration::from_secs(120);
        apply_refresh_outcome(
            &mut state,
            "a",
            &prev,
            &vec![err_snap("a:1")],
            false,
            t2,
            TEST_GRACE,
        );
        assert_eq!(
            state.failing_since.get("a").copied(),
            Some(anchored_at),
            "3 回目 Failure でも anchor は最初の Error 時点のまま"
        );
        // 全 3 tick とも CarryForward (in_grace) なので failure_count は 0 のまま。
        assert_eq!(state.failure_count.get("a").copied(), None);
    }

    #[test]
    fn apply_outcome_recovery_resets_to_base_interval() {
        // 連続失敗で failure_count が 5 まで育った後、Good で 0 リセット。
        let mut state = SchedulerState::default();
        state.failure_count.insert("a", 5);
        state.failing_since.insert("a", std::time::Instant::now());
        let prev = vec![ok_snap("a:1")];
        let snaps = vec![ok_snap("a:1")];
        let d = apply_refresh_outcome(
            &mut state,
            "a",
            &prev,
            &snaps,
            false,
            std::time::Instant::now(),
            TEST_GRACE,
        );
        assert_eq!(d, OutcomeDecision::Insert);
        assert_eq!(state.failure_count.get("a").copied(), Some(0));
        assert!(!state.failing_since.contains_key("a"));
    }
}
