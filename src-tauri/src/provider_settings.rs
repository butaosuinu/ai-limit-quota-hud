//! Per-provider opt-in state (PROJECT_SPEC §8.7, §10.2).
//!
//! WebView-backed providers (`webview-claude-ai`, `webview-chatgpt-codex`)
//! must be disabled by default and toggled on explicitly by the user. That
//! state is persisted in `provider_settings.json` — kept separate from
//! `settings.json` (overlay placement / opacity / etc.) so the two concerns
//! evolve independently and a corrupted overlay file cannot accidentally
//! re-enable a WebView provider.
//!
//! The store is intentionally simple: a flat `provider_id → enabled` map and
//! synchronous JSON read/write. Provider toggling is rare (user clicks) so we
//! don't need anything fancier.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// On-disk shape of `provider_settings.json`. New fields must default to a
/// safe value (i.e. provider stays off) so older files keep parsing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettings {
    /// Provider id → enabled flag. Missing keys are treated as disabled by
    /// `is_enabled`, so unknown providers are off by default — important if a
    /// user downgrades to a build that no longer recognises a kind.
    pub enabled: BTreeMap<String, bool>,
}

impl ProviderSettings {
    // Used by the store's own `is_enabled` and by the WebView provider PRs
    // (#30 / #31) that gate `default_providers()` on opt-in state. The
    // attribute prevents `-D warnings` builds from failing until those
    // providers land.
    #[allow(dead_code)]
    pub fn is_enabled(&self, provider_id: &str) -> bool {
        self.enabled.get(provider_id).copied().unwrap_or(false)
    }

    pub fn set_enabled(&mut self, provider_id: &str, enabled: bool) {
        self.enabled.insert(provider_id.to_string(), enabled);
    }
}

/// Errors surfaced by the store. Kept narrow because callers only need to
/// distinguish "could not read disk" from "could not parse JSON" for
/// diagnostics; both end up as user-visible toast text via `AppError`.
#[derive(Debug, thiserror::Error)]
pub enum ProviderSettingsError {
    #[error("provider settings I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("provider settings parse error at {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug)]
pub struct ProviderSettingsStore {
    path: PathBuf,
    inner: Mutex<ProviderSettings>,
}

impl ProviderSettingsStore {
    /// Build an empty in-memory store pointed at the given config dir.
    /// Useful as a fallback when [`Self::load`] fails on a corrupted file
    /// and the caller wants the rest of the app to keep running with
    /// everything-off semantics.
    pub fn empty(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("provider_settings.json"),
            inner: Mutex::new(ProviderSettings::default()),
        }
    }

    /// Load the store from disk, creating an empty in-memory state when the
    /// file does not yet exist. Parse errors are *not* silently dropped — the
    /// caller decides whether to fall back to defaults or surface the error,
    /// because silently re-enabling providers would violate §8.7's "opt-in
    /// only" rule.
    pub fn load(config_dir: &Path) -> Result<Self, ProviderSettingsError> {
        let path = config_dir.join("provider_settings.json");
        let inner = if path.exists() {
            let raw =
                std::fs::read_to_string(&path).map_err(|source| ProviderSettingsError::Io {
                    path: path.clone(),
                    source,
                })?;
            if raw.trim().is_empty() {
                ProviderSettings::default()
            } else {
                serde_json::from_str(&raw).map_err(|source| ProviderSettingsError::Parse {
                    path: path.clone(),
                    source,
                })?
            }
        } else {
            ProviderSettings::default()
        };
        Ok(Self {
            path,
            inner: Mutex::new(inner),
        })
    }

    pub fn snapshot(&self) -> ProviderSettings {
        self.inner
            .lock()
            .expect("provider settings mutex poisoned")
            .clone()
    }

    // Same rationale as `ProviderSettings::is_enabled` — exercised by tests
    // today, called by the WebView provider PRs (#30 / #31) once those
    // providers gate themselves on opt-in state.
    #[allow(dead_code)]
    pub fn is_enabled(&self, provider_id: &str) -> bool {
        self.inner
            .lock()
            .expect("provider settings mutex poisoned")
            .is_enabled(provider_id)
    }

    /// Persist a single enable/disable toggle. Writes the entire JSON file
    /// atomically (write-then-rename) so a crash mid-write cannot leave a
    /// half-truncated file that mass-disables every provider on next launch.
    ///
    /// The in-memory state is only updated **after** the disk write
    /// succeeds. Building the next state on a clone keeps `inner` aligned
    /// with `provider_settings.json` at all times — a write failure
    /// (permission denied, disk full, ENOSPC) returns the error without
    /// leaving the cache toggled, so subsequent reads in the same session
    /// match what a fresh restart would load.
    pub fn set_enabled(
        &self,
        provider_id: &str,
        enabled: bool,
    ) -> Result<(), ProviderSettingsError> {
        let mut guard = self.inner.lock().expect("provider settings mutex poisoned");
        let mut next = guard.clone();
        next.set_enabled(provider_id, enabled);
        let body =
            serde_json::to_string_pretty(&next).map_err(|source| ProviderSettingsError::Parse {
                path: self.path.clone(),
                source,
            })?;
        write_atomic(&self.path, body.as_bytes()).map_err(|source| ProviderSettingsError::Io {
            path: self.path.clone(),
            source,
        })?;
        *guard = next;
        Ok(())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_yields_default_store() {
        let tmp = TempDir::new().unwrap();
        let store = ProviderSettingsStore::load(tmp.path()).unwrap();
        assert!(!store.is_enabled("webview-claude-ai"));
        assert_eq!(store.snapshot(), ProviderSettings::default());
    }

    #[test]
    fn set_enabled_persists_and_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = ProviderSettingsStore::load(tmp.path()).unwrap();
        store.set_enabled("webview-claude-ai", true).unwrap();
        assert!(store.is_enabled("webview-claude-ai"));

        let store2 = ProviderSettingsStore::load(tmp.path()).unwrap();
        assert!(store2.is_enabled("webview-claude-ai"));
        assert!(!store2.is_enabled("webview-chatgpt-codex"));
    }

    #[test]
    fn unknown_provider_is_disabled() {
        let tmp = TempDir::new().unwrap();
        let store = ProviderSettingsStore::load(tmp.path()).unwrap();
        // Default for any unknown id is `false` so a downgraded build never
        // accidentally launches a provider it does not understand.
        assert!(!store.is_enabled("future-provider"));
    }

    #[test]
    fn empty_file_falls_back_to_default() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("provider_settings.json"), "").unwrap();
        let store = ProviderSettingsStore::load(tmp.path()).unwrap();
        assert_eq!(store.snapshot(), ProviderSettings::default());
    }

    // Verifies the split-brain guard described on `set_enabled`:
    // a failed atomic write must leave `inner` aligned with disk, not the
    // would-have-been new value. Gated on Unix because `chmod`-based
    // forcing of write failures has no portable Windows equivalent —
    // CI covers macOS and Ubuntu, which is enough for the invariant.
    #[cfg(unix)]
    #[test]
    fn set_enabled_does_not_mutate_inner_when_write_fails() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let store = ProviderSettingsStore::load(tmp.path()).unwrap();

        // Read-only parent dir → `write_atomic`'s tempfile creation fails.
        let mut perms = std::fs::metadata(tmp.path()).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(tmp.path(), perms).unwrap();

        let result = store.set_enabled("webview-claude-ai", true);
        assert!(
            result.is_err(),
            "expected write failure to surface, got {result:?}"
        );
        assert!(
            !store.is_enabled("webview-claude-ai"),
            "in-memory state must not drift ahead of disk on write failure",
        );

        // Restore permissions so TempDir's Drop can clean up.
        let mut perms = std::fs::metadata(tmp.path()).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(tmp.path(), perms).unwrap();
    }

    #[test]
    fn malformed_file_surfaces_parse_error() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("provider_settings.json"),
            "{this is not json",
        )
        .unwrap();
        let err = ProviderSettingsStore::load(tmp.path()).unwrap_err();
        match err {
            ProviderSettingsError::Parse { .. } => {}
            other => panic!("expected Parse error, got {other:?}"),
        }
    }

    #[test]
    fn json_keeps_camel_case_for_frontend() {
        // The TS mirror in src/lib/types.ts reads `enabled` directly, so the
        // outer key must stay camelCase even though we only have one field.
        let mut settings = ProviderSettings::default();
        settings.set_enabled("webview-claude-ai", true);
        let json = serde_json::to_value(&settings).unwrap();
        assert!(json.get("enabled").is_some());
        assert_eq!(
            json.get("enabled")
                .and_then(|v| v.get("webview-claude-ai"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}
