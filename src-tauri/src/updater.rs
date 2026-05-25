//! Updater status event payloads emitted to the frontend, plus a small
//! holder that lets the frontend fetch the last update-check result if it
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

/// Which automatic check produced a status. The frontend uses this to decide
/// whether a `noUpdate` may clear a displayed `available`: a `Daily` check is
/// the freshest backend knowledge and is authoritative, whereas a `Startup`
/// check can race a concurrent manual "check now" and must not clobber its
/// result.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckSource {
    Startup,
    Daily,
}

/// Payload emitted over `UPDATER_STATUS_EVENT`. Flattens `UpdateStatusPayload`
/// and tags it with the originating check so the frontend can tell a fresh
/// daily result from a startup result. The cached value returned by
/// `get_last_update_status` stays the bare `UpdateStatusPayload`: bootstrap
/// replays are always treated conservatively, regardless of source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusEvent {
    #[serde(flatten)]
    pub payload: UpdateStatusPayload,
    pub source: UpdateCheckSource,
}

/// Backend-side cache of the most recent update-check result (startup check or
/// the daily background check). The settings webview may mount after a check
/// has already emitted the event, so the frontend reads this on bootstrap to
/// recover the value. The full `UpdateStatusEvent` (including `source`) is kept
/// so a bootstrap replay can apply the same freshness rule as a live event —
/// e.g. a cached daily `noUpdate` can still clear a stale `available` when the
/// live event was missed (renderer reload / panel remount).
#[derive(Default)]
pub struct LastStartupStatus(Mutex<Option<UpdateStatusEvent>>);

impl LastStartupStatus {
    pub fn store(&self, status: UpdateStatusEvent) {
        *self.0.lock().expect("last-startup-status mutex poisoned") = Some(status);
    }

    pub fn snapshot(&self) -> Option<UpdateStatusEvent> {
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

        status.store(UpdateStatusEvent {
            payload: UpdateStatusPayload::NoUpdate,
            source: UpdateCheckSource::Startup,
        });
        assert!(matches!(
            status.snapshot(),
            Some(UpdateStatusEvent {
                payload: UpdateStatusPayload::NoUpdate,
                source: UpdateCheckSource::Startup,
            })
        ));

        status.store(UpdateStatusEvent {
            payload: UpdateStatusPayload::Error {
                message: "network unavailable".into(),
            },
            source: UpdateCheckSource::Daily,
        });
        match status.snapshot() {
            Some(UpdateStatusEvent {
                payload: UpdateStatusPayload::Error { message },
                source: UpdateCheckSource::Daily,
            }) => {
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

    #[test]
    fn update_status_event_flattens_payload_and_tags_source() {
        let value = serde_json::to_value(UpdateStatusEvent {
            payload: UpdateStatusPayload::NoUpdate,
            source: UpdateCheckSource::Daily,
        })
        .unwrap();

        // The payload fields are flattened up alongside the `source` tag so the
        // frontend reads one flat object, not a nested `payload`.
        assert_eq!(
            value.get("status").and_then(|v| v.as_str()),
            Some("noUpdate")
        );
        assert_eq!(value.get("source").and_then(|v| v.as_str()), Some("daily"));
        assert!(value.get("payload").is_none());
    }

    #[test]
    fn update_check_source_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(UpdateCheckSource::Startup).unwrap(),
            serde_json::json!("startup")
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckSource::Daily).unwrap(),
            serde_json::json!("daily")
        );
    }
}
