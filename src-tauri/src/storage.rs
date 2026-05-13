//! SQLite-backed storage for Phase 2 manual rows.
//!
//! Only manual rows live in SQLite — overlay settings stay in the JSON file
//! Phase 1 introduced (`app_config_dir/settings.json`). Secrets never touch
//! either store; OS credential storage will host them when Phase 3 lands.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use thiserror::Error;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::model::{ManualRow, ManualRowInput, UsageMetric, UsageWindow};

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error opening database: {0}")]
    Io(#[from] std::io::Error),
    #[error("manual row not found: {0}")]
    NotFound(String),
    #[error("invalid value: {0}")]
    InvalidValue(String),
}

impl Serialize for StorageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Thread-safe wrapper around a single rusqlite `Connection`. The connection
/// is held behind a `std::sync::Mutex` so writers are serialized; reads share
/// the same lock to keep things simple at Phase 2 scale.
pub struct Storage {
    conn: Arc<Mutex<Connection>>,
}

impl Storage {
    /// Open (and create if missing) a SQLite database at `path`.
    pub fn open(path: PathBuf) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        Self::initialize(conn)
    }

    /// Open an in-memory database — used by tests.
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory()?;
        Self::initialize(conn)
    }

    fn initialize(conn: Connection) -> Result<Self, StorageError> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        let storage = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        storage.migrate()?;
        Ok(storage)
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("storage connection mutex poisoned")
    }

    pub fn migrate(&self) -> Result<(), StorageError> {
        let conn = self.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
             INSERT OR IGNORE INTO schema_version(version) VALUES (1);

             CREATE TABLE IF NOT EXISTS manual_rows (
               id              TEXT PRIMARY KEY,
               provider_label  TEXT NOT NULL,
               account_label   TEXT NOT NULL,
               window          TEXT NOT NULL CHECK (window IN
                                 ('one-minute','five-hours','daily','weekly','monthly','api','unknown')),
               metric          TEXT NOT NULL CHECK (metric IN
                                 ('requests','tokens','input-tokens','output-tokens','messages','percent','unknown')),
               limit_value     INTEGER,
               used_value      INTEGER,
               remaining_value INTEGER,
               reset_at        TEXT,
               note            TEXT,
               created_at      TEXT NOT NULL,
               updated_at      TEXT NOT NULL
             );",
        )?;
        Ok(())
    }

    pub fn list_manual_rows(&self) -> Result<Vec<ManualRow>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, provider_label, account_label, window, metric,
                    limit_value, used_value, remaining_value, reset_at, note,
                    created_at, updated_at
             FROM manual_rows ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_manual_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_manual_row(&self, id: &str) -> Result<Option<ManualRow>, StorageError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, provider_label, account_label, window, metric,
                    limit_value, used_value, remaining_value, reset_at, note,
                    created_at, updated_at
             FROM manual_rows WHERE id = ?1",
        )?;
        let row = stmt
            .query_row(params![id], row_to_manual_row)
            .optional()?;
        Ok(row)
    }

    pub fn create_manual_row(
        &self,
        input: &ManualRowInput,
    ) -> Result<ManualRow, StorageError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let row = ManualRow {
            id: id.clone(),
            provider_label: input.provider_label.clone(),
            account_label: input.account_label.clone(),
            window: input.window,
            metric: input.metric,
            limit: input.limit,
            used: input.used,
            remaining: input.remaining,
            reset_at: input.reset_at.clone(),
            note: input.note.clone(),
            created_at: now.clone(),
            updated_at: now,
        };
        let conn = self.lock();
        conn.execute(
            "INSERT INTO manual_rows (
               id, provider_label, account_label, window, metric,
               limit_value, used_value, remaining_value, reset_at, note,
               created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                row.id,
                row.provider_label,
                row.account_label,
                window_to_str(row.window),
                metric_to_str(row.metric),
                row.limit,
                row.used,
                row.remaining,
                row.reset_at,
                row.note,
                row.created_at,
                row.updated_at,
            ],
        )?;
        Ok(row)
    }

    pub fn update_manual_row(
        &self,
        id: &str,
        input: &ManualRowInput,
    ) -> Result<ManualRow, StorageError> {
        let updated_at = now_rfc3339();
        {
            let conn = self.lock();
            let affected = conn.execute(
                "UPDATE manual_rows SET
                   provider_label  = ?1,
                   account_label   = ?2,
                   window          = ?3,
                   metric          = ?4,
                   limit_value     = ?5,
                   used_value      = ?6,
                   remaining_value = ?7,
                   reset_at        = ?8,
                   note            = ?9,
                   updated_at      = ?10
                 WHERE id = ?11",
                params![
                    input.provider_label,
                    input.account_label,
                    window_to_str(input.window),
                    metric_to_str(input.metric),
                    input.limit,
                    input.used,
                    input.remaining,
                    input.reset_at,
                    input.note,
                    updated_at,
                    id,
                ],
            )?;
            if affected == 0 {
                return Err(StorageError::NotFound(id.to_string()));
            }
        }
        self.get_manual_row(id)?
            .ok_or_else(|| StorageError::NotFound(id.to_string()))
    }

    pub fn delete_manual_row(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.lock();
        let affected = conn.execute("DELETE FROM manual_rows WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(StorageError::NotFound(id.to_string()));
        }
        Ok(())
    }
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00Z"))
}

fn row_to_manual_row(row: &Row<'_>) -> rusqlite::Result<ManualRow> {
    let window_str: String = row.get(3)?;
    let metric_str: String = row.get(4)?;
    Ok(ManualRow {
        id: row.get(0)?,
        provider_label: row.get(1)?,
        account_label: row.get(2)?,
        window: window_from_str(&window_str)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e)))?,
        metric: metric_from_str(&metric_str)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e)))?,
        limit: row.get(5)?,
        used: row.get(6)?,
        remaining: row.get(7)?,
        reset_at: row.get(8)?,
        note: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn window_to_str(w: UsageWindow) -> &'static str {
    match w {
        UsageWindow::OneMinute => "one-minute",
        UsageWindow::FiveHours => "five-hours",
        UsageWindow::Daily => "daily",
        UsageWindow::Weekly => "weekly",
        UsageWindow::Monthly => "monthly",
        UsageWindow::Api => "api",
        UsageWindow::Unknown => "unknown",
    }
}

fn metric_to_str(m: UsageMetric) -> &'static str {
    match m {
        UsageMetric::Requests => "requests",
        UsageMetric::Tokens => "tokens",
        UsageMetric::InputTokens => "input-tokens",
        UsageMetric::OutputTokens => "output-tokens",
        UsageMetric::Messages => "messages",
        UsageMetric::Percent => "percent",
        UsageMetric::Unknown => "unknown",
    }
}

#[derive(Debug, Error)]
#[error("invalid {field}: {value}")]
struct EnumParseError {
    field: &'static str,
    value: String,
}

fn window_from_str(s: &str) -> Result<UsageWindow, EnumParseError> {
    Ok(match s {
        "one-minute" => UsageWindow::OneMinute,
        "five-hours" => UsageWindow::FiveHours,
        "daily" => UsageWindow::Daily,
        "weekly" => UsageWindow::Weekly,
        "monthly" => UsageWindow::Monthly,
        "api" => UsageWindow::Api,
        "unknown" => UsageWindow::Unknown,
        other => {
            return Err(EnumParseError {
                field: "window",
                value: other.to_string(),
            })
        }
    })
}

fn metric_from_str(s: &str) -> Result<UsageMetric, EnumParseError> {
    Ok(match s {
        "requests" => UsageMetric::Requests,
        "tokens" => UsageMetric::Tokens,
        "input-tokens" => UsageMetric::InputTokens,
        "output-tokens" => UsageMetric::OutputTokens,
        "messages" => UsageMetric::Messages,
        "percent" => UsageMetric::Percent,
        "unknown" => UsageMetric::Unknown,
        other => {
            return Err(EnumParseError {
                field: "metric",
                value: other.to_string(),
            })
        }
    })
}

/// Test-only helper to build a storage backed by a freshly-created file in a
/// temp directory. Lives behind `cfg(test)` so it never appears in production.
#[cfg(test)]
pub fn open_temp(dir: &Path) -> Result<Storage, StorageError> {
    Storage::open(dir.join("test.sqlite3"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{UsageMetric, UsageWindow};

    fn sample_input(label: &str) -> ManualRowInput {
        ManualRowInput {
            provider_label: "ChatGPT".into(),
            account_label: label.into(),
            window: UsageWindow::FiveHours,
            metric: UsageMetric::Messages,
            limit: Some(40),
            used: Some(8),
            remaining: Some(32),
            reset_at: Some("2026-05-13T17:00:00Z".into()),
            note: Some("plus plan".into()),
        }
    }

    #[test]
    fn migrate_is_idempotent() {
        let storage = Storage::open_in_memory().unwrap();
        storage.migrate().unwrap();
        storage.migrate().unwrap();
    }

    #[test]
    fn empty_db_lists_zero_rows() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.list_manual_rows().unwrap().is_empty());
    }

    #[test]
    fn create_then_list_round_trip() {
        let storage = Storage::open_in_memory().unwrap();
        let row = storage.create_manual_row(&sample_input("personal")).unwrap();
        let rows = storage.list_manual_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, row.id);
        assert_eq!(rows[0].account_label, "personal");
        assert_eq!(rows[0].window, UsageWindow::FiveHours);
        assert_eq!(rows[0].metric, UsageMetric::Messages);
        assert_eq!(rows[0].limit, Some(40));
        assert_eq!(rows[0].remaining, Some(32));
        assert!(!rows[0].created_at.is_empty());
        assert_eq!(rows[0].created_at, rows[0].updated_at);
    }

    #[test]
    fn update_modifies_existing_row() {
        let storage = Storage::open_in_memory().unwrap();
        let created = storage.create_manual_row(&sample_input("personal")).unwrap();
        let mut input = sample_input("work");
        input.note = Some("team plan".into());
        let updated = storage.update_manual_row(&created.id, &input).unwrap();
        assert_eq!(updated.account_label, "work");
        assert_eq!(updated.note.as_deref(), Some("team plan"));
        assert_eq!(updated.created_at, created.created_at);
        // updated_at should be no earlier than created_at.
        assert!(updated.updated_at.as_str() >= created.created_at.as_str());
    }

    #[test]
    fn update_unknown_id_returns_not_found() {
        let storage = Storage::open_in_memory().unwrap();
        let err = storage
            .update_manual_row("missing", &sample_input("x"))
            .unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
    }

    #[test]
    fn delete_removes_row() {
        let storage = Storage::open_in_memory().unwrap();
        let created = storage.create_manual_row(&sample_input("a")).unwrap();
        storage.delete_manual_row(&created.id).unwrap();
        assert!(storage.list_manual_rows().unwrap().is_empty());
    }

    #[test]
    fn delete_unknown_id_returns_not_found() {
        let storage = Storage::open_in_memory().unwrap();
        let err = storage.delete_manual_row("missing").unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
    }

    #[test]
    fn file_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = open_temp(tmp.path()).unwrap();
        let created = storage.create_manual_row(&sample_input("x")).unwrap();
        drop(storage);
        let storage2 = open_temp(tmp.path()).unwrap();
        let rows = storage2.list_manual_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, created.id);
    }
}
