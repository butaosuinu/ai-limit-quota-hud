mod overlay;
mod platform;
mod settings;

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::overlay::{
    apply_to_window, emit_settings_changed, overlay_window, settings_window,
    OVERLAY_WINDOW_LABEL, SETTINGS_WINDOW_LABEL,
};
use crate::settings::{clamp_opacity, OverlaySettings, Position};

const MENU_ID_SHOW_HIDE: &str = "show_hide";
const MENU_ID_CLICK_THROUGH: &str = "click_through";
const MENU_ID_LOCK: &str = "lock_position";
const MENU_ID_SETTINGS: &str = "open_settings";
const MENU_ID_QUIT: &str = "quit";

const CLICK_THROUGH_SHORTCUT: &str = "CommandOrControl+Shift+Backslash";

/// Shared overlay state behind a Mutex. Phase 1 only stores `OverlaySettings`;
/// later phases extend this with provider snapshots and the scheduler handle.
struct AppState {
    settings: Mutex<OverlaySettings>,
}

impl AppState {
    fn new(initial: OverlaySettings) -> Self {
        Self {
            settings: Mutex::new(initial),
        }
    }

    fn snapshot(&self) -> OverlaySettings {
        self.settings
            .lock()
            .expect("overlay settings mutex poisoned")
            .clone()
    }

    fn replace(&self, next: OverlaySettings) -> OverlaySettings {
        let mut guard = self
            .settings
            .lock()
            .expect("overlay settings mutex poisoned");
        *guard = next;
        guard.clone()
    }
}

#[tauri::command]
fn get_overlay_settings(state: tauri::State<'_, AppState>) -> OverlaySettings {
    state.snapshot()
}

#[tauri::command]
fn update_overlay_settings(
    app: AppHandle,
    settings: OverlaySettings,
) -> Result<OverlaySettings, String> {
    let normalized = settings.normalized();
    let stored = app.state::<AppState>().replace(normalized);
    persist_and_apply(&app, &stored);
    Ok(stored)
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, visible: bool) {
    apply_mutation(&app, |s| s.visible = visible);
}

#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) {
    apply_mutation(&app, |s| s.click_through = enabled);
}

#[tauri::command]
fn set_locked(app: AppHandle, locked: bool) {
    apply_mutation(&app, |s| s.locked = locked);
}

#[tauri::command]
fn set_opacity(app: AppHandle, opacity: f64) {
    apply_mutation(&app, |s| s.opacity = clamp_opacity(opacity));
}

#[tauri::command]
fn show_settings_window(app: AppHandle) -> Result<(), String> {
    open_settings_window(&app);
    Ok(())
}

fn apply_mutation<F: FnOnce(&mut OverlaySettings)>(app: &AppHandle, mutator: F) {
    let state = app.state::<AppState>();
    let mut current = state.snapshot();
    mutator(&mut current);
    let normalized = current.normalized();
    let stored = state.replace(normalized);
    persist_and_apply(app, &stored);
}

fn toggle_visibility(app: &AppHandle) {
    apply_mutation(app, |s| s.visible = !s.visible);
}

fn toggle_click_through(app: &AppHandle) {
    apply_mutation(app, |s| s.click_through = !s.click_through);
}

fn toggle_locked(app: &AppHandle) {
    apply_mutation(app, |s| s.locked = !s.locked);
}

fn persist_and_apply(app: &AppHandle, settings: &OverlaySettings) {
    if let Err(err) = settings::save(app, settings) {
        log::warn!("failed to persist overlay settings: {err}");
    }
    if let Some(window) = overlay_window(app) {
        apply_to_window(&window, settings);
    }
    emit_settings_changed(app, settings);
    refresh_tray_menu(app, settings);
}

fn open_settings_window(app: &AppHandle) {
    if let Some(window) = settings_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        log::warn!("settings window is missing from tauri.conf.json");
    }
}

/// Tray menu items we keep handles to so check states stay in sync with
/// settings changes coming from anywhere (shortcut, command, settings panel).
struct TrayMenuItems {
    click_through: CheckMenuItem<tauri::Wry>,
    lock: CheckMenuItem<tauri::Wry>,
    show_hide: MenuItem<tauri::Wry>,
}

fn refresh_tray_menu(app: &AppHandle, settings: &OverlaySettings) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    let _ = items.click_through.set_checked(settings.click_through);
    let _ = items.lock.set_checked(settings.locked);
    let label = if settings.visible {
        "Hide overlay"
    } else {
        "Show overlay"
    };
    let _ = items.show_hide.set_text(label);
}

fn build_tray(app: &AppHandle, initial: &OverlaySettings) -> tauri::Result<()> {
    let show_hide_label = if initial.visible {
        "Hide overlay"
    } else {
        "Show overlay"
    };
    let show_hide = MenuItem::with_id(app, MENU_ID_SHOW_HIDE, show_hide_label, true, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(
        app,
        MENU_ID_CLICK_THROUGH,
        "Click-through",
        true,
        initial.click_through,
        None::<&str>,
    )?;
    let lock = CheckMenuItem::with_id(
        app,
        MENU_ID_LOCK,
        "Lock position",
        true,
        initial.locked,
        None::<&str>,
    )?;
    let settings_item =
        MenuItem::with_id(app, MENU_ID_SETTINGS, "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, "Quit QuotaHUD", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &click_through,
            &lock,
            &separator,
            &settings_item,
            &separator,
            &quit,
        ],
    )?;

    app.manage(TrayMenuItems {
        click_through,
        lock,
        show_hide,
    });

    let mut builder = TrayIconBuilder::with_id("quotahud-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .icon_as_template(true)
        .on_menu_event(handle_menu_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        MENU_ID_SHOW_HIDE => toggle_visibility(app),
        MENU_ID_CLICK_THROUGH => toggle_click_through(app),
        MENU_ID_LOCK => toggle_locked(app),
        MENU_ID_SETTINGS => open_settings_window(app),
        MENU_ID_QUIT => app.exit(0),
        other => log::debug!("unhandled tray menu id: {other}"),
    }
}

fn register_click_through_shortcut(app: &AppHandle) {
    let app_for_handler = app.clone();
    let result =
        app.global_shortcut()
            .on_shortcut(CLICK_THROUGH_SHORTCUT, move |_app, _shortcut, event| {
                if event.state()
                    == tauri_plugin_global_shortcut::ShortcutState::Pressed
                {
                    toggle_click_through(&app_for_handler);
                }
            });
    if let Err(err) = result {
        log::warn!("global shortcut registration failed (continuing): {err}");
    }
}

fn attach_window_listeners(app: &AppHandle) {
    if let Some(overlay) = overlay_window(app) {
        let app_for_event = app.clone();
        overlay.on_window_event(move |event| {
            if let WindowEvent::Moved(position) = event {
                persist_position(&app_for_event, position.x, position.y);
            }
        });
    }

    if let Some(settings) = settings_window(app) {
        let app_for_event = app.clone();
        settings.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(window) = settings_window(&app_for_event) {
                    let _ = window.hide();
                }
                api.prevent_close();
            }
        });
    }
}

fn persist_position(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<AppState>();
    let mut current = state.snapshot();
    let next = Position { x, y };
    if current.position == Some(next) {
        return;
    }
    current.position = Some(next);
    let stored = state.replace(current);
    if let Err(err) = settings::save(app, &stored) {
        log::warn!("failed to persist overlay position: {err}");
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_overlay_settings,
            update_overlay_settings,
            set_overlay_visible,
            set_click_through,
            set_locked,
            set_opacity,
            show_settings_window
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let initial = settings::load(&handle).normalized();
            handle.manage(AppState::new(initial.clone()));

            if let Some(window) = handle.get_webview_window(OVERLAY_WINDOW_LABEL) {
                platform::apply_overlay_traits(&window);
                apply_to_window(&window, &initial);
            } else {
                log::error!(
                    "overlay window `{OVERLAY_WINDOW_LABEL}` missing from tauri.conf.json"
                );
            }

            if let Some(window) = handle.get_webview_window(SETTINGS_WINDOW_LABEL) {
                let _ = window.hide();
            }

            build_tray(&handle, &initial)?;
            register_click_through_shortcut(&handle);
            attach_window_listeners(&handle);
            emit_settings_changed(&handle, &initial);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running QuotaHUD");
}
