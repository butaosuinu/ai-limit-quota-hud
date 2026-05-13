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
/// Returns the position the window was moved to (if any) so the caller can
/// distinguish a programmatic Moved event from a real user drag. Returns
/// `None` when no move was needed (window already at the resolved position).
pub fn apply_to_window(
    window: &WebviewWindow,
    settings: &OverlaySettings,
) -> Option<Position> {
    let _ = window.set_always_on_top(settings.always_on_top);
    let _ = window.set_ignore_cursor_events(settings.click_through);

    let target = resolve_target_position(window, settings);
    let moved_to = target.filter(|p| {
        let already_there = window
            .outer_position()
            .ok()
            .is_some_and(|cur| cur.x == p.x && cur.y == p.y);
        if already_there {
            return false;
        }
        let _ = window.set_position(PhysicalPosition { x: p.x, y: p.y });
        true
    });

    if settings.visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }

    moved_to
}

/// Decide where the overlay should land. A saved `position` is honored only
/// when it's still on a connected monitor — a position carried over from an
/// unplugged display or higher resolution would otherwise leave the overlay
/// stranded off-screen with no obvious way to recover.
fn resolve_target_position(
    window: &WebviewWindow,
    settings: &OverlaySettings,
) -> Option<Position> {
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

fn position_visible_on_any_monitor(window: &WebviewWindow, position: Position) -> bool {
    let monitors = match window.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        // No monitor info — be permissive so we don't refuse a perfectly fine
        // position on a platform where this API misbehaves.
        _ => return true,
    };
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        point_in_rect(position, (pos.x, pos.y), (size.width, size.height))
    })
}

fn point_in_rect(point: Position, origin: (i32, i32), size: (u32, u32)) -> bool {
    let (ox, oy) = origin;
    let right = ox.saturating_add(u32_to_i32_saturating(size.0));
    let bottom = oy.saturating_add(u32_to_i32_saturating(size.1));
    (ox..right).contains(&point.x) && (oy..bottom).contains(&point.y)
}

/// Saturating `u32 → i32` for window/monitor dimensions that exceed `i32::MAX`
/// (vanishingly rare but possible on virtual desktops spanning many monitors).
fn u32_to_i32_saturating(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

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

pub fn emit_settings_changed(app: &AppHandle, settings: &OverlaySettings) {
    let payload = SettingsPayload { settings };
    if let Err(err) = app.emit(SETTINGS_CHANGED_EVENT, payload) {
        log::warn!("failed to emit settings-changed event: {err}");
    }
}

pub fn overlay_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(OVERLAY_WINDOW_LABEL).or_else(|| {
        log::warn!("overlay window is missing");
        None
    })
}

pub fn settings_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(SETTINGS_WINDOW_LABEL)
}

#[cfg(test)]
mod tests {
    use super::point_in_rect;
    use crate::settings::{clamp_opacity, Position};

    #[test]
    fn clamp_keeps_visible_floor() {
        assert!(clamp_opacity(-1.0) >= 0.15);
    }

    #[test]
    fn clamp_keeps_visible_ceiling() {
        assert!((clamp_opacity(2.0) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn point_in_rect_accepts_interior() {
        assert!(point_in_rect(
            Position { x: 100, y: 100 },
            (0, 0),
            (1920, 1080)
        ));
    }

    #[test]
    fn point_in_rect_accepts_origin_corner() {
        assert!(point_in_rect(
            Position { x: 0, y: 0 },
            (0, 0),
            (1920, 1080)
        ));
    }

    #[test]
    fn point_in_rect_rejects_right_edge() {
        // right/bottom are exclusive — a point flush with the far edge is
        // considered outside, since `set_position` with (width, _) would
        // place a 1×1 window just off the monitor.
        assert!(!point_in_rect(
            Position { x: 1920, y: 500 },
            (0, 0),
            (1920, 1080)
        ));
    }

    #[test]
    fn point_in_rect_rejects_negative_outside() {
        assert!(!point_in_rect(
            Position { x: -1, y: 500 },
            (0, 0),
            (1920, 1080)
        ));
    }

    #[test]
    fn point_in_rect_handles_offset_monitor() {
        assert!(point_in_rect(
            Position { x: 2500, y: 600 },
            (1920, 0),
            (1280, 800)
        ));
        assert!(!point_in_rect(
            Position { x: 100, y: 600 },
            (1920, 0),
            (1280, 800)
        ));
    }

    #[test]
    fn point_in_rect_handles_negative_offset_monitor() {
        assert!(point_in_rect(
            Position { x: -1000, y: 400 },
            (-1920, 0),
            (1920, 1080)
        ));
        assert!(!point_in_rect(
            Position { x: -3000, y: 400 },
            (-1920, 0),
            (1920, 1080)
        ));
    }

    #[test]
    fn point_in_rect_rejects_zero_size() {
        assert!(!point_in_rect(
            Position { x: 0, y: 0 },
            (0, 0),
            (0, 0)
        ));
    }

    #[test]
    fn point_in_rect_handles_u32_max_size() {
        // Saturating conversion keeps the rect well-formed when the OS
        // reports a u32 dimension larger than i32::MAX.
        assert!(point_in_rect(
            Position { x: i32::MAX - 1, y: 0 },
            (0, 0),
            (u32::MAX, u32::MAX)
        ));
    }
}
