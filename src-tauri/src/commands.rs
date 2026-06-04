//! Tauri command handlers for usage snapshots, scheduler control, and
//! WebView provider settings (spec §8).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use crate::model::{ProviderKind, UsageSnapshot};
use crate::provider_settings::{ProviderSettings, ProviderSettingsError, ProviderSettingsStore};
use crate::providers::webview::scraper::WebviewScraper;
use crate::providers::webview::{provider_slug, SessionStorage};
use crate::providers::DEFAULT_REFRESH_INTERVAL_SECS;
use crate::scheduler;
use crate::state::{ProviderState, WebviewProviders};

#[derive(Debug, Error)]
pub enum AppError {
    #[error("provider settings error: {0}")]
    ProviderSettings(#[from] ProviderSettingsError),
    #[error("internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn list_snapshots(
    state: tauri::State<'_, ProviderState>,
) -> Result<Vec<UsageSnapshot>, AppError> {
    let guard = state
        .latest
        .read()
        .map_err(|_| AppError::Internal("latest snapshots lock poisoned".into()))?;
    Ok(guard.clone())
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn refresh_now(state: tauri::State<'_, ProviderState>) -> Result<(), AppError> {
    scheduler::trigger(&state.scheduler);
    Ok(())
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn get_refresh_interval(state: tauri::State<'_, ProviderState>) -> Result<u64, AppError> {
    Ok(state.refresh_interval_seconds.load(Ordering::Relaxed))
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn set_refresh_interval(
    seconds: u64,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    let clamped = seconds.max(DEFAULT_REFRESH_INTERVAL_SECS);
    state
        .refresh_interval_seconds
        .store(clamped, Ordering::Relaxed);
    // Wake the scheduler so it picks up the new interval on its next sleep
    // boundary rather than waiting out the previous one.
    scheduler::trigger(&state.scheduler);
    Ok(())
}

// ---------------------------------------------------------------------------
// WebView provider settings (PROJECT_SPEC §8).
//
// These commands are deliberately scoped to WebView-backed kinds. Passing any
// other `ProviderKind` is a frontend bug, so we surface it as an error rather
// than silently no-op'ing it.

fn webview_slug_for_command(kind: ProviderKind) -> Result<&'static str, AppError> {
    provider_slug(kind).ok_or_else(|| {
        AppError::Internal(format!(
            "provider kind {kind:?} is not a WebView-backed provider"
        ))
    })
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn get_provider_settings(
    store: tauri::State<'_, Arc<ProviderSettingsStore>>,
) -> Result<ProviderSettings, AppError> {
    Ok(store.snapshot())
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn set_provider_enabled(
    kind: ProviderKind,
    enabled: bool,
    store: tauri::State<'_, Arc<ProviderSettingsStore>>,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    let slug = webview_slug_for_command(kind)?;
    store.set_enabled(slug, enabled)?;
    // Wake the scheduler so a toggle (enable or disable) takes effect on
    // the next tick instead of waiting out the provider's throttle. Without
    // this, disabling could leave stale authenticated rows visible, and
    // enabling could similarly delay the first snapshot.
    scheduler::trigger(&state.scheduler);
    Ok(())
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn open_provider_login_window(
    kind: ProviderKind,
    webview: tauri::State<'_, WebviewProviders>,
) -> Result<(), AppError> {
    match kind {
        ProviderKind::WebviewClaudeAi => {
            let provider = Arc::clone(&webview.claude_web);
            // The provider's own scraper carries an `AppHandle`; reuse it
            // rather than re-deriving one so the login window shares the
            // same session storage as the hidden refresh. The scheduler is
            // woken from inside the scraper's navigation callback when the
            // login flow returns to the target origin — not here, because
            // this command resolves the moment the window opens (well
            // before the user has actually authenticated). Triggering at
            // open-time would force a refresh that captures the still-
            // logged-out state, update `last_run`, and then make the user
            // wait out the interval for the post-login snapshot.
            let scraper = provider.attach_scraper_for_login().ok_or_else(|| {
                AppError::Internal(
                    "WebView runtime not initialized; cannot open login window".into(),
                )
            })?;
            scraper
                .open_visible_login()
                .await
                .map_err(|e| AppError::Internal(format!("login window failed: {e}")))?;
            Ok(())
        }
        ProviderKind::WebviewChatgptCodex => {
            let provider = Arc::clone(&webview.codex_web);
            // Mirror the Claude branch: reuse the provider's own scraper so
            // the visible login window shares the same `SessionStorage` as
            // the hidden refresh, and avoid triggering the scheduler here
            // (it would race the still-logged-out state into `last_run`).
            let scraper = provider.attach_scraper_for_login().ok_or_else(|| {
                AppError::Internal(
                    "WebView runtime not initialized; cannot open login window".into(),
                )
            })?;
            scraper
                .open_visible_login()
                .await
                .map_err(|e| AppError::Internal(format!("login window failed: {e}")))?;
            Ok(())
        }
    }
}

#[tauri::command]
#[cfg_attr(coverage_nightly, coverage(off))]
pub async fn delete_provider_data(
    kind: ProviderKind,
    webview: tauri::State<'_, WebviewProviders>,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    let outcome = match kind {
        ProviderKind::WebviewClaudeAi => {
            let provider = Arc::clone(&webview.claude_web);
            let scraper = provider.attach_scraper_for_login();
            if let Some(scraper) = scraper.as_ref() {
                scraper.destroy_hidden_window();
            }
            delete_session_storage(provider.session_storage(), scraper.as_ref()).await
        }
        ProviderKind::WebviewChatgptCodex => {
            let provider = Arc::clone(&webview.codex_web);
            let scraper = provider.attach_scraper_for_login();
            if let Some(scraper) = scraper.as_ref() {
                scraper.destroy_hidden_window();
            }
            delete_session_storage(provider.session_storage(), scraper.as_ref()).await
        }
    };
    // Wake the scheduler so the next refresh emits the post-delete (logged-
    // out) snapshot immediately. Without this, provider throttling would
    // leave stale authenticated rows visible after the user clicked
    // "Delete provider data", contradicting the "delete + re-login
    // required" UX. Trigger only on success so a failed delete doesn't
    // waste a refresh slot showing the still-authenticated state.
    if outcome.is_ok() {
        scheduler::trigger(&state.scheduler);
    }
    outcome
}

/// Force re-login by tearing down a provider's persistent session storage.
///
/// On Windows / Linux this is just an `rm -rf` of the per-provider profile
/// directory — the next refresh will recreate it empty and the user will be
/// forced to log in again. On macOS the `WKWebsiteDataStore` keyed by our
/// `dataStoreIdentifier` cannot be dropped through Tauri 2's public API, so
/// we delegate to [`WebviewScraper::clear_session_data`], which builds a
/// transient hidden window pinned to the same store and asks the WebView to
/// flush its cookies / cache. Either path reliably puts the next refresh
/// back into the logged-out state — no more "UI says success but cookies
/// remain" split.
async fn delete_session_storage(
    storage: &SessionStorage,
    scraper_for_clear: Option<&WebviewScraper>,
) -> Result<(), AppError> {
    match storage {
        SessionStorage::DataDirectory(path) => {
            let path = path.clone();
            tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(AppError::Internal(format!(
                        "could not remove WebView data directory {}: {e}",
                        path.display()
                    ))),
                }
            })
            .await
            .map_err(|e| AppError::Internal(format!("join error: {e}")))??;
            Ok(())
        }
        SessionStorage::DataStoreIdentifier(uuid) => {
            let Some(scraper) = scraper_for_clear else {
                // The scraper is attached during `init_provider_runtime`, so
                // a missing handle here means the user toggled "Delete" before
                // the app finished initialising. Surface it instead of
                // silently no-op'ing — the previous version returned `Ok`
                // here and Codex flagged the resulting split-brain (UI shows
                // success, cookies still present).
                return Err(AppError::Internal(format!(
                    "cannot clear macOS WKWebsiteDataStore {uuid}: scraper has not been attached yet"
                )));
            };
            scraper.clear_session_data().await.map_err(|e| {
                AppError::Internal(format!(
                    "failed to clear macOS WKWebsiteDataStore {uuid}: {e}"
                ))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn delete_session_storage_removes_existing_data_directory() {
        let tmp = TempDir::new().unwrap();
        let data_dir = tmp.path().join("webview-provider");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("Cookies"), "opaque").unwrap();

        delete_session_storage(&SessionStorage::DataDirectory(data_dir.clone()), None)
            .await
            .unwrap();

        assert!(!data_dir.exists());
    }

    #[tokio::test]
    async fn delete_session_storage_ignores_missing_data_directory() {
        let tmp = TempDir::new().unwrap();
        let data_dir = tmp.path().join("missing-provider");

        delete_session_storage(&SessionStorage::DataDirectory(data_dir), None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn delete_session_storage_surfaces_remove_error() {
        let tmp = TempDir::new().unwrap();
        let file_path = tmp.path().join("not-a-directory");
        std::fs::write(&file_path, "not a directory").unwrap();

        let err = delete_session_storage(&SessionStorage::DataDirectory(file_path), None)
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("could not remove WebView data directory"));
    }

    #[tokio::test]
    async fn delete_datastore_identifier_requires_attached_scraper() {
        let id = uuid::Uuid::from_bytes([1u8; 16]);
        let err = delete_session_storage(&SessionStorage::DataStoreIdentifier(id), None)
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("scraper has not been attached yet"));
    }
}
