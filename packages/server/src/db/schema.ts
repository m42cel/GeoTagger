import type Database from 'better-sqlite3';
import { generateFileId } from './uuid.js';

export const SCHEMA_VERSION = 7;

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
  id                         TEXT PRIMARY KEY,
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
  orig_alt                   REAL,
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
  file_id  TEXT    NOT NULL REFERENCES files(id)  ON DELETE CASCADE,
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
  file_id                    TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  lat                        REAL,
  lon                        REAL,
  position_source            TEXT,
  uncertainty_m              REAL,
  placed_at                  INTEGER,
  confirmed_at               INTEGER,
  pending_lat                REAL,
  pending_lon                REAL,
  utc_offset_override_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS persisted (
  file_id                TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  persisted_at           INTEGER NOT NULL,
  original_snapshot_json TEXT,
  written_tags_json      TEXT,
  exiftool_result        TEXT
);

CREATE TABLE IF NOT EXISTS oplog (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  file_id     TEXT,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT
);
`;

/** True when this store's file ids still need the UUIDv7 migration below applied. */
export function applySchema(db: Database.Database): boolean {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(STATEMENTS);
  return migrate(db);
}

/**
 * Brings a store written by an older GeoTagger up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` above only builds what is missing, so a folder that
 * was scanned under schema 1 keeps its tables exactly as they were — the columns
 * phase 1 added have to be put in by hand. Each is nullable with a harmless default,
 * so adding it is all the migration there is: a folder scanned yesterday opens today
 * without a rescan.
 *
 * Returns whether the file-id migration ran, so the caller knows to invalidate the
 * thumbnail cache (SPEC §8.2) — everything else here is columns, which nothing on
 * disk is keyed by.
 */
function migrate(db: Database.Database): boolean {
  addColumnIfMissing(db, 'files', 'gps_time_utc', 'TEXT');
  addColumnIfMissing(db, 'strips', 'utc_offset_override_minutes', 'INTEGER');
  addColumnIfMissing(db, 'utc_offset_rules', 'zone', 'TEXT');
  addColumnIfMissing(db, 'files', 'orig_alt', 'REAL');
  addColumnIfMissing(db, 'edits', 'pending_lat', 'REAL');
  addColumnIfMissing(db, 'edits', 'pending_lon', 'REAL');
  addColumnIfMissing(db, 'persisted', 'written_tags_json', 'TEXT');
  // Schema 5 recorded a whole write as `wrote_gps`/`wrote_time`/`applied_json`; 6 records
  // a value per tag in `written_tags_json` instead (SPEC §9.1). The retired columns held
  // values of a file's last write, not anything that predates GeoTagger, so there is
  // nothing in them worth carrying across.
  dropColumnIfExists(db, 'persisted', 'wrote_gps');
  dropColumnIfExists(db, 'persisted', 'wrote_time');
  dropColumnIfExists(db, 'persisted', 'applied_json');
  collapseOffsetRamp(db);
  return migrateFileIdsToUuid(db);
}

/**
 * Schema 6 → 7: file ids move from a per-folder `INTEGER PRIMARY KEY` to a UUIDv7
 * `TEXT`, unique across every folder GeoTagger ever opens (SPEC §8.2). Two folders'
 * DBs otherwise number their files from 1, and reusing a folder's own ids after a
 * rescan or a `.geotagger` reset made the thumbnail cache — which is keyed by id and
 * served with a long-lived `Cache-Control` — serve one photo's cached image for
 * another.
 *
 * SQLite has no `ALTER COLUMN`, so this follows the documented rebuild procedure:
 * new tables alongside the old ones, copied across through an id map from every old
 * id to a freshly minted UUID, then the old tables are dropped and the new ones
 * renamed into place. Nothing reads meaning into the order two file ids compare in,
 * so the map is built in whatever order the old rows come back in. `oplog.file_id`
 * has no foreign key and can be null; it maps through when set, and stays null
 * otherwise. The JSON payload columns (`before_json`, `after_json`,
 * `original_snapshot_json`, `written_tags_json`, `exiftool_result`) hold tag
 * *values*, never a file id, so nothing in them needs rewriting.
 */
function migrateFileIdsToUuid(db: Database.Database): boolean {
  const filesColumns = db.pragma('table_info(files)') as { name: string; type: string }[];
  const idColumn = filesColumns.find((c) => c.name === 'id');
  if (!idColumn || idColumn.type.toUpperCase() !== 'INTEGER') return false;

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      const oldIds = (db.prepare('SELECT id FROM files').all() as { id: number }[]).map((r) => r.id);
      const idMap = new Map<number, string>(oldIds.map((id) => [id, generateFileId()]));

      db.exec(`
        CREATE TABLE files_new (
          id                         TEXT PRIMARY KEY,
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
          orig_alt                   REAL,
          first_seen_at              INTEGER NOT NULL,
          last_scanned_at            INTEGER NOT NULL,
          missing                    INTEGER NOT NULL DEFAULT 0,
          thumb_state                TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE strip_files_new (
          strip_id INTEGER NOT NULL REFERENCES strips(id) ON DELETE CASCADE,
          file_id  TEXT    NOT NULL REFERENCES files_new(id) ON DELETE CASCADE,
          PRIMARY KEY (file_id)
        );
        CREATE TABLE edits_new (
          file_id                    TEXT PRIMARY KEY REFERENCES files_new(id) ON DELETE CASCADE,
          lat                        REAL,
          lon                        REAL,
          position_source            TEXT,
          uncertainty_m              REAL,
          placed_at                  INTEGER,
          confirmed_at               INTEGER,
          pending_lat                REAL,
          pending_lon                REAL,
          utc_offset_override_minutes INTEGER
        );
        CREATE TABLE persisted_new (
          file_id                TEXT PRIMARY KEY REFERENCES files_new(id) ON DELETE CASCADE,
          persisted_at           INTEGER NOT NULL,
          original_snapshot_json TEXT,
          written_tags_json      TEXT,
          exiftool_result        TEXT
        );
        CREATE TABLE oplog_new (
          id          INTEGER PRIMARY KEY,
          ts          INTEGER NOT NULL,
          file_id     TEXT,
          action      TEXT NOT NULL,
          before_json TEXT,
          after_json  TEXT,
          ok          INTEGER NOT NULL DEFAULT 1,
          error       TEXT
        );
      `);

      const insertFile = db.prepare(`
        INSERT INTO files_new (id, rel_path, filename, ext, kind, size_bytes, mtime, content_sig,
                                device_id, width, height, duration_ms, orientation, capture_time_raw,
                                capture_time_source, capture_utc_offset_minutes, gps_time_utc,
                                orig_gps_present, orig_lat, orig_lon, orig_alt, first_seen_at,
                                last_scanned_at, missing, thumb_state)
        VALUES (@id, @rel_path, @filename, @ext, @kind, @size_bytes, @mtime, @content_sig,
                @device_id, @width, @height, @duration_ms, @orientation, @capture_time_raw,
                @capture_time_source, @capture_utc_offset_minutes, @gps_time_utc,
                @orig_gps_present, @orig_lat, @orig_lon, @orig_alt, @first_seen_at,
                @last_scanned_at, @missing, 'pending')
      `);
      for (const row of db.prepare('SELECT * FROM files').all() as Record<string, unknown>[]) {
        insertFile.run({ ...row, id: idMap.get(row.id as number) });
      }

      const insertStripFile = db.prepare(
        'INSERT INTO strip_files_new (strip_id, file_id) VALUES (?, ?)',
      );
      for (const row of db.prepare('SELECT strip_id, file_id FROM strip_files').all() as {
        strip_id: number;
        file_id: number;
      }[]) {
        const newId = idMap.get(row.file_id);
        if (newId) insertStripFile.run(row.strip_id, newId);
      }

      const insertEdit = db.prepare(`
        INSERT INTO edits_new (file_id, lat, lon, position_source, uncertainty_m, placed_at,
                                confirmed_at, pending_lat, pending_lon, utc_offset_override_minutes)
        VALUES (@file_id, @lat, @lon, @position_source, @uncertainty_m, @placed_at,
                @confirmed_at, @pending_lat, @pending_lon, @utc_offset_override_minutes)
      `);
      for (const row of db.prepare('SELECT * FROM edits').all() as Record<string, unknown>[]) {
        const newId = idMap.get(row.file_id as number);
        if (newId) insertEdit.run({ ...row, file_id: newId });
      }

      const insertPersisted = db.prepare(`
        INSERT INTO persisted_new (file_id, persisted_at, original_snapshot_json,
                                    written_tags_json, exiftool_result)
        VALUES (@file_id, @persisted_at, @original_snapshot_json, @written_tags_json, @exiftool_result)
      `);
      for (const row of db.prepare('SELECT * FROM persisted').all() as Record<string, unknown>[]) {
        const newId = idMap.get(row.file_id as number);
        if (newId) insertPersisted.run({ ...row, file_id: newId });
      }

      const insertOplog = db.prepare(`
        INSERT INTO oplog_new (id, ts, file_id, action, before_json, after_json, ok, error)
        VALUES (@id, @ts, @file_id, @action, @before_json, @after_json, @ok, @error)
      `);
      for (const row of db.prepare('SELECT * FROM oplog').all() as Record<string, unknown>[]) {
        const oldFileId = row.file_id as number | null;
        insertOplog.run({ ...row, file_id: oldFileId === null ? null : (idMap.get(oldFileId) ?? null) });
      }

      db.exec(`
        DROP TABLE strip_files;
        DROP TABLE edits;
        DROP TABLE persisted;
        DROP TABLE oplog;
        DROP TABLE files;
        ALTER TABLE files_new RENAME TO files;
        ALTER TABLE strip_files_new RENAME TO strip_files;
        ALTER TABLE edits_new RENAME TO edits;
        ALTER TABLE persisted_new RENAME TO persisted;
        ALTER TABLE oplog_new RENAME TO oplog;

        CREATE INDEX files_capture_time ON files(capture_time_raw);
        CREATE INDEX files_device       ON files(device_id);
        CREATE INDEX files_thumb_state  ON files(thumb_state);
        CREATE INDEX strip_files_strip  ON strip_files(strip_id);
      `);

      const violations = db.pragma('foreign_key_check');
      if (Array.isArray(violations) && violations.length > 0) {
        throw new Error(`file-id migration left dangling foreign keys: ${JSON.stringify(violations)}`);
      }
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
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

function dropColumnIfExists(db: Database.Database, table: string, column: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
