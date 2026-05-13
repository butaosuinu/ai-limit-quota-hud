//! macOS overlay tweaks: join all Spaces, stay above full-screen apps.
//! Uses AppKit via `cocoa`/`objc` — only compiled on macOS and only touched
//! at window setup time.

#![cfg(target_os = "macos")]
// The cocoa crate is deprecated in favor of objc2-app-kit, but Tauri 2.x still
// exposes raw NSWindow pointers and cocoa is the lightest way to talk to them.
// Re-evaluate after Tauri migrates fully to objc2.
#![allow(deprecated)]

use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
use cocoa::base::id;

pub(crate) fn apply_overlay_traits(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        log::warn!("ns_window() unavailable; skipping macOS overlay tweaks");
        return;
    };
    let ns_window = ns_window_ptr as id;

    // Safety: ns_window is a valid NSWindow* owned by Tauri for the lifetime
    // of the window. We only mutate documented public properties.
    unsafe {
        let behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary;
        ns_window.setCollectionBehavior_(behavior);
    }
}
