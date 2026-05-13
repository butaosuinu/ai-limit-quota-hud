//! Windows overlay tweaks. Currently a no-op; Win32 polish
//! (WS_EX_TOOLWINDOW, virtual-desktop fallback) is documented in the README.

#![cfg(target_os = "windows")]

pub(crate) fn apply_overlay_traits(_window: &tauri::WebviewWindow) {}
