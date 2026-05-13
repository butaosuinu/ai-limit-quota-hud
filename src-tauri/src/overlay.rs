//! Overlay window helpers (Phase 1).
//!
//! Translates `OverlaySettings` into Tauri window state and broadcasts
//! changes back to the frontend so the React side can react (opacity, compact
//! mode, etc. are CSS-driven and can't be set from Rust directly).

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

/// Apply window-controllable bits of `OverlaySettings` to the overlay window.
///
/// Opacity and compact mode are intentionally NOT applied here — they're CSS
/// concerns and the frontend handles them via the `settings-changed` event.
pub fn apply_to_window(window: &WebviewWindow, settings: &OverlaySettings) {
    let _ = window.set_always_on_top(settings.always_on_top);
    let _ = window.set_ignore_cursor_events(settings.click_through);

    if let Some(position) = settings.position {
        let _ = window.set_position(PhysicalPosition {
            x: position.x,
            y: position.y,
        });
    } else if let Some(position) = corner_position(window, settings) {
        let _ = window.set_position(PhysicalPosition {
            x: position.x,
            y: position.y,
        });
    }

    if settings.visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
}

/// Resolve a starting position from `corner` + margin if no explicit position
/// is set yet. Returns None when the monitor info is unavailable; the caller
/// should leave the window where Tauri placed it.
fn corner_position(window: &WebviewWindow, settings: &OverlaySettings) -> Option<Position> {
    let monitor = window.current_monitor().ok().flatten()?;
    let monitor_size = monitor.size();
    let window_size = window.outer_size().ok()?;
    let margin_x = settings.margin_x.max(0);
    let margin_y = settings.margin_y.max(0);
    let max_x = monitor_size.width as i32 - window_size.width as i32 - margin_x;
    let max_y = monitor_size.height as i32 - window_size.height as i32 - margin_y;
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

/// Broadcast the latest settings to every webview so React side reacts in
/// real-time. Both the overlay and settings windows listen for this event.
pub fn emit_settings_changed(app: &AppHandle, settings: &OverlaySettings) {
    let payload = SettingsPayload { settings };
    if let Err(err) = app.emit(SETTINGS_CHANGED_EVENT, payload) {
        log::warn!("failed to emit settings-changed event: {err}");
    }
}

/// Locate the overlay window or log a warning if it has been destroyed.
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
    use crate::settings::clamp_opacity;

    #[test]
    fn clamp_keeps_visible_floor() {
        assert!(clamp_opacity(-1.0) >= 0.15);
    }

    #[test]
    fn clamp_keeps_visible_ceiling() {
        assert!((clamp_opacity(2.0) - 1.0).abs() < f64::EPSILON);
    }
}
