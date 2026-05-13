//! Linux overlay tweaks. Currently a documentation hook: X11/Wayland
//! always-on-top and sticky behavior depend on the compositor and many
//! Wayland compositors refuse the necessary hints outright. We log the
//! detected environment so users debugging an unresponsive overlay can
//! attach the value to a bug report.
//!
//! Known limitations (documented in README):
//! - Wayland: most compositors ignore `alwaysOnTop` and Spaces-equivalent
//!   sticky requests. The overlay still draws and persists settings; it
//!   just may not float above every other surface.
//! - X11: behavior depends on the window manager. EWMH-compliant WMs
//!   honor Tauri's alwaysOnTop request.

#![cfg(target_os = "linux")]

pub(crate) fn apply_overlay_traits(_window: &tauri::WebviewWindow) {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".into());
    log::debug!("linux overlay traits: session_type={session} (best-effort)");
}
