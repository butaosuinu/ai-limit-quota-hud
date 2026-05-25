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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_startup_status_starts_empty_and_keeps_latest_value() {
        let status = LastStartupStatus::default();
        assert!(status.snapshot().is_none());

        status.store(UpdateStatusPayload::NoUpdate);
        assert!(matches!(
            status.snapshot(),
            Some(UpdateStatusPayload::NoUpdate)
        ));

        status.store(UpdateStatusPayload::Error {
            message: "network unavailable".into(),
        });
        match status.snapshot() {
            Some(UpdateStatusPayload::Error { message }) => {
                assert_eq!(message, "network unavailable");
            }
            other => panic!("expected latest error status, got {other:?}"),
        }
    }

    #[test]
    fn update_status_payload_serializes_tagged_camel_case() {
        let value = serde_json::to_value(UpdateStatusPayload::Available {
            version: "0.0.3".into(),
            notes: "bug fixes".into(),
        })
        .unwrap();

        assert_eq!(
            value.get("status").and_then(|v| v.as_str()),
            Some("available")
        );
        assert_eq!(value.get("version").and_then(|v| v.as_str()), Some("0.0.3"));
        assert_eq!(
            value.get("notes").and_then(|v| v.as_str()),
            Some("bug fixes")
        );
    }
}
