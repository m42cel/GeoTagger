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
  OplogEntry,
  StripRecord,
  ThumbState,
  UtcOffsetRule,
} from '@geotagger/shared';
import { applySchema, SCHEMA_VERSION } from './schema.js';
import type { DraftUtcOffsetRule } from '../time/utc-offset.js';

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
  gpsTimeUtc: string | null;
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
  gps_time_utc: string | null;
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

/**
 * The one place a `stat` becomes a signature.
 *
 * `mtimeMs` carries sub-millisecond precision on some filesystems, so how it is
 * reduced to an integer has to be identical everywhere — a scan that floors and a
 * write that rounds disagree about every file whose mtime has a fraction, and every
 * one of them looks as though somebody else had changed it.
 */
export function signatureOf(stat: { size: number; mtimeMs: number }): { sizeBytes: number; mtime: number; sig: string } {
  const mtime = Math.floor(stat.mtimeMs);
  return { sizeBytes: stat.size, mtime, sig: contentSig(stat.size, mtime) };
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
    gpsTimeUtc: r.gps_time_utc,
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
    // `applySchema` has already added whatever columns an older store was missing, so
    // recording the new version is all that remains of the upgrade.
    if (found < SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /** Minutes east of UTC, from the one-off question of SPEC §4.2; null if never asked. */
  get folderUtcOffsetMinutes(): number | null {
    const raw = this.getMeta('folder_utc_offset_minutes');
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  set folderUtcOffsetMinutes(minutes: number | null) {
    if (minutes === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run('folder_utc_offset_minutes');
    else this.setMeta('folder_utc_offset_minutes', String(Math.round(minutes)));
  }

  /**
   * Whether the startup question of SPEC §6.1 has been answered for this folder.
   *
   * The question itself is always asked without pre-analysis, but asking it again on
   * every reopen of a folder whose timestamps were fixed weeks ago would be noise.
   */
  get timestampQuestionAnswered(): boolean {
    return this.getMeta('timestamp_question_answered') === '1';
  }

  set timestampQuestionAnswered(answered: boolean) {
    this.setMeta('timestamp_question_answered', answered ? '1' : '0');
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
    return (this.getMeta('grouping_mode') as GroupingMode | null) ?? 'subfolder';
  }

  set groupingMode(mode: GroupingMode) {
    this.setMeta('grouping_mode', mode);
  }

  /**
   * Whether the user has chosen how to group the initial strips for this folder
   * (SPEC §4.4). Strips are not built from a scan until this is true.
   */
  get groupingModeAnswered(): boolean {
    return this.getMeta('grouping_mode_answered') === '1';
  }

  set groupingModeAnswered(answered: boolean) {
    this.setMeta('grouping_mode_answered', answered ? '1' : '0');
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
                          gps_time_utc = ?, orig_gps_present = ?, orig_lat = ?, orig_lon = ?
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
        m.gpsTimeUtc,
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
        `INSERT INTO strips (lane, ordinal, label, grouping_source, offset_seconds,
                             locked, created_at)
         VALUES (?, ?, ?, ?, 0, 0, ?)`,
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
        parent_strip_id: number | null; offset_seconds: number;
        locked: number; utc_offset_override_minutes: number | null;
        created_at: number; file_count: number;
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
      offsetSeconds: r.offset_seconds,
      locked: r.locked !== 0,
      utcOffsetOverrideMinutes: r.utc_offset_override_minutes,
      createdAt: r.created_at,
      fileCount: r.file_count,
      firstCaptureMs: parseNaive(r.first_capture),
      lastCaptureMs: parseNaive(r.last_capture),
      // Filled in by `buildTimeline`, which is the only thing that knows the UTC
      // offsets these bounds depend on.
      firstEffectiveMs: null,
      lastEffectiveMs: null,
    }));
  }

  getStrip(id: number): StripRecord | null {
    return this.listStrips().find((s) => s.id === id) ?? null;
  }

  /** The files of one strip, in capture order. */
  stripMemberIds(stripId: number): number[] {
    return this.db
      .prepare<[number], { file_id: number }>(
        `SELECT sf.file_id FROM strip_files sf
         JOIN files f ON f.id = sf.file_id
         WHERE sf.strip_id = ?
         ORDER BY f.capture_time_raw IS NULL, f.capture_time_raw, f.rel_path`,
      )
      .all(stripId)
      .map((r) => r.file_id);
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

  // ---- strip edits (SPEC §4.3) -------------------------------------------

  setStripOffset(id: number, seconds: number): void {
    this.db.prepare('UPDATE strips SET offset_seconds = ? WHERE id = ?').run(Math.round(seconds), id);
  }

  setStripLocked(id: number, locked: boolean): void {
    this.db.prepare('UPDATE strips SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
  }

  setStripUtcOffsetOverride(id: number, minutes: number | null): void {
    this.db
      .prepare('UPDATE strips SET utc_offset_override_minutes = ? WHERE id = ?')
      .run(minutes === null ? null : Math.round(minutes), id);
  }

  setStripLabel(id: number, label: string): void {
    this.db.prepare('UPDATE strips SET label = ? WHERE id = ?').run(label, id);
  }

  /** Writes a settled lane layout back in one transaction (see `arrangeLanes`). */
  applyLaneLayout(placements: readonly { id: number; lane: number; ordinal: number }[]): void {
    const stmt = this.db.prepare('UPDATE strips SET lane = ?, ordinal = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const p of placements) stmt.run(p.lane, p.ordinal, p.id);
    });
    tx();
  }

  /**
   * Creates a strip and moves the given files into it.
   *
   * `strip_files` has `file_id` as its primary key — every file belongs to exactly
   * one strip (SPEC §8.2) — so the insert replaces whatever membership existed, which
   * is what cutting, merging and manual grouping all need.
   */
  createStrip(
    strip: {
      label: string;
      lane: number;
      ordinal: number;
      groupingSource: GroupingMode;
      parentStripId?: number | null;
      offsetSeconds?: number;
      locked?: boolean;
      utcOffsetOverrideMinutes?: number | null;
    },
    fileIds: readonly number[],
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO strips (lane, ordinal, label, grouping_source, parent_strip_id,
                             offset_seconds, locked,
                             utc_offset_override_minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        strip.lane,
        strip.ordinal,
        strip.label,
        strip.groupingSource,
        strip.parentStripId ?? null,
        Math.round(strip.offsetSeconds ?? 0),
        strip.locked === true ? 1 : 0,
        strip.utcOffsetOverrideMinutes ?? null,
        Date.now(),
      );
    const id = Number(info.lastInsertRowid);
    this.assignFilesToStrip(id, fileIds);
    return id;
  }

  assignFilesToStrip(stripId: number, fileIds: readonly number[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO strip_files (strip_id, file_id) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET strip_id = excluded.strip_id',
    );
    const tx = this.db.transaction(() => {
      for (const fileId of fileIds) stmt.run(stripId, fileId);
    });
    tx();
  }

  /** Removes a strip. Its membership rows go with it; callers reassign first. */
  deleteStrip(id: number): void {
    const tx = this.db.transaction(() => {
      // A segment that pointed at this strip as its origin would otherwise hold a
      // dangling reference, and the foreign key would refuse the delete.
      this.db.prepare('UPDATE strips SET parent_strip_id = NULL WHERE parent_strip_id = ?').run(id);
      this.db.prepare('DELETE FROM strip_files WHERE strip_id = ?').run(id);
      this.db.prepare('DELETE FROM strips WHERE id = ?').run(id);
    });
    tx();
  }

  /** Runs several strip changes as one unit, so a half-applied cut cannot be stored. */
  transact<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- undo (SPEC §4.3, §4.4) --------------------------------------------

  /**
   * A snapshot of everything the alignment view can change.
   *
   * Strip editing is a sequence of small structural changes — cut, merge, promote,
   * regroup — and reversing each one individually would mean a second implementation
   * of every operation, run backwards. The tables are tiny next to the file index, so
   * snapshotting them whole is both simpler and harder to get wrong.
   */
  snapshotStrips(): string {
    return JSON.stringify({
      groupingMode: this.groupingMode,
      strips: this.db.prepare('SELECT * FROM strips ORDER BY id').all(),
      members: this.db.prepare('SELECT strip_id, file_id FROM strip_files ORDER BY file_id').all(),
    });
  }

  restoreStrips(snapshot: string): void {
    const parsed = JSON.parse(snapshot) as {
      groupingMode: GroupingMode;
      strips: Record<string, unknown>[];
      members: { strip_id: number; file_id: number }[];
    };
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM strip_files');
      this.db.exec('DELETE FROM strips');
      const insertStrip = this.db.prepare(
        `INSERT INTO strips (id, lane, ordinal, label, grouping_source, parent_strip_id,
                             offset_seconds, locked,
                             utc_offset_override_minutes, created_at)
         VALUES (@id, @lane, @ordinal, @label, @grouping_source, @parent_strip_id,
                 @offset_seconds, @locked,
                 @utc_offset_override_minutes, @created_at)`,
      );
      const insertMember = this.db.prepare('INSERT INTO strip_files (strip_id, file_id) VALUES (?, ?)');
      // Origin references point at other rows in this same set, so every strip has to
      // exist before any of them is linked up.
      for (const strip of parsed.strips) insertStrip.run({ ...strip, parent_strip_id: null });
      const relink = this.db.prepare('UPDATE strips SET parent_strip_id = ? WHERE id = ?');
      for (const strip of parsed.strips) {
        const parent = strip['parent_strip_id'];
        if (typeof parent === 'number') relink.run(parent, strip['id']);
      }
      for (const m of parsed.members) insertMember.run(m.strip_id, m.file_id);
      this.groupingMode = parsed.groupingMode;
    });
    tx();
  }

  // ---- UTC offset rules (SPEC §4.2) --------------------------------------

  replaceUtcOffsetRules(rules: readonly DraftUtcOffsetRule[]): void {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM utc_offset_rules');
      const stmt = this.db.prepare(
        'INSERT INTO utc_offset_rules (from_utc, to_utc, offset_minutes, source, zone) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of rules) stmt.run(r.fromUtc, r.toUtc, r.offsetMinutes, r.source, r.zone);
    });
    tx();
  }

  listUtcOffsetRules(): UtcOffsetRule[] {
    return this.db
      .prepare<[], {
        id: number; from_utc: number; to_utc: number; offset_minutes: number;
        source: string; zone: string | null;
      }>('SELECT * FROM utc_offset_rules ORDER BY from_utc')
      .all()
      .map((r) => ({
        id: r.id,
        fromUtc: r.from_utc,
        toUtc: r.to_utc,
        offsetMinutes: r.offset_minutes,
        source: r.source as UtcOffsetRule['source'],
        zone: r.zone,
      }));
  }

  /** Per-file UTC offset overrides, from the edit store. */
  fileUtcOffsetOverrides(): Map<number, number> {
    const rows = this.db
      .prepare<[], { file_id: number; utc_offset_override_minutes: number }>(
        'SELECT file_id, utc_offset_override_minutes FROM edits WHERE utc_offset_override_minutes IS NOT NULL',
      )
      .all();
    return new Map(rows.map((r) => [r.file_id, r.utc_offset_override_minutes]));
  }

  setFileUtcOffsetOverride(fileId: number, minutes: number | null): void {
    this.db
      .prepare(
        `INSERT INTO edits (file_id, utc_offset_override_minutes) VALUES (?, ?)
         ON CONFLICT(file_id) DO UPDATE SET utc_offset_override_minutes = excluded.utc_offset_override_minutes`,
      )
      .run(fileId, minutes === null ? null : Math.round(minutes));
  }

  // ---- persist bookkeeping (SPEC §9) -------------------------------------

  recordPersisted(row: {
    fileId: number;
    persistedAt: number;
    wroteGps: boolean;
    wroteTime: boolean;
    originalSnapshotJson: string | null;
    appliedJson: string | null;
    exiftoolResult: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO persisted (file_id, persisted_at, wrote_gps, wrote_time,
                                original_snapshot_json, applied_json, exiftool_result)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           persisted_at = excluded.persisted_at,
           wrote_gps = persisted.wrote_gps | excluded.wrote_gps,
           wrote_time = persisted.wrote_time | excluded.wrote_time,
           -- The first snapshot is the one that predates GeoTagger, so it is what
           -- revert has to restore; a later write must not overwrite it with values
           -- GeoTagger itself put there.
           original_snapshot_json = COALESCE(persisted.original_snapshot_json, excluded.original_snapshot_json),
           applied_json = excluded.applied_json,
           exiftool_result = excluded.exiftool_result`,
      )
      .run(
        row.fileId,
        row.persistedAt,
        row.wroteGps ? 1 : 0,
        row.wroteTime ? 1 : 0,
        row.originalSnapshotJson,
        row.appliedJson,
        row.exiftoolResult,
      );
  }

  getPersisted(fileId: number): PersistedRow | null {
    const row = this.db
      .prepare<[number], RawPersistedRow>(
        'SELECT persisted_at, wrote_gps, wrote_time, original_snapshot_json, applied_json FROM persisted WHERE file_id = ?',
      )
      .get(fileId);
    return row ? toPersistedRow(row) : null;
  }

  /** What GeoTagger last wrote to each file, so the next plan writes only the difference. */
  listPersisted(): Map<number, PersistedRow> {
    const rows = this.db
      .prepare<[], RawPersistedRow & { file_id: number }>('SELECT * FROM persisted')
      .all();
    return new Map(rows.map((r) => [r.file_id, toPersistedRow(r)]));
  }

  /**
   * Records a file's size and mtime after GeoTagger itself wrote to it.
   *
   * Without this the next scan would see the file it just changed as changed by
   * somebody else, re-read the corrected time as if it were the original, and apply
   * the correction a second time.
   */
  updateFileSignature(fileId: number, sizeBytes: number, mtime: number): void {
    this.db
      .prepare('UPDATE files SET size_bytes = ?, mtime = ?, content_sig = ? WHERE id = ?')
      .run(sizeBytes, mtime, contentSig(sizeBytes, mtime), fileId);
  }

  persistedFileIds(): Set<number> {
    return new Set(
      this.db.prepare<[], { file_id: number }>('SELECT file_id FROM persisted').all().map((r) => r.file_id),
    );
  }

  clearPersisted(fileId: number): void {
    this.db.prepare('DELETE FROM persisted WHERE file_id = ?').run(fileId);
  }

  // ---- operation log (SPEC §10.3) ----------------------------------------

  appendOplog(entry: {
    fileId: number | null;
    action: string;
    before?: unknown;
    after?: unknown;
    ok?: boolean;
    error?: string | null;
  }): void {
    this.db
      .prepare('INSERT INTO oplog (ts, file_id, action, before_json, after_json, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        entry.fileId,
        entry.action,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ok === false ? 0 : 1,
        entry.error ?? null,
      );
  }

  listOplog(limit = 500): OplogEntry[] {
    return this.db
      .prepare<[number], {
        id: number; ts: number; file_id: number | null; action: string;
        before_json: string | null; after_json: string | null; ok: number; error: string | null;
      }>('SELECT * FROM oplog ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        fileId: r.file_id,
        action: r.action,
        beforeJson: r.before_json,
        afterJson: r.after_json,
        ok: r.ok !== 0,
        error: r.error,
      }));
  }
}

/** Naive local ISO string to epoch ms, read as if UTC so comparisons stay ordinal. */
function parseNaive(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** A `persisted` row as the writer uses it (SPEC §9.3). */
export interface PersistedRow {
  persistedAt: number;
  wroteGps: boolean;
  wroteTime: boolean;
  /** What the file said before GeoTagger first wrote to it; the basis for revert. */
  originalSnapshotJson: string | null;
  /** What GeoTagger last wrote to it. */
  appliedJson: string | null;
}

interface RawPersistedRow {
  persisted_at: number;
  wrote_gps: number;
  wrote_time: number;
  original_snapshot_json: string | null;
  applied_json: string | null;
}

function toPersistedRow(r: RawPersistedRow): PersistedRow {
  return {
    persistedAt: r.persisted_at,
    wroteGps: r.wrote_gps !== 0,
    wroteTime: r.wrote_time !== 0,
    originalSnapshotJson: r.original_snapshot_json,
    appliedJson: r.applied_json,
  };
}
