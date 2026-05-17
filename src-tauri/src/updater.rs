//! Updater status event payloads emitted to the frontend.
use serde::Serialize;

pub const UPDATER_STATUS_EVENT: &str = "updater://status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum UpdateStatusPayload {
    Checking,
    NoUpdate,
    Available { version: String, notes: String },
    Error { message: String },
}
