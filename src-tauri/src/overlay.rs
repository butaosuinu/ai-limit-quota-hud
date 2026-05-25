//! Overlay window helpers: push settings into the Tauri window and broadcast
//! changes to the frontend. Opacity and compact mode are CSS-driven, so they
//! ride the `settings-changed` event rather than being set from Rust.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

use crate::settings::{OverlayCorner, OverlaySettings, Position};

pub const OVERLAY_WINDOW_LABEL: &str = "overlay";
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
pub const SETTINGS_CHANGED_EVENT: &str = "overlay://settings-changed";

#[derive(Debug, Clone, Serialize)]
struct SettingsPayload<'a> {
    settings: &'a OverlaySettings,
}

/// Apply the window-controllable bits of `settings` to the overlay window.
/// Returns the position the window is expected to land on (if any) so the
/// caller can filter the programmatic `WindowEvent::Moved` from a real user
/// drag. Importantly, the expectation is reported even when `set_position`
/// was skipped (window already at the target): a Moved event from an earlier
/// `set_position` may still be in flight, and clearing the expectation would
/// cause it to be misread as a user drag.
#[cfg_attr(coverage_nightly, coverage(off))]
pub fn apply_to_window(window: &WebviewWindow, settings: &OverlaySettings) -> Option<Position> {
    let _ = window.set_always_on_top(settings.always_on_top);
    let _ = window.set_ignore_cursor_events(settings.click_through);

    let target = resolve_target_position(window, settings);
    if let Some(p) = target {
        let already_there = window
            .outer_position()
            .ok()
            .is_some_and(|cur| cur.x == p.x && cur.y == p.y);
        if !already_there {
            let _ = window.set_position(PhysicalPosition { x: p.x, y: p.y });
        }
    }

    if settings.visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }

    target
}

/// Decide where the overlay should land. A saved `position` is honored only
/// when it's still on a connected monitor — a position carried over from an
/// unplugged display or higher resolution would otherwise leave the overlay
/// stranded off-screen with no obvious way to recover.
#[cfg_attr(coverage_nightly, coverage(off))]
fn resolve_target_position(window: &WebviewWindow, settings: &OverlaySettings) -> Option<Position> {
    if let Some(saved) = settings.position {
        if position_visible_on_any_monitor(window, saved) {
            return Some(saved);
        }
        log::info!(
            "saved overlay position ({}, {}) is off-screen; falling back to corner",
            saved.x,
            saved.y
        );
    }
    corner_position(window, settings)
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn position_visible_on_any_monitor(window: &WebviewWindow, position: Position) -> bool {
    let monitors = match window.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        // No monitor info — be permissive so we don't refuse a perfectly fine
        // position on a platform where this API misbehaves.
        _ => return true,
    };
    let Ok(window_size) = window.outer_size() else {
        return true;
    };
    let window_rect = (
        position.x,
        position.y,
        window_size.width,
        window_size.height,
    );
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        rects_overlap(window_rect, (pos.x, pos.y, size.width, size.height))
    })
}

/// Standard rect-overlap test on half-open `[origin, origin+size)` rectangles.
/// Used to accept saved overlay positions that are still partially visible
/// (e.g. `x = -10` on a single monitor) instead of snapping them to a corner.
fn rects_overlap(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> bool {
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    let a_right = ax.saturating_add(u32_to_i32_saturating(aw));
    let a_bottom = ay.saturating_add(u32_to_i32_saturating(ah));
    let b_right = bx.saturating_add(u32_to_i32_saturating(bw));
    let b_bottom = by.saturating_add(u32_to_i32_saturating(bh));
    ax < b_right && a_right > bx && ay < b_bottom && a_bottom > by
}

/// Saturating `u32 → i32` for window/monitor dimensions that exceed `i32::MAX`
/// (vanishingly rare but possible on virtual desktops spanning many monitors).
fn u32_to_i32_saturating(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

#[cfg_attr(coverage_nightly, coverage(off))]
fn corner_position(window: &WebviewWindow, settings: &OverlaySettings) -> Option<Position> {
    let monitor = window.current_monitor().ok().flatten()?;
    let monitor_size = monitor.size();
    let window_size = window.outer_size().ok()?;
    let margin_x = settings.margin_x.max(0);
    let margin_y = settings.margin_y.max(0);
    let max_x = u32_to_i32_saturating(monitor_size.width)
        .saturating_sub(u32_to_i32_saturating(window_size.width))
        .saturating_sub(margin_x)
        .max(margin_x);
    let max_y = u32_to_i32_saturating(monitor_size.height)
        .saturating_sub(u32_to_i32_saturating(window_size.height))
        .saturating_sub(margin_y)
        .max(margin_y);
    let monitor_pos = monitor.position();

    let (x, y) = match settings.corner {
        OverlayCorner::TopLeft => (margin_x, margin_y),
        OverlayCorner::TopRight => (max_x, margin_y),
        OverlayCorner::BottomLeft => (margin_x, max_y),
        OverlayCorner::BottomRight => (max_x, max_y),
    };

    Some(Position {
        x: monitor_pos.x + x,
        y: monitor_pos.y + y,
    })
}

#[cfg_attr(coverage_nightly, coverage(off))]
pub fn emit_settings_changed(app: &AppHandle, settings: &OverlaySettings) {
    let payload = SettingsPayload { settings };
    if let Err(err) = app.emit(SETTINGS_CHANGED_EVENT, payload) {
        log::warn!("failed to emit settings-changed event: {err}");
    }
}

#[cfg_attr(coverage_nightly, coverage(off))]
pub fn overlay_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(OVERLAY_WINDOW_LABEL).or_else(|| {
        log::warn!("overlay window is missing");
        None
    })
}

#[cfg_attr(coverage_nightly, coverage(off))]
pub fn settings_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(SETTINGS_WINDOW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::rects_overlap;
    use crate::settings::clamp_opacity;

    const MONITOR_1080P: (i32, i32, u32, u32) = (0, 0, 1920, 1080);
    const OVERLAY: (u32, u32) = (340, 180);

    fn window(x: i32, y: i32) -> (i32, i32, u32, u32) {
        (x, y, OVERLAY.0, OVERLAY.1)
    }

    #[test]
    fn clamp_keeps_visible_floor() {
        assert!(clamp_opacity(-1.0) >= 0.15);
    }

    #[test]
    fn clamp_keeps_visible_ceiling() {
        assert!((clamp_opacity(2.0) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn overlap_accepts_fully_inside() {
        assert!(rects_overlap(window(100, 100), MONITOR_1080P));
    }

    #[test]
    fn overlap_accepts_origin_anchor() {
        assert!(rects_overlap(window(0, 0), MONITOR_1080P));
    }

    #[test]
    fn overlap_accepts_partial_left_off_screen() {
        // The user-reported regression case: a -10 px nudge off the left edge
        // is still mostly visible and must be honored.
        assert!(rects_overlap(window(-10, 100), MONITOR_1080P));
    }

    #[test]
    fn overlap_accepts_partial_top_off_screen() {
        assert!(rects_overlap(window(500, -20), MONITOR_1080P));
    }

    #[test]
    fn overlap_rejects_fully_off_left() {
        // Window's right edge is still < monitor's left → no overlap.
        assert!(!rects_overlap(window(-400, 100), MONITOR_1080P));
    }

    #[test]
    fn overlap_rejects_fully_off_right() {
        assert!(!rects_overlap(window(1920, 100), MONITOR_1080P));
    }

    #[test]
    fn overlap_rejects_flush_right_edge() {
        // half-open semantics: a 0-width touch at the boundary doesn't overlap.
        assert!(!rects_overlap((1920, 100, 0, OVERLAY.1), MONITOR_1080P));
    }

    #[test]
    fn overlap_handles_right_sidecar_monitor() {
        let right_monitor = (1920, 0, 1280_u32, 800_u32);
        assert!(rects_overlap(window(2500, 200), right_monitor));
        assert!(!rects_overlap(window(100, 200), right_monitor));
    }

    #[test]
    fn overlap_handles_left_sidecar_monitor() {
        let left_monitor = (-1920, 0, 1920_u32, 1080_u32);
        assert!(rects_overlap(window(-1000, 400), left_monitor));
        assert!(!rects_overlap(window(-3000, 400), left_monitor));
    }

    #[test]
    fn overlap_rejects_zero_size_monitor() {
        assert!(!rects_overlap(window(0, 0), (0, 0, 0, 0)));
    }

    #[test]
    fn overlap_rejects_fully_off_above() {
        assert!(!rects_overlap(window(100, -300), MONITOR_1080P));
    }

    #[test]
    fn overlap_rejects_fully_off_below() {
        assert!(!rects_overlap(window(100, 1080), MONITOR_1080P));
    }

    #[test]
    fn overlap_handles_u32_max_size() {
        // Saturating conversion keeps the rect well-formed when the OS
        // reports a u32 dimension larger than i32::MAX.
        assert!(rects_overlap(
            (i32::MAX - 1, 0, 1, 1),
            (0, 0, u32::MAX, u32::MAX)
        ));
    }
}
