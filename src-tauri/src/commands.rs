//! Tauri command handlers added by Phase 2.
//!
//! All SQLite work runs on the blocking pool — rusqlite is synchronous and
//! must not occupy the async runtime. Each mutation wakes the scheduler so
//! the UI sees the change without waiting for the next refresh tick.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use crate::model::{ManualRow, ManualRowInput, ProviderKind, UsageSnapshot};
use crate::provider_settings::{ProviderSettings, ProviderSettingsError, ProviderSettingsStore};
use crate::providers::webview::scraper::WebviewScraper;
use crate::providers::webview::{provider_slug, SessionStorage};
use crate::providers::DEFAULT_REFRESH_INTERVAL_SECS;
use crate::scheduler;
use crate::state::{ProviderState, WebviewProviders};
use crate::storage::{Storage, StorageError};

#[derive(Debug, Error)]
pub enum AppError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
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

async fn run_storage<T, F>(state: &ProviderState, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Storage) -> Result<T, StorageError> + Send + 'static,
{
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || f(&storage))
        .await
        .map_err(|e| AppError::Internal(format!("join error: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
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
pub async fn refresh_now(state: tauri::State<'_, ProviderState>) -> Result<(), AppError> {
    scheduler::trigger(&state.scheduler);
    Ok(())
}

#[tauri::command]
pub async fn list_manual_rows(
    state: tauri::State<'_, ProviderState>,
) -> Result<Vec<ManualRow>, AppError> {
    run_storage(&state, |storage| storage.list_manual_rows()).await
}

#[tauri::command]
pub async fn create_manual_row(
    input: ManualRowInput,
    state: tauri::State<'_, ProviderState>,
) -> Result<ManualRow, AppError> {
    let row = run_storage(&state, move |storage| storage.create_manual_row(&input)).await?;
    scheduler::trigger(&state.scheduler);
    Ok(row)
}

#[tauri::command]
pub async fn update_manual_row(
    id: String,
    input: ManualRowInput,
    state: tauri::State<'_, ProviderState>,
) -> Result<ManualRow, AppError> {
    let row = run_storage(&state, move |storage| {
        storage.update_manual_row(&id, &input)
    })
    .await?;
    scheduler::trigger(&state.scheduler);
    Ok(row)
}

#[tauri::command]
pub async fn delete_manual_row(
    id: String,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    run_storage(&state, move |storage| storage.delete_manual_row(&id)).await?;
    scheduler::trigger(&state.scheduler);
    Ok(())
}

#[tauri::command]
pub async fn get_refresh_interval(state: tauri::State<'_, ProviderState>) -> Result<u64, AppError> {
    Ok(state.refresh_interval_seconds.load(Ordering::Relaxed))
}

#[tauri::command]
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
// WebView provider settings (PROJECT_SPEC §8.7).
//
// These commands are deliberately scoped to WebView-backed kinds. Passing any
// other `ProviderKind` is a frontend bug, so we surface it as an error rather
// than silently no-op'ing it. The login and delete commands are stubs in the
// foundation PR — they validate the input and then return a clear error
// pointing at the concrete provider PRs (#30 / #31) that wire up the real
// behavior. This keeps the IPC surface stable so the frontend can be written
// against the final command shape today.

fn webview_slug_for_command(kind: ProviderKind) -> Result<&'static str, AppError> {
    provider_slug(kind).ok_or_else(|| {
        AppError::Internal(format!(
            "provider kind {kind:?} is not a WebView-backed provider"
        ))
    })
}

#[tauri::command]
pub async fn get_provider_settings(
    store: tauri::State<'_, Arc<ProviderSettingsStore>>,
) -> Result<ProviderSettings, AppError> {
    Ok(store.snapshot())
}

#[tauri::command]
pub async fn set_provider_enabled(
    kind: ProviderKind,
    enabled: bool,
    store: tauri::State<'_, Arc<ProviderSettingsStore>>,
) -> Result<(), AppError> {
    let slug = webview_slug_for_command(kind)?;
    store.set_enabled(slug, enabled)?;
    Ok(())
}

#[tauri::command]
pub async fn open_provider_login_window(
    kind: ProviderKind,
    webview: tauri::State<'_, WebviewProviders>,
) -> Result<(), AppError> {
    let _slug = webview_slug_for_command(kind)?;
    match kind {
        ProviderKind::WebviewClaudeAi => {
            let provider = Arc::clone(&webview.claude_web);
            // The provider's own scraper carries an `AppHandle`; reuse it
            // rather than re-deriving one so the login window shares the
            // same session storage as the hidden refresh.
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
        ProviderKind::WebviewChatgptCodex => Err(AppError::Internal(
            "Codex WebView provider is not implemented in this branch — see issue #31".into(),
        )),
        // `webview_slug_for_command` already rejects non-WebView kinds.
        _ => unreachable!("webview_slug_for_command already validated the kind"),
    }
}

#[tauri::command]
pub async fn delete_provider_data(
    kind: ProviderKind,
    webview: tauri::State<'_, WebviewProviders>,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    let _slug = webview_slug_for_command(kind)?;
    let outcome = match kind {
        ProviderKind::WebviewClaudeAi => {
            let provider = Arc::clone(&webview.claude_web);
            let scraper = provider.attach_scraper_for_login();
            delete_session_storage(provider.session_storage(), scraper.as_ref()).await
        }
        ProviderKind::WebviewChatgptCodex => Err(AppError::Internal(
            "Codex WebView provider is not implemented in this branch — see issue #31".into(),
        )),
        _ => unreachable!("webview_slug_for_command already validated the kind"),
    };
    // Wake the scheduler so the next refresh emits the post-delete (logged-
    // out) snapshot immediately. Without this, `min_refresh_interval = 600s`
    // would leave the stale authenticated rows visible for up to ~10 min
    // after the user clicked "Delete provider data", contradicting the
    // "delete + re-login required" UX. Trigger only on success so a failed
    // delete doesn't waste a refresh slot showing the still-authenticated
    // state.
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
                if !path.exists() {
                    return Ok(());
                }
                std::fs::remove_dir_all(&path).map_err(|e| {
                    AppError::Internal(format!(
                        "could not remove WebView data directory {}: {e}",
                        path.display()
                    ))
                })
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
