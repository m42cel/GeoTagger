import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * The per-folder edit store (SPEC §8.2).
 *
 * The whole schema is created up front even though phase 0 only writes to
 * `meta`, `files`, `devices`, `strips` and `strip_files`: the later tables cost
 * nothing empty, and creating them now means a folder scanned in phase 0 needs no
 * migration when phase 1 starts writing corrections into it.
 */
const STATEMENTS = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id       TEXT PRIMARY KEY,
  make     TEXT,
  model    TEXT,
  serial   TEXT,
  label    TEXT NOT NULL,
  group_id INTEGER REFERENCES device_groups(id)
);

CREATE TABLE IF NOT EXISTS device_groups (
  id    INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id                         INTEGER PRIMARY KEY,
  rel_path                   TEXT NOT NULL UNIQUE,
  filename                   TEXT NOT NULL,
  ext                        TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  size_bytes                 INTEGER NOT NULL,
  mtime                      INTEGER NOT NULL,
  content_sig                TEXT NOT NULL,
  device_id                  TEXT REFERENCES devices(id),
  width                      INTEGER,
  height                     INTEGER,
  duration_ms                INTEGER,
  orientation                INTEGER,
  capture_time_raw           TEXT,
  capture_time_source        TEXT NOT NULL DEFAULT 'none',
  capture_utc_offset_minutes INTEGER,
  orig_gps_present           INTEGER NOT NULL DEFAULT 0,
  orig_lat                   REAL,
  orig_lon                   REAL,
  first_seen_at              INTEGER NOT NULL,
  last_scanned_at            INTEGER NOT NULL,
  missing                    INTEGER NOT NULL DEFAULT 0,
  thumb_state                TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS files_capture_time ON files(capture_time_raw);
CREATE INDEX IF NOT EXISTS files_device       ON files(device_id);
CREATE INDEX IF NOT EXISTS files_thumb_state  ON files(thumb_state);

CREATE TABLE IF NOT EXISTS strips (
  id                    INTEGER PRIMARY KEY,
  lane                  INTEGER NOT NULL DEFAULT 0,
  ordinal               INTEGER NOT NULL DEFAULT 0,
  label                 TEXT NOT NULL,
  grouping_source       TEXT NOT NULL,
  parent_strip_id       INTEGER REFERENCES strips(id),
  offset_start_seconds  INTEGER NOT NULL DEFAULT 0,
  offset_end_seconds    INTEGER NOT NULL DEFAULT 0,
  locked                INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strip_files (
  strip_id INTEGER NOT NULL REFERENCES strips(id) ON DELETE CASCADE,
  file_id  INTEGER NOT NULL REFERENCES files(id)  ON DELETE CASCADE,
  PRIMARY KEY (file_id)
);

CREATE INDEX IF NOT EXISTS strip_files_strip ON strip_files(strip_id);

CREATE TABLE IF NOT EXISTS utc_offset_rules (
  id             INTEGER PRIMARY KEY,
  from_utc       INTEGER NOT NULL,
  to_utc         INTEGER NOT NULL,
  offset_minutes INTEGER NOT NULL,
  source         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edits (
  file_id                    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  lat                        REAL,
  lon                        REAL,
  position_source            TEXT,
  uncertainty_m              REAL,
  placed_at                  INTEGER,
  confirmed_at               INTEGER,
  utc_offset_override_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS persisted (
  file_id                INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  persisted_at           INTEGER NOT NULL,
  wrote_gps              INTEGER NOT NULL DEFAULT 0,
  wrote_time             INTEGER NOT NULL DEFAULT 0,
  original_snapshot_json TEXT,
  exiftool_result        TEXT
);

CREATE TABLE IF NOT EXISTS oplog (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  file_id     INTEGER,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT
);
`;

export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(STATEMENTS);
}
