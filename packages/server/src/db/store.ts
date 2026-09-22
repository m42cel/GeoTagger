import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CaptureTimeSource,
  DeviceRecord,
  FileRecord,
  GroupingMode,
  MediaKind,
  StripRecord,
  ThumbState,
} from '@geotagger/shared';
import { applySchema, SCHEMA_VERSION } from './schema.js';

export const GEOTAGGER_DIR = '.geotagger';
export const DB_FILENAME = 'edits.sqlite';
export const THUMBS_DIRNAME = 'thumbs';

/** What the scanner knows about a file on disk before metadata has been read. */
export interface ScannedFile {
  relPath: string;
  filename: string;
  ext: string;
  kind: MediaKind;
  sizeBytes: number;
  mtime: number;
}

/** Metadata resolved from a file, written on top of its index row. */
export interface FileMetadata {
  deviceId: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number | null;
  captureTimeRaw: string | null;
  captureTimeSource: CaptureTimeSource;
  captureUtcOffsetMinutes: number | null;
  origGpsPresent: boolean;
  origLat: number | null;
  origLon: number | null;
}

export type FileChange = 'added' | 'changed' | 'unchanged';

interface FileRow {
  id: number;
  rel_path: string;
  filename: string;
  ext: string;
  kind: string;
  size_bytes: number;
  mtime: number;
  content_sig: string;
  device_id: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  orientation: number | null;
  capture_time_raw: string | null;
  capture_time_source: string;
  capture_utc_offset_minutes: number | null;
  orig_gps_present: number;
  orig_lat: number | null;
  orig_lon: number | null;
  first_seen_at: number;
  last_scanned_at: number;
  missing: number;
  thumb_state: string;
}

/**
 * `size` + `mtime` identify a file's content for change detection (SPEC §8.3).
 * Content hashing is deliberately avoided as too expensive on a slow NAS.
 */
export function contentSig(sizeBytes: number, mtime: number): string {
  return `${sizeBytes}:${mtime}`;
}

function rowToFile(r: FileRow): FileRecord {
  return {
    id: r.id,
    relPath: r.rel_path,
    filename: r.filename,
    ext: r.ext,
    kind: r.kind as MediaKind,
    sizeBytes: r.size_bytes,
    mtime: r.mtime,
    deviceId: r.device_id,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    orientation: r.orientation,
    captureTimeRaw: r.capture_time_raw,
    captureTimeSource: r.capture_time_source as CaptureTimeSource,
    captureUtcOffsetMinutes: r.capture_utc_offset_minutes,
    origGpsPresent: r.orig_gps_present !== 0,
    origLat: r.orig_lat,
    origLon: r.orig_lon,
    firstSeenAt: r.first_seen_at,
    lastScannedAt: r.last_scanned_at,
    missing: r.missing !== 0,
    thumbState: r.thumb_state as ThumbState,
  };
}

/**
 * The edit store for one photo folder, living in `<folder>/.geotagger/edits.sqlite`
 * so that it travels with the photos (SPEC §8.1).
 */
export class FolderStore {
  readonly db: Database.Database;
  readonly folderPath: string;
  readonly stateDir: string;
  readonly thumbsDir: string;

  private constructor(db: Database.Database, folderPath: string, stateDir: string) {
    this.db = db;
    this.folderPath = folderPath;
    this.stateDir = stateDir;
    this.thumbsDir = path.join(stateDir, THUMBS_DIRNAME);
  }

  static dbPathFor(folderPath: string): string {
    return path.join(folderPath, GEOTAGGER_DIR, DB_FILENAME);
  }

  /** True when this folder has been opened before. Drives the reopen summary (SPEC §6.1). */
  static isKnown(folderPath: string): boolean {
    return fs.existsSync(FolderStore.dbPathFor(folderPath));
  }

  static open(folderPath: string): FolderStore {
    const stateDir = path.join(folderPath, GEOTAGGER_DIR);
    fs.mkdirSync(path.join(stateDir, THUMBS_DIRNAME), { recursive: true });
    const db = new Database(path.join(stateDir, DB_FILENAME));
    applySchema(db);
    const store = new FolderStore(db, folderPath, stateDir);
    store.initMeta();
    return store;
  }

  private initMeta(): void {
    const existing = this.getMeta('schema_version');
    if (existing === null) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.setMeta('folder_id', crypto.randomUUID());
      this.setMeta('created_at', String(Date.now()));
      return;
    }
    const found = Number.parseInt(existing, 10);
    if (found > SCHEMA_VERSION) {
      throw new Error(
        `${DB_FILENAME} was written by a newer GeoTagger (schema ${found} > ${SCHEMA_VERSION})`,
      );
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare<[string], { value: string }>(
      'SELECT value FROM meta WHERE key = ?',
    ).get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  get folderId(): string {
    return this.getMeta('folder_id') ?? '';
  }

  get groupingMode(): GroupingMode {
    return (this.getMeta('grouping_mode') as GroupingMode | null) ?? 'device';
  }

  set groupingMode(mode: GroupingMode) {
    this.setMeta('grouping_mode', mode);
  }

  close(): void {
    this.db.close();
  }

  // ---- files -------------------------------------------------------------

  /**
   * Inserts or refreshes a file's index row and reports whether it is new, changed
   * or untouched since the last scan. Only changed files need their metadata re-read.
   */
  upsertScanned(f: ScannedFile, now: number): { id: number; change: FileChange } {
    const sig = contentSig(f.sizeBytes, f.mtime);
    const existing = this.db
      .prepare<[string], { id: number; content_sig: string; missing: number }>(
        'SELECT id, content_sig, missing FROM files WHERE rel_path = ?',
      )
      .get(f.relPath);

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO files (rel_path, filename, ext, kind, size_bytes, mtime, content_sig,
                              first_seen_at, last_scanned_at, missing, thumb_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
        )
        .run(f.relPath, f.filename, f.ext, f.kind, f.sizeBytes, f.mtime, sig, now, now);
      return { id: Number(info.lastInsertRowid), change: 'added' };
    }

    const changed = existing.content_sig !== sig;
    this.db
      .prepare(
        `UPDATE files SET size_bytes = ?, mtime = ?, content_sig = ?, last_scanned_at = ?, missing = 0,
                          thumb_state = CASE WHEN ? THEN 'pending' ELSE thumb_state END
         WHERE id = ?`,
      )
      .run(f.sizeBytes, f.mtime, sig, now, changed ? 1 : 0, existing.id);
    return { id: existing.id, change: changed ? 'changed' : 'unchanged' };
  }

  /**
   * Writes a file's resolved metadata, inserting its device first.
   *
   * The two go together in one transaction because `files.device_id` is a foreign
   * key: writing the metadata of a newly seen camera before the camera itself would
   * fail, and doing it in two calls leaves that ordering to every caller to remember.
   */
  applyScanResult(fileId: number, m: FileMetadata, device: DeviceRecord | null): void {
    const tx = this.db.transaction(() => {
      if (device) this.upsertDevice(device);
      this.applyMetadata(fileId, m);
    });
    tx();
  }

  applyMetadata(fileId: number, m: FileMetadata): void {
    this.db
      .prepare(
        `UPDATE files SET device_id = ?, width = ?, height = ?, duration_ms = ?, orientation = ?,
                          capture_time_raw = ?, capture_time_source = ?, capture_utc_offset_minutes = ?,
                          orig_gps_present = ?, orig_lat = ?, orig_lon = ?
         WHERE id = ?`,
      )
      .run(
        m.deviceId,
        m.width,
        m.height,
        m.durationMs,
        m.orientation,
        m.captureTimeRaw,
        m.captureTimeSource,
        m.captureUtcOffsetMinutes,
        m.origGpsPresent ? 1 : 0,
        m.origLat,
        m.origLon,
        fileId,
      );
  }

  /** Flags files that were in the index but not seen by this scan. */
  markMissingExcept(seenIds: Iterable<number>): number {
    const keep = new Set(seenIds);
    const rows = this.db.prepare<[], { id: number }>('SELECT id FROM files WHERE missing = 0').all();
    const gone = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
    const stmt = this.db.prepare('UPDATE files SET missing = 1 WHERE id = ?');
    const tx = this.db.transaction((ids: number[]) => ids.forEach((id) => stmt.run(id)));
    tx(gone);
    return gone.length;
  }

  setThumbState(fileId: number, state: ThumbState): void {
    this.db.prepare('UPDATE files SET thumb_state = ? WHERE id = ?').run(state, fileId);
  }

  getFile(id: number): FileRecord | null {
    const row = this.db.prepare<[number], FileRow>('SELECT * FROM files WHERE id = ?').get(id);
    return row ? rowToFile(row) : null;
  }

  listFiles(): FileRecord[] {
    return this.db
      .prepare<[], FileRow>(
        'SELECT * FROM files WHERE missing = 0 ORDER BY capture_time_raw IS NULL, capture_time_raw, rel_path',
      )
      .all()
      .map(rowToFile);
  }

  fileCount(): number {
    const row = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM files WHERE missing = 0')
      .get();
    return row?.n ?? 0;
  }

  pendingThumbIds(): number[] {
    return this.db
      .prepare<[], { id: number }>(
        "SELECT id FROM files WHERE missing = 0 AND thumb_state = 'pending' ORDER BY id",
      )
      .all()
      .map((r) => r.id);
  }

  // ---- devices -----------------------------------------------------------

  upsertDevice(d: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, make, model, serial, label) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET make = excluded.make, model = excluded.model,
                                       serial = excluded.serial, label = excluded.label`,
      )
      .run(d.id, d.make, d.model, d.serial, d.label);
  }

  listDevices(): DeviceRecord[] {
    return this.db
      .prepare<[], { id: string; make: string | null; model: string | null; serial: string | null; label: string }>(
        'SELECT id, make, model, serial, label FROM devices ORDER BY label',
      )
      .all();
  }

  // ---- strips ------------------------------------------------------------

  /** Replaces every strip with a freshly built set. Switching grouping mode rebuilds from scratch (SPEC §4.4). */
  replaceStrips(
    mode: GroupingMode,
    built: { label: string; lane: number; ordinal: number; fileIds: number[] }[],
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM strip_files');
      this.db.exec('DELETE FROM strips');
      const insertStrip = this.db.prepare(
        `INSERT INTO strips (lane, ordinal, label, grouping_source, offset_start_seconds,
                             offset_end_seconds, locked, created_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
      );
      const insertMember = this.db.prepare(
        'INSERT INTO strip_files (strip_id, file_id) VALUES (?, ?)',
      );
      for (const s of built) {
        const id = Number(insertStrip.run(s.lane, s.ordinal, s.label, mode, now).lastInsertRowid);
        for (const fileId of s.fileIds) insertMember.run(id, fileId);
      }
      this.groupingMode = mode;
    });
    tx();
  }

  listStrips(): StripRecord[] {
    const rows = this.db
      .prepare<[], {
        id: number; lane: number; ordinal: number; label: string; grouping_source: string;
        parent_strip_id: number | null; offset_start_seconds: number; offset_end_seconds: number;
        locked: number; created_at: number; file_count: number;
        first_capture: string | null; last_capture: string | null;
      }>(
        `SELECT s.*, COUNT(f.id) AS file_count,
                MIN(f.capture_time_raw) AS first_capture,
                MAX(f.capture_time_raw) AS last_capture
         FROM strips s
         LEFT JOIN strip_files sf ON sf.strip_id = s.id
         LEFT JOIN files f ON f.id = sf.file_id AND f.missing = 0
         GROUP BY s.id
         ORDER BY s.lane, s.ordinal`,
      )
      .all();
    return rows.map((r) => ({
      id: r.id,
      lane: r.lane,
      ordinal: r.ordinal,
      label: r.label,
      groupingSource: r.grouping_source as GroupingMode,
      parentStripId: r.parent_strip_id,
      offsetStartSeconds: r.offset_start_seconds,
      offsetEndSeconds: r.offset_end_seconds,
      locked: r.locked !== 0,
      createdAt: r.created_at,
      fileCount: r.file_count,
      firstCaptureMs: parseNaive(r.first_capture),
      lastCaptureMs: parseNaive(r.last_capture),
    }));
  }

  stripAssignments(): Record<number, number> {
    const rows = this.db
      .prepare<[], { file_id: number; strip_id: number }>('SELECT file_id, strip_id FROM strip_files')
      .all();
    const out: Record<number, number> = {};
    for (const r of rows) out[r.file_id] = r.strip_id;
    return out;
  }

  /** Files with no strip — everything scanned after the last grouping run. */
  unassignedFileIds(): number[] {
    return this.db
      .prepare<[], { id: number }>(
        `SELECT f.id FROM files f
         LEFT JOIN strip_files sf ON sf.file_id = f.id
         WHERE f.missing = 0 AND sf.file_id IS NULL`,
      )
      .all()
      .map((r) => r.id);
  }
}

/** Naive local ISO string to epoch ms, read as if UTC so comparisons stay ordinal. */
function parseNaive(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}
