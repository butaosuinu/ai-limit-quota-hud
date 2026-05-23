//! Updater status event payloads emitted to the frontend, plus a small
//! holder that lets the frontend fetch the last startup-check result if it
//! mounted after the event was published.

use std::sync::Mutex;

use serde::Serialize;

pub const UPDATER_STATUS_EVENT: &str = "updater://status";

/// Status published over `updater://status`. The `Checking` transition is
/// owned by the frontend write atom (manual "check now" path), so it never
/// flows through this event and is intentionally absent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum UpdateStatusPayload {
    NoUpdate,
    Available { version: String, notes: String },
    Error { message: String },
}

/// Backend-side cache of the most recent startup-check result. The settings
/// webview may mount after `spawn_startup_update_check` has already emitted
/// the event, so the frontend reads this on bootstrap to recover the value.
#[derive(Default)]
pub struct LastStartupStatus(Mutex<Option<UpdateStatusPayload>>);

impl LastStartupStatus {
    pub fn store(&self, status: UpdateStatusPayload) {
        *self.0.lock().expect("last-startup-status mutex poisoned") = Some(status);
    }

    pub fn snapshot(&self) -> Option<UpdateStatusPayload> {
        self.0
            .lock()
            .expect("last-startup-status mutex poisoned")
            .clone()
    }
}
