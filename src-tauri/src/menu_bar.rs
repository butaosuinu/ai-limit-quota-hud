//! macOS menu bar (NSStatusItem) summary text composition + tray binding.
//!
//! Tauri's `TrayIcon::set_title()` shows text next to the tray icon on macOS
//! / Linux (no-op on Windows). We surface only the short 5h limit for Claude
//! and Codex so the menu bar stays narrow; weekly limits and other providers
//! stay in the overlay.

use tauri::{AppHandle, Manager};

use crate::model::{ProviderKind, SnapshotStatus, UsageSnapshot, UsageWindow};
use crate::settings::{MenuBarSummaryMode, OverlaySettings};

const JOIN_SEP: &str = " · ";
const MISSING: &str = "--";

/// Providers surfaced in the menu bar, in display order. Adding ChatGPT
/// (non-Codex) or another provider later means appending here.
const MENU_BAR_PROVIDERS: &[(ProviderKind, &str)] = &[
    (ProviderKind::WebviewClaudeAi, "Claude"),
    (ProviderKind::WebviewChatgptCodex, "Codex"),
];

/// Refresh the menu bar (NSStatusItem) title for the current overlay
/// settings and the given snapshot list. Caller passes the snapshots so
/// the scheduler can reuse the list it already cloned; we only re-read
/// settings since they're light and might have changed in between.
pub fn refresh_tray_title(app: &AppHandle, snapshots: &[UsageSnapshot]) {
    let settings = app
        .try_state::<crate::AppState>()
        .map(|state| state.snapshot())
        .unwrap_or_default();
    let Some(tray) = app.tray_by_id(crate::TRAY_ICON_ID) else {
        return;
    };
    let title = compute_menu_bar_title(snapshots, &settings);
    if let Err(err) = tray.set_title(title) {
        log::warn!("failed to set tray title: {err}");
    }
}

/// Compose the menu bar title for the given snapshots + settings. Returns
/// `None` when the mode says we should not display anything (either
/// disabled, or `WhenHidden` while the overlay is visible) or when no
/// relevant snapshot exists.
pub fn compute_menu_bar_title(
    snapshots: &[UsageSnapshot],
    settings: &OverlaySettings,
) -> Option<String> {
    if !mode_active(settings) {
        return None;
    }

    let parts: Vec<String> = MENU_BAR_PROVIDERS
        .iter()
        .filter_map(|(kind, label)| {
            pick_snapshot(snapshots, *kind)
                .map(|snap| format!("{label} {}", format_percent(snap)))
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(JOIN_SEP))
    }
}

/// Prefer the 5h limit row for the requested provider, then fall back to a
/// provider-level failure row (Error / NoData with window=Unknown) so login
/// timeouts, Cloudflare challenges, and extractor crashes still surface as
/// `--` instead of vanishing from the title. The fallback is intentionally
/// scoped to `Unknown` windows so a weekly NoData row doesn't bubble up.
fn pick_snapshot(snapshots: &[UsageSnapshot], kind: ProviderKind) -> Option<&UsageSnapshot> {
    let owned_by = |s: &&UsageSnapshot| s.provider_kind == kind;
    snapshots
        .iter()
        .find(|s| owned_by(s) && s.window == UsageWindow::FiveHours)
        .or_else(|| {
            snapshots
                .iter()
                .find(|s| owned_by(s) && s.window == UsageWindow::Unknown && s.status.is_failure())
        })
}

fn mode_active(settings: &OverlaySettings) -> bool {
    match settings.menu_bar_summary {
        MenuBarSummaryMode::Off => false,
        MenuBarSummaryMode::Always => true,
        MenuBarSummaryMode::WhenHidden => !settings.visible,
    }
}

fn format_percent(snapshot: &UsageSnapshot) -> String {
    if snapshot.status.is_failure() {
        return MISSING.to_string();
    }
    match snapshot.remaining_percent {
        Some(pct) if pct.is_finite() => format!("{}%", pct.round() as i64),
        _ => MISSING.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Confidence, UsageMetric, UsageSource};

    fn snap(
        kind: ProviderKind,
        window: UsageWindow,
        pct: Option<f64>,
        status: SnapshotStatus,
    ) -> UsageSnapshot {
        UsageSnapshot {
            provider_id: "test".into(),
            provider_kind: kind,
            account_label: "test".into(),
            window,
            metric: UsageMetric::Percent,
            limit: None,
            used: None,
            remaining: None,
            remaining_percent: pct,
            reset_at: None,
            observed_at: "2026-05-17T00:00:00Z".into(),
            source: UsageSource::WebviewScrape,
            confidence: Confidence::Low,
            status,
            message: None,
        }
    }

    fn settings_with(mode: MenuBarSummaryMode, visible: bool) -> OverlaySettings {
        let mut s = OverlaySettings::default();
        s.menu_bar_summary = mode;
        s.visible = visible;
        s
    }

    #[test]
    fn off_mode_returns_none_even_with_snapshots() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::FiveHours,
            Some(42.0),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Off, false)),
            None
        );
    }

    #[test]
    fn when_hidden_returns_none_while_visible() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::FiveHours,
            Some(42.0),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(
                &snaps,
                &settings_with(MenuBarSummaryMode::WhenHidden, true)
            ),
            None
        );
    }

    #[test]
    fn when_hidden_returns_text_while_hidden() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::FiveHours,
            Some(42.0),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(
                &snaps,
                &settings_with(MenuBarSummaryMode::WhenHidden, false)
            )
            .as_deref(),
            Some("Claude 42%")
        );
    }

    #[test]
    fn always_mode_returns_text_regardless_of_visibility() {
        let snaps = vec![snap(
            ProviderKind::WebviewChatgptCodex,
            UsageWindow::FiveHours,
            Some(87.0),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Codex 87%")
        );
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, false))
                .as_deref(),
            Some("Codex 87%")
        );
    }

    #[test]
    fn weekly_snapshots_are_filtered_out() {
        let snaps = vec![
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::Weekly,
                Some(50.0),
                SnapshotStatus::Ok,
            ),
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::FiveHours,
                Some(42.0),
                SnapshotStatus::Ok,
            ),
        ];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude 42%")
        );
    }

    #[test]
    fn returns_none_when_only_unsupported_windows_present() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::Weekly,
            Some(50.0),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true)),
            None
        );
    }

    #[test]
    fn claude_and_codex_joined_in_stable_order() {
        // Even if Codex is first in the input, Claude must precede Codex.
        let snaps = vec![
            snap(
                ProviderKind::WebviewChatgptCodex,
                UsageWindow::FiveHours,
                Some(87.0),
                SnapshotStatus::Ok,
            ),
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::FiveHours,
                Some(42.0),
                SnapshotStatus::Ok,
            ),
        ];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude 42% · Codex 87%")
        );
    }

    #[test]
    fn error_status_renders_as_missing_marker() {
        let snaps = vec![
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::FiveHours,
                None,
                SnapshotStatus::Error,
            ),
            snap(
                ProviderKind::WebviewChatgptCodex,
                UsageWindow::FiveHours,
                Some(87.0),
                SnapshotStatus::Ok,
            ),
        ];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude -- · Codex 87%")
        );
    }

    #[test]
    fn no_data_status_renders_as_missing_marker() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::FiveHours,
            None,
            SnapshotStatus::NoData,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude --")
        );
    }

    #[test]
    fn provider_level_error_unknown_window_renders_as_missing_marker() {
        // scheduler / claude_web emit a single error_snapshot with
        // window=Unknown when the provider as a whole fails (login expired,
        // Cloudflare, timeout). The fallback must catch this so the title
        // shows `Claude --` instead of disappearing entirely.
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::Unknown,
            None,
            SnapshotStatus::Error,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude --")
        );
    }

    #[test]
    fn provider_level_no_data_unknown_window_renders_as_missing_marker() {
        // `LoggedOut` paths emit no_data_snapshot with window=Unknown.
        let snaps = vec![snap(
            ProviderKind::WebviewChatgptCodex,
            UsageWindow::Unknown,
            None,
            SnapshotStatus::NoData,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Codex --")
        );
    }

    #[test]
    fn five_hours_takes_precedence_over_unknown_failure_for_same_provider() {
        // Defensive: in case both shapes ever appear in the same list,
        // the real 5h reading wins over a stale provider-level failure.
        let snaps = vec![
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::Unknown,
                None,
                SnapshotStatus::Error,
            ),
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::FiveHours,
                Some(42.0),
                SnapshotStatus::Ok,
            ),
        ];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude 42%")
        );
    }

    #[test]
    fn provider_failure_mixed_with_other_provider_success() {
        // Most common real-world failure mode: one provider is logged in
        // and reporting normally while the other was just kicked out.
        let snaps = vec![
            snap(
                ProviderKind::WebviewClaudeAi,
                UsageWindow::Unknown,
                None,
                SnapshotStatus::NoData,
            ),
            snap(
                ProviderKind::WebviewChatgptCodex,
                UsageWindow::FiveHours,
                Some(87.0),
                SnapshotStatus::Ok,
            ),
        ];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude -- · Codex 87%")
        );
    }

    #[test]
    fn weekly_no_data_does_not_trigger_fallback() {
        // A NoData row on the weekly window is not a provider-level
        // failure — overlay surfaces it; the menu bar should ignore it.
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::Weekly,
            None,
            SnapshotStatus::NoData,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true)),
            None
        );
    }

    #[test]
    fn percent_is_rounded_to_nearest_integer() {
        let snaps = vec![snap(
            ProviderKind::WebviewClaudeAi,
            UsageWindow::FiveHours,
            Some(42.7),
            SnapshotStatus::Ok,
        )];
        assert_eq!(
            compute_menu_bar_title(&snaps, &settings_with(MenuBarSummaryMode::Always, true))
                .as_deref(),
            Some("Claude 43%")
        );
    }

    #[test]
    fn empty_snapshot_list_returns_none() {
        assert_eq!(
            compute_menu_bar_title(&[], &settings_with(MenuBarSummaryMode::Always, true)),
            None
        );
    }
}
