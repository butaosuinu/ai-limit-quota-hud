//! macOS overlay tweaks: join all Spaces and stay above full-screen apps.

#![cfg(target_os = "macos")]
// cocoa is deprecated in favor of objc2-app-kit, but Tauri 2.x still hands us
// raw NSWindow pointers and cocoa is the lightest bridge. Revisit once Tauri
// migrates to objc2.
#![allow(deprecated)]

use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
use cocoa::base::id;

pub(crate) fn apply_overlay_traits(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        log::warn!("ns_window() unavailable; skipping macOS overlay tweaks");
        return;
    };
    let ns_window = ns_window_ptr as id;

    // Safety: Tauri owns the NSWindow for the lifetime of the WebviewWindow;
    // we only mutate documented public properties.
    unsafe {
        let behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary;
        ns_window.setCollectionBehavior_(behavior);
    }
}
