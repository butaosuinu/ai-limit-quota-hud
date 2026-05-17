//! Updater status event payloads emitted to the frontend.
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
