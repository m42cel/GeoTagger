import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

/**
 * The per-folder edit store (SPEC §8.2).
 *
 * The whole schema is created up front even though phase 1 still writes nothing to
 * `edits`: the later tables cost nothing empty, and creating them now means a folder
 * scanned today needs no migration when phase 4 starts writing positions into it.
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
  gps_time_utc               TEXT,
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
  offset_seconds        INTEGER NOT NULL DEFAULT 0,
  locked                INTEGER NOT NULL DEFAULT 0,
  utc_offset_override_minutes INTEGER,
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
  source         TEXT NOT NULL,
  zone           TEXT
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
  applied_json           TEXT,
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
  migrate(db);
}

/**
 * Brings a store written by an older GeoTagger up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` above only builds what is missing, so a folder that
 * was scanned under schema 1 keeps its tables exactly as they were — the columns
 * phase 1 added have to be put in by hand. Each is nullable with a harmless default,
 * so adding it is all the migration there is: a folder scanned yesterday opens today
 * without a rescan.
 */
function migrate(db: Database.Database): void {
  addColumnIfMissing(db, 'files', 'gps_time_utc', 'TEXT');
  addColumnIfMissing(db, 'strips', 'utc_offset_override_minutes', 'INTEGER');
  addColumnIfMissing(db, 'utc_offset_rules', 'zone', 'TEXT');
  addColumnIfMissing(db, 'persisted', 'applied_json', 'TEXT');
  collapseOffsetRamp(db);
}

/**
 * Schema 2 stored a correction as a ramp — one offset at the strip's first file and
 * another at its last — for the stretch gesture that schema 3 drops (SPEC §4.3). The
 * start offset *is* the correction for every strip that was never stretched, and is
 * the honest reading of one that was: the ramp is gone, so the whole strip takes the
 * offset its earliest file had.
 *
 * The old columns are dropped rather than left behind, because `snapshotStrips` reads
 * a strip row with `SELECT *` and feeds it straight back to a named-parameter insert;
 * a column nothing binds would make every undo throw.
 */
function collapseOffsetRamp(db: Database.Database): void {
  const columns = (db.pragma('table_info(strips)') as { name: string }[]).map((c) => c.name);
  if (!columns.includes('offset_start_seconds')) return;
  if (!columns.includes('offset_seconds')) {
    db.exec('ALTER TABLE strips ADD COLUMN offset_seconds INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('UPDATE strips SET offset_seconds = offset_start_seconds');
  db.exec('ALTER TABLE strips DROP COLUMN offset_start_seconds');
  db.exec('ALTER TABLE strips DROP COLUMN offset_end_seconds');
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
