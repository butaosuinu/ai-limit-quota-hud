mod commands;
mod model;
mod overlay;
mod platform;
mod provider_settings;
mod providers;
mod scheduler;
mod settings;
mod state;
mod storage;

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::overlay::{
    apply_to_window, emit_settings_changed, overlay_window, settings_window, OVERLAY_WINDOW_LABEL,
};
use crate::settings::{OverlaySettings, Position};

const MENU_ID_SHOW_HIDE: &str = "show_hide";
const MENU_ID_CLICK_THROUGH: &str = "click_through";
const MENU_ID_LOCK: &str = "lock_position";
const MENU_ID_SETTINGS: &str = "open_settings";
const MENU_ID_QUIT: &str = "quit";

const CLICK_THROUGH_SHORTCUT: &str = "CommandOrControl+Shift+Backslash";

struct AppState {
    settings: Mutex<OverlaySettings>,
    // The position `apply_to_window` just sent to the OS, if any. The Moved
    // event listener consumes this on the next event so a programmatic move
    // (e.g. Reset to defaults landing the overlay on the corner) is not
    // re-persisted as if the user had dragged the window.
    expected_programmatic_move: Mutex<Option<Position>>,
}

impl AppState {
    fn new(initial: OverlaySettings) -> Self {
        Self {
            settings: Mutex::new(initial.normalized()),
            expected_programmatic_move: Mutex::new(None),
        }
    }

    fn snapshot(&self) -> OverlaySettings {
        self.settings
            .lock()
            .expect("overlay settings mutex poisoned")
            .clone()
    }

    fn replace(&self, next: OverlaySettings) -> OverlaySettings {
        let normalized = next.normalized();
        let mut guard = self
            .settings
            .lock()
            .expect("overlay settings mutex poisoned");
        *guard = normalized;
        guard.clone()
    }

    fn expect_programmatic_move(&self, position: Option<Position>) {
        *self
            .expected_programmatic_move
            .lock()
            .expect("programmatic-move mutex poisoned") = position;
    }

    fn take_expected_programmatic_move(&self) -> Option<Position> {
        self.expected_programmatic_move
            .lock()
            .expect("programmatic-move mutex poisoned")
            .take()
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
    let state = app.state::<AppState>();
    let prev = state.snapshot();
    let stored = state.replace(settings);
    if stored != prev {
        persist_and_apply(&app, &stored);
    }
    Ok(stored)
}

fn apply_mutation<F: FnOnce(&mut OverlaySettings)>(app: &AppHandle, mutator: F) {
    let state = app.state::<AppState>();
    let prev = state.snapshot();
    let mut next = prev.clone();
    mutator(&mut next);
    let stored = state.replace(next);
    if stored != prev {
        persist_and_apply(app, &stored);
    }
}

fn persist_and_apply(app: &AppHandle, settings: &OverlaySettings) {
    if let Err(err) = settings::save(app, settings) {
        log::warn!("failed to persist overlay settings: {err}");
    }
    if let Some(window) = overlay_window(app) {
        let moved_to = apply_to_window(&window, settings);
        app.state::<AppState>().expect_programmatic_move(moved_to);
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

/// Tray menu items are kept around so check states can be updated when
/// settings change from any source (tray, shortcut, settings panel).
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
    let settings_item = MenuItem::with_id(app, MENU_ID_SETTINGS, "Settings…", true, None::<&str>)?;
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
        MENU_ID_SHOW_HIDE => apply_mutation(app, |s| s.visible = !s.visible),
        MENU_ID_CLICK_THROUGH => apply_mutation(app, |s| s.click_through = !s.click_through),
        MENU_ID_LOCK => apply_mutation(app, |s| s.locked = !s.locked),
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
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    apply_mutation(&app_for_handler, |s| s.click_through = !s.click_through);
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
        let window = settings.clone();
        settings.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        });
    }
}

fn persist_position(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<AppState>();
    let next = Position { x, y };

    // If the OS Moved event matches a position we just programmatically set
    // via `apply_to_window`, treat it as backend-initiated and skip persistence
    // so Reset-to-defaults / corner placement isn't immediately recorded as an
    // explicit user position.
    if state.take_expected_programmatic_move() == Some(next) {
        return;
    }

    let mut current = state.snapshot();
    if current.position == Some(next) {
        return;
    }
    current.position = Some(next);
    let stored = state.replace(current);
    if let Err(err) = settings::save(app, &stored) {
        log::warn!("failed to persist overlay position: {err}");
    }
    // Frontends (especially the Settings window) need the fresh position so a
    // later `update_overlay_settings` doesn't ship a stale value back.
    emit_settings_changed(app, &stored);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_overlay_settings,
            update_overlay_settings,
            commands::list_snapshots,
            commands::refresh_now,
            commands::list_manual_rows,
            commands::create_manual_row,
            commands::update_manual_row,
            commands::delete_manual_row,
            commands::get_refresh_interval,
            commands::set_refresh_interval,
            commands::get_provider_settings,
            commands::set_provider_enabled,
            commands::open_provider_login_window,
            commands::delete_provider_data,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let initial = settings::load(&handle);
            handle.manage(AppState::new(initial.clone()));

            if let Some(window) = handle.get_webview_window(OVERLAY_WINDOW_LABEL) {
                platform::apply_overlay_traits(&window);
                let moved_to = apply_to_window(&window, &initial);
                handle
                    .state::<AppState>()
                    .expect_programmatic_move(moved_to);
            } else {
                log::error!("overlay window `{OVERLAY_WINDOW_LABEL}` missing from tauri.conf.json");
            }

            build_tray(&handle, &initial)?;
            register_click_through_shortcut(&handle);
            attach_window_listeners(&handle);
            emit_settings_changed(&handle, &initial);

            // Provider/storage failures should not bring down the whole app:
            // the overlay and settings UI can still run, and the provider
            // commands will surface their own error to the frontend via the
            // missing-managed-state error.
            if let Err(err) = init_provider_runtime(&handle) {
                log::error!("provider runtime init failed; provider features disabled: {err}");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running QuotaHUD");
}

fn init_provider_runtime(handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, RwLock};

    use crate::providers::DEFAULT_REFRESH_INTERVAL_SECS;

    let data_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let config_dir = handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir unavailable: {e}"))?;
    // `Storage::open` creates the parent directory itself, so no need to
    // pre-create it here.
    let db_path = data_dir.join("providers.sqlite3");

    let storage = Arc::new(storage::Storage::open(db_path)?);
    let latest = Arc::new(RwLock::new(Vec::new()));
    let interval_seconds = Arc::new(AtomicU64::new(DEFAULT_REFRESH_INTERVAL_SECS));

    // Load opt-in state for WebView-backed providers from a separate JSON
    // file (PROJECT_SPEC §10.2). Failure to parse is non-fatal: we fall
    // back to an in-memory empty store so the rest of the app keeps
    // running, but the error is logged so a corrupted file is visible. The
    // "everything off by default" semantics ensure no provider is silently
    // re-enabled by the fallback. We load this before constructing providers
    // so the WebView ones can read their opt-in state on every refresh.
    let provider_settings_store = match provider_settings::ProviderSettingsStore::load(&config_dir)
    {
        Ok(store) => Arc::new(store),
        Err(err) => {
            log::warn!("could not load provider_settings.json; falling back to defaults: {err}");
            Arc::new(provider_settings::ProviderSettingsStore::empty(&config_dir))
        }
    };

    let providers::DefaultProviders {
        providers,
        claude_web,
    } = providers::default_providers(
        Arc::clone(&storage),
        &data_dir,
        Arc::clone(&provider_settings_store),
    );
    // Attach the Tauri `AppHandle` so the WebView-backed providers can
    // build hidden windows. We do this before spawning the scheduler so the
    // first scheduler tick (run immediately) sees an initialized scraper
    // if the user has already enabled the provider on a previous launch.
    claude_web.attach_app(handle.clone());
    handle.manage(state::WebviewProviders::new(Arc::clone(&claude_web)));

    let scheduler_handle = scheduler::spawn(scheduler::SchedulerDeps {
        app: handle.clone(),
        providers,
        storage: Arc::clone(&storage),
        latest: Arc::clone(&latest),
        interval_seconds: Arc::clone(&interval_seconds),
    });
    handle.manage(state::ProviderState::new(
        storage,
        latest,
        scheduler_handle,
        interval_seconds,
    ));

    handle.manage(provider_settings_store);

    Ok(())
}
