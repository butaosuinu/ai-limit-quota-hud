//! Windows overlay tweaks. Phase 1 leans on Tauri's `skipTaskbar` /
//! `alwaysOnTop` config and defers the Win32 native polish (WS_EX_TOOLWINDOW,
//! WS_EX_NOACTIVATE, manual virtual-desktop fallback) to Phase 2 so we don't
//! pull in the heavy `windows` crate before its dependents are needed.
//!
//! Known limitations (documented in README):
//! - Tauri's all-virtual-desktop persistence is best-effort and may drop the
//!   overlay when the user switches desktops. Re-show is manual via the tray.
//! - The overlay window may briefly steal focus on first show; this is a
//!   Tauri quirk and the upcoming Phase 2 native pass addresses it.

#![cfg(target_os = "windows")]

pub(crate) fn apply_overlay_traits(_window: &tauri::WebviewWindow) {
    log::debug!(
        "windows overlay traits: deferring Win32 polish to Phase 2 (see README)"
    );
}
