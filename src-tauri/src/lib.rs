mod platform;

use tauri::Manager;

const OVERLAY_WINDOW_LABEL: &str = "overlay";

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window(OVERLAY_WINDOW_LABEL)
                .ok_or_else(|| {
                    format!("window `{OVERLAY_WINDOW_LABEL}` is missing from tauri.conf.json")
                })?;
            platform::apply_overlay_traits(&window);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running QuotaHUD");
}
