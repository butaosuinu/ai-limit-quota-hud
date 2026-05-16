//! macOS overlay tweaks: non-activating panel + join all Spaces, stay above
//! full-screen apps.

#![cfg(target_os = "macos")]
// cocoa is deprecated in favor of objc2-app-kit, but Tauri 2.x still hands us
// raw NSWindow pointers and cocoa is the lightest bridge. Revisit once Tauri
// migrates to objc2.
#![allow(deprecated)]

use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
use cocoa::base::id;

// NSWindowStyleMaskNonActivatingPanel — absent from cocoa 0.26's enum. Without
// it, `focus: false` makes AppKit drop mousedown before the contentView, so
// `data-tauri-drag-region` never fires and the overlay can't be dragged.
const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;

pub(crate) fn apply_overlay_traits(window: &tauri::WebviewWindow) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        log::warn!("ns_window() unavailable; skipping macOS overlay tweaks");
        return;
    };
    let ns_window = ns_window_ptr as id;

    // Safety: Tauri owns the NSWindow for the lifetime of the WebviewWindow;
    // we only mutate documented public properties.
    unsafe {
        let mask = ns_window.styleMask().bits() | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
        ns_window.setStyleMask_(NSWindowStyleMask::from_bits_retain(mask));

        let behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary;
        ns_window.setCollectionBehavior_(behavior);
    }
}
