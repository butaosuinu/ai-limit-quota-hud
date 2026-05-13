//! Linux overlay tweaks. Logs the detected session type so degraded behavior
//! under Wayland compositors is identifiable in bug reports.

#![cfg(target_os = "linux")]

pub(crate) fn apply_overlay_traits(_window: &tauri::WebviewWindow) {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into());
    log::debug!("linux overlay traits: session_type={session} (best-effort)");
}
