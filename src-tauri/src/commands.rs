//! Tauri command handlers added by Phase 2.
//!
//! All SQLite work runs on the blocking pool — rusqlite is synchronous and
//! must not occupy the async runtime. Each mutation wakes the scheduler so
//! the UI sees the change without waiting for the next refresh tick.

use std::sync::Arc;

use serde::Serialize;
use thiserror::Error;

use crate::model::{ManualRow, ManualRowInput, UsageSnapshot};
use crate::providers::DEFAULT_REFRESH_INTERVAL_SECS;
use crate::scheduler;
use crate::state::ProviderState;
use crate::storage::{Storage, StorageError};

#[derive(Debug, Error)]
pub enum AppError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
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
    let row =
        run_storage(&state, move |storage| storage.update_manual_row(&id, &input)).await?;
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
pub async fn get_refresh_interval(
    state: tauri::State<'_, ProviderState>,
) -> Result<u64, AppError> {
    let guard = state
        .refresh_interval_seconds
        .read()
        .map_err(|_| AppError::Internal("interval lock poisoned".into()))?;
    Ok(*guard)
}

#[tauri::command]
pub async fn set_refresh_interval(
    seconds: u64,
    state: tauri::State<'_, ProviderState>,
) -> Result<(), AppError> {
    let clamped = seconds.max(DEFAULT_REFRESH_INTERVAL_SECS);
    let mut guard = state
        .refresh_interval_seconds
        .write()
        .map_err(|_| AppError::Internal("interval lock poisoned".into()))?;
    *guard = clamped;
    Ok(())
}
