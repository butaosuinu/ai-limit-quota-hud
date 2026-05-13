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

fn corner_position(window: &WebviewWindow, settings: &OverlaySettings) -> Option<Position> {
    let monitor = window.current_monitor().ok().flatten()?;
    let monitor_size = monitor.size();
    let window_size = window.outer_size().ok()?;
    let margin_x = settings.margin_x.max(0);
    let margin_y = settings.margin_y.max(0);
    let max_x = i32::try_from(monitor_size.width)
        .unwrap_or(i32::MAX)
        .saturating_sub(i32::try_from(window_size.width).unwrap_or(i32::MAX))
        .saturating_sub(margin_x)
        .max(margin_x);
    let max_y = i32::try_from(monitor_size.height)
        .unwrap_or(i32::MAX)
        .saturating_sub(i32::try_from(window_size.height).unwrap_or(i32::MAX))
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
