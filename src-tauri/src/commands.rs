//! Tauri command handlers for usage snapshots and scheduler control.

use std::sync::atomic::Ordering;

use serde::Serialize;
use thiserror::Error;

use crate::model::UsageSnapshot;
use crate::providers::DEFAULT_REFRESH_INTERVAL_SECS;
use crate::scheduler;
use crate::state::ProviderState;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
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
pub async fn get_refresh_interval(
    state: tauri::State<'_, ProviderState>,
) -> Result<u64, AppError> {
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
