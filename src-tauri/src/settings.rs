//! Overlay settings persistence (Phase 1).
//!
//! Lives as a small JSON file under the app config dir. No secrets here —
//! provider tokens go to OS credential storage in later phases.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILENAME: &str = "settings.json";
const DEFAULT_OPACITY: f64 = 0.72;
const DEFAULT_MARGIN: i32 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Default for OverlayCorner {
    fn default() -> Self {
        Self::TopRight
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlaySettings {
    pub opacity: f64,
    pub compact: bool,
    pub click_through: bool,
    pub locked: bool,
    pub visible: bool,
    pub always_on_top: bool,
    pub corner: OverlayCorner,
    pub margin_x: i32,
    pub margin_y: i32,
    pub position: Option<Position>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            opacity: DEFAULT_OPACITY,
            compact: false,
            click_through: false,
            locked: true,
            visible: true,
            always_on_top: true,
            corner: OverlayCorner::default(),
            margin_x: DEFAULT_MARGIN,
            margin_y: DEFAULT_MARGIN,
            position: None,
        }
    }
}

impl OverlaySettings {
    /// Clamp opacity to a safe visible range so the user can never accidentally
    /// hide the overlay entirely from the settings panel.
    pub fn normalized(mut self) -> Self {
        self.opacity = clamp_opacity(self.opacity);
        self
    }
}

pub fn clamp_opacity(value: f64) -> f64 {
    const MIN: f64 = 0.15;
    const MAX: f64 = 1.0;
    if value.is_nan() {
        DEFAULT_OPACITY
    } else if value < MIN {
        MIN
    } else if value > MAX {
        MAX
    } else {
        value
    }
}

/// Resolve the on-disk path for the settings file under the Tauri app config dir.
pub fn settings_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| anyhow::anyhow!("app_config_dir unavailable: {err}"))?;
    Ok(dir.join(SETTINGS_FILENAME))
}

/// Load settings from `path`. Returns defaults on any error (missing file,
/// IO error, or malformed JSON) so the app always starts in a usable state.
pub fn load_from_path(path: &Path) -> OverlaySettings {
    let Ok(contents) = fs::read_to_string(path) else {
        return OverlaySettings::default();
    };
    match serde_json::from_str::<OverlaySettings>(&contents) {
        Ok(settings) => settings.normalized(),
        Err(err) => {
            log::warn!(
                "settings.json could not be parsed ({err}); falling back to defaults"
            );
            OverlaySettings::default()
        }
    }
}

/// Persist settings to `path`, creating the parent directory if needed.
pub fn save_to_path(path: &Path, settings: &OverlaySettings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    fs::write(path, json)?;
    Ok(())
}

pub fn load(app: &AppHandle) -> OverlaySettings {
    match settings_path(app) {
        Ok(path) => load_from_path(&path),
        Err(err) => {
            log::warn!("settings_path unavailable ({err}); using defaults");
            OverlaySettings::default()
        }
    }
}

pub fn save(app: &AppHandle, settings: &OverlaySettings) -> anyhow::Result<()> {
    let path = settings_path(app)?;
    save_to_path(&path, settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_settings_path(dir: &TempDir) -> PathBuf {
        dir.path().join("settings.json")
    }

    #[test]
    fn defaults_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = temp_settings_path(&dir);
        let settings = OverlaySettings::default();
        save_to_path(&path, &settings).unwrap();
        let loaded = load_from_path(&path);
        assert_eq!(loaded, settings);
    }

    #[test]
    fn missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let path = temp_settings_path(&dir);
        assert!(!path.exists());
        let loaded = load_from_path(&path);
        assert_eq!(loaded, OverlaySettings::default());
    }

    #[test]
    fn malformed_json_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let path = temp_settings_path(&dir);
        fs::write(&path, "{ not json").unwrap();
        let loaded = load_from_path(&path);
        assert_eq!(loaded, OverlaySettings::default());
    }

    #[test]
    fn missing_fields_filled_from_defaults() {
        let dir = TempDir::new().unwrap();
        let path = temp_settings_path(&dir);
        fs::write(&path, "{\"opacity\": 0.5}").unwrap();
        let loaded = load_from_path(&path);
        assert!((loaded.opacity - 0.5).abs() < f64::EPSILON);
        assert_eq!(loaded.compact, OverlaySettings::default().compact);
        assert_eq!(loaded.locked, OverlaySettings::default().locked);
    }

    #[test]
    fn opacity_clamped_low() {
        let mut settings = OverlaySettings::default();
        settings.opacity = 0.0;
        let normalized = settings.normalized();
        assert!(normalized.opacity >= 0.15);
    }

    #[test]
    fn opacity_clamped_high() {
        let mut settings = OverlaySettings::default();
        settings.opacity = 5.0;
        let normalized = settings.normalized();
        assert!((normalized.opacity - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn nan_opacity_resets_to_default() {
        assert!((clamp_opacity(f64::NAN) - DEFAULT_OPACITY).abs() < f64::EPSILON);
    }

    #[test]
    fn position_persists() {
        let dir = TempDir::new().unwrap();
        let path = temp_settings_path(&dir);
        let mut settings = OverlaySettings::default();
        settings.position = Some(Position { x: 120, y: 80 });
        save_to_path(&path, &settings).unwrap();
        let loaded = load_from_path(&path);
        assert_eq!(loaded.position, Some(Position { x: 120, y: 80 }));
    }
}
