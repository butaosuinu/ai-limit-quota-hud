//! Per-OS overlay tweaks. Each backend gets its own module so OS-specific
//! `unsafe` code stays isolated from the rest of the app.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

/// Apply OS-specific overlay traits beyond what Tauri's window config covers
/// (e.g. macOS Spaces collection behavior). Safe to call once per window; any
/// failures are logged rather than propagated so a hostile compositor cannot
/// crash the app.
#[allow(unused_variables)]
pub(crate) fn apply_overlay_traits(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::apply_overlay_traits(window);

    #[cfg(target_os = "windows")]
    windows::apply_overlay_traits(window);

    #[cfg(target_os = "linux")]
    linux::apply_overlay_traits(window);
}
