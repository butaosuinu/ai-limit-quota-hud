//! Per-OS overlay tweaks. Each backend isolates OS-specific `unsafe` code.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[allow(unused_variables)]
pub(crate) fn apply_overlay_traits(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::apply_overlay_traits(window);

    #[cfg(target_os = "windows")]
    windows::apply_overlay_traits(window);

    #[cfg(target_os = "linux")]
    linux::apply_overlay_traits(window);
}
