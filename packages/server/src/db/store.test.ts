import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FolderStore, contentSig, signatureOf, type ScannedFile } from './store.js';

let folder: string;
let store: FolderStore;

function scanned(overrides: Partial<ScannedFile> & { relPath: string }): ScannedFile {
  return {
    filename: overrides.relPath.split('/').pop() as string,
    ext: 'jpg',
    kind: 'image',
    sizeBytes: 1024,
    mtime: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-store-'));
  store = FolderStore.open(folder);
});

afterEach(() => {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('signatureOf — SPEC §8.3 change detection', () => {
  it('reduces a sub-millisecond mtime the same way every caller does', () => {
    // A scan that floors and a write that rounds disagree about every file whose
    // mtime has a fraction, and each one then looks as though somebody else had
    // changed it underneath the app.
    const stat = { size: 525, mtimeMs: 1_790_092_978_112.589 };
    expect(signatureOf(stat).mtime).toBe(1_790_092_978_112);
    expect(signatureOf(stat).sig).toBe(contentSig(525, 1_790_092_978_112));
    expect(signatureOf({ size: 525, mtimeMs: 1_790_092_978_112.999 }).sig).toBe(signatureOf(stat).sig);
  });
});

describe('FolderStore — SPEC §8.1 location', () => {
  it('creates .geotagger/ beside the photos so state travels with them', () => {
    expect(fs.existsSync(path.join(folder, '.geotagger', 'edits.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(folder, '.geotagger', 'thumbs'))).toBe(true);
  });

  it('reports a folder as known only once it has been opened', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-fresh-'));
    try {
      expect(FolderStore.isKnown(fresh)).toBe(false);
      FolderStore.open(fresh).close();
      expect(FolderStore.isKnown(fresh)).toBe(true);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('keeps its folder id across reopens, so the same folder is recognised', () => {
    const id = store.folderId;
    store.close();
    store = FolderStore.open(folder);
    expect(store.folderId).toBe(id);
    expect(id).not.toBe('');
  });
});

describe('change detection — SPEC §8.3', () => {
  it('reports a first sighting as added', () => {
    expect(store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).change).toBe('added');
  });

  it('reports an identical size and mtime as unchanged', () => {
    const f = scanned({ relPath: 'a.jpg' });
    store.upsertScanned(f, 1);
    expect(store.upsertScanned(f, 2).change).toBe('unchanged');
  });

  it('reports a changed size or a changed mtime as changed', () => {
    const f = scanned({ relPath: 'a.jpg' });
    store.upsertScanned(f, 1);
    expect(store.upsertScanned({ ...f, sizeBytes: 2048 }, 2).change).toBe('changed');
    expect(store.upsertScanned({ ...f, sizeBytes: 2048, mtime: 9 }, 3).change).toBe('changed');
  });

  it('keeps the same id across rescans', () => {
    const f = scanned({ relPath: 'a.jpg' });
    const first = store.upsertScanned(f, 1).id;
    expect(store.upsertScanned({ ...f, sizeBytes: 2048 }, 2).id).toBe(first);
  });

  it('requeues a thumbnail when the file changed, but not when it did not', () => {
    const f = scanned({ relPath: 'a.jpg' });
    const { id } = store.upsertScanned(f, 1);
    store.setThumbState(id, 'ready');

    store.upsertScanned(f, 2);
    expect(store.getFile(id)?.thumbState).toBe('ready');

    store.upsertScanned({ ...f, sizeBytes: 2048 }, 3);
    expect(store.getFile(id)?.thumbState).toBe('pending');
  });

  it('marks files not seen by a scan as missing, and unmarks them when they return', () => {
    const a = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    const b = store.upsertScanned(scanned({ relPath: 'b.jpg' }), 1).id;

    expect(store.markMissingExcept([a])).toBe(1);
    expect(store.getFile(b)?.missing).toBe(true);
    expect(store.fileCount()).toBe(1);

    store.upsertScanned(scanned({ relPath: 'b.jpg' }), 2);
    expect(store.getFile(b)?.missing).toBe(false);
    expect(store.fileCount()).toBe(2);
  });

  it('does not re-mark files that are already missing', () => {
    const a = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.upsertScanned(scanned({ relPath: 'b.jpg' }), 1);
    store.markMissingExcept([a]);
    expect(store.markMissingExcept([a])).toBe(0);
  });
});

describe('metadata and strips', () => {
  it('stores resolved metadata on the file row', () => {
    const { id } = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1);
    store.applyScanResult(
      id,
      {
        deviceId: 'apple|iphone|',
        width: 4032,
        height: 3024,
        durationMs: null,
        orientation: 6,
        captureTimeRaw: '2024-07-12T14:32:10',
        captureTimeSource: 'exif:DateTimeOriginal',
        captureUtcOffsetMinutes: 120,
        gpsTimeUtc: '2024-07-12T12:32:08',
        origGpsPresent: true,
        origLat: 41.9028,
        origLon: 12.4964,
        origAlt: 21.3,
      },
      { id: 'apple|iphone|', make: 'Apple', model: 'iPhone', serial: null, label: 'Apple iPhone' },
    );
    expect(store.listDevices()).toHaveLength(1);
    expect(store.getFile(id)).toMatchObject({
      orientation: 6,
      captureTimeRaw: '2024-07-12T14:32:10',
      captureTimeSource: 'exif:DateTimeOriginal',
      captureUtcOffsetMinutes: 120,
      origGpsPresent: true,
      origLat: 41.9028,
      origAlt: 21.3,
    });
  });

  it("keeps a persisted file's original fields frozen when a later scan reads it again (SPEC §9.3)", () => {
    const { id } = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1);
    const cameraRead = {
      deviceId: null,
      width: 4032,
      height: 3024,
      durationMs: null,
      orientation: 6,
      captureTimeRaw: '2024-07-12T14:32:10',
      captureTimeSource: 'exif:DateTimeOriginal' as const,
      captureUtcOffsetMinutes: 120,
      gpsTimeUtc: null,
      origGpsPresent: false,
      origLat: null,
      origLon: null,
      origAlt: null,
    };
    store.applyScanResult(id, cameraRead, null);
    store.recordPersisted({
      fileId: id,
      persistedAt: 1,
      originalSnapshotJson: null,
      writtenTagsJson: null,
      exiftoolResult: null,
    });

    // A rescan after the write reads GeoTagger's own corrected values back from the
    // file — size/mtime alone cannot prove otherwise (SPEC §10.1), so every file's
    // metadata is re-read, but a persisted file must not let that overwrite what the
    // rest of the app still treats as the pre-GeoTagger original.
    store.applyScanResult(
      id,
      { ...cameraRead, width: 4000, captureTimeRaw: '2024-07-12T15:32:10', origGpsPresent: true, origLat: 47.5, origLon: 11.5 },
      null,
    );

    const file = store.getFile(id);
    expect(file?.width).toBe(4000);
    expect(file?.captureTimeRaw).toBe('2024-07-12T14:32:10');
    expect(file?.origGpsPresent).toBe(false);
    expect(file?.origLat).toBeNull();
  });

  it('assigns every file to exactly one strip and replaces the set on regroup', () => {
    const a = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    const b = store.upsertScanned(scanned({ relPath: 'b.jpg' }), 1).id;

    store.replaceStrips('device', [{ label: 'Camera A', lane: 0, ordinal: 0, fileIds: [a, b] }]);
    expect(store.listStrips()).toHaveLength(1);
    expect(store.listStrips()[0]?.fileCount).toBe(2);
    expect(store.unassignedFileIds()).toEqual([]);

    store.replaceStrips('subfolder', [
      { label: 'One', lane: 0, ordinal: 0, fileIds: [a] },
      { label: 'Two', lane: 1, ordinal: 0, fileIds: [b] },
    ]);
    expect(store.listStrips()).toHaveLength(2);
    expect(store.groupingMode).toBe('subfolder');
    expect(Object.keys(store.stripAssignments())).toHaveLength(2);
  });

  it('reports files scanned after the last grouping run as unassigned', () => {
    const a = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.replaceStrips('device', [{ label: 'Camera A', lane: 0, ordinal: 0, fileIds: [a] }]);
    const b = store.upsertScanned(scanned({ relPath: 'b.jpg' }), 2).id;
    expect(store.unassignedFileIds()).toEqual([b]);
  });

  it('starts strips with zero offset and unlocked, ready for phase 1', () => {
    const a = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.replaceStrips('device', [{ label: 'Camera A', lane: 0, ordinal: 0, fileIds: [a] }]);
    expect(store.listStrips()[0]).toMatchObject({ offsetSeconds: 0, locked: false });
  });

  it('starts unanswered so a fresh folder is asked how to group before anything is built (SPEC §4.4)', () => {
    expect(store.groupingModeAnswered).toBe(false);
    store.groupingModeAnswered = true;
    expect(store.groupingModeAnswered).toBe(true);
  });
});

describe('positions — SPEC §5.5, §5.6, §6.5', () => {
  const ROME = { lat: 41.9028, lon: 12.4964 };
  const MILAN = { lat: 45.4642, lon: 9.19 };

  it('drag settles a pending position, not a confirmed one', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.setDraggedPosition(id, ROME.lat, ROME.lon);
    expect(store.listPendingPositions().get(id)).toEqual({ lat: ROME.lat, lon: ROME.lon });
    expect(store.listConfirmedPositions().has(id)).toBe(false);
  });

  it('confirm freezes the given coordinates and uncertainty, and clears any pending drag', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.setDraggedPosition(id, MILAN.lat, MILAN.lon);
    store.confirmPosition(id, ROME.lat, ROME.lon, 180, false);
    expect(store.listConfirmedPositions().get(id)).toEqual({ lat: ROME.lat, lon: ROME.lon });
    expect(store.listPendingPositions().has(id)).toBe(false);
  });

  it('re-dragging an already-confirmed file keeps the old confirmed position untouched (SPEC §5.5)', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.confirmPosition(id, ROME.lat, ROME.lon, 42, false);

    store.setDraggedPosition(id, MILAN.lat, MILAN.lon);

    // The confirmed anchor is exactly where it was — still able to place everyone
    // else — while the pending drag holds the new, not-yet-committed spot.
    expect(store.listConfirmedPositions().get(id)).toEqual({ lat: ROME.lat, lon: ROME.lon });
    expect(store.listPendingPositions().get(id)).toEqual({ lat: MILAN.lat, lon: MILAN.lon });
  });

  it('revert cancels only a pending drag, leaving a confirmed anchor underneath alone', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.confirmPosition(id, ROME.lat, ROME.lon, 42, false);
    store.setDraggedPosition(id, MILAN.lat, MILAN.lon);

    store.revertPendingPosition(id);

    expect(store.listPendingPositions().has(id)).toBe(false);
    expect(store.listConfirmedPositions().get(id)).toEqual({ lat: ROME.lat, lon: ROME.lon });
  });

  it('revert on a file with nothing pending is a no-op', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.confirmPosition(id, ROME.lat, ROME.lon, 42, false);
    expect(() => store.revertPendingPosition(id)).not.toThrow();
    expect(store.listConfirmedPositions().get(id)).toEqual({ lat: ROME.lat, lon: ROME.lon });
  });

  it('reset discards a pending drag and a confirmed position alike, without touching the UTC offset override', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    store.setFileUtcOffsetOverride(id, 120);
    store.confirmPosition(id, ROME.lat, ROME.lon, 180, false);
    store.setDraggedPosition(id, MILAN.lat, MILAN.lon);

    store.resetPosition(id);

    expect(store.listConfirmedPositions().has(id)).toBe(false);
    expect(store.listPendingPositions().has(id)).toBe(false);
    expect(store.fileUtcOffsetOverrides().get(id)).toBe(120);
  });

  it('reset on a file that was never placed is a no-op', () => {
    const id = store.upsertScanned(scanned({ relPath: 'a.jpg' }), 1).id;
    expect(() => store.resetPosition(id)).not.toThrow();
    expect(store.listConfirmedPositions().has(id)).toBe(false);
  });
});

describe('schema 2 → 3 — the offset ramp collapses to one offset', () => {
  /** A `.geotagger/edits.sqlite` as a GeoTagger with the stretch gesture left it. */
  function writeSchema2Store(dir: string): void {
    fs.mkdirSync(path.join(dir, '.geotagger'), { recursive: true });
    const db = new Database(path.join(dir, '.geotagger', 'edits.sqlite'));
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '2'), ('grouping_mode', 'device');
      CREATE TABLE strips (
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
      INSERT INTO strips (id, label, grouping_source, offset_start_seconds, offset_end_seconds, created_at)
      VALUES (1, 'sony', 'device', 3720, 4264, 1), (2, 'phone', 'device', 0, 0, 1);
    `);
    db.close();
  }

  it('keeps the correction a stretched strip had at its first file', () => {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-schema2-'));
    writeSchema2Store(old);
    const migrated = FolderStore.open(old);
    try {
      expect(migrated.listStrips().map((s) => [s.label, s.offsetSeconds])).toEqual([
        ['sony', 3720],
        ['phone', 0],
      ]);
      // Undo snapshots a strip row with SELECT * and replays it through a named-parameter
      // insert, so a leftover ramp column would break every undo on a migrated folder.
      const snapshot = migrated.snapshotStrips();
      expect(() => migrated.restoreStrips(snapshot)).not.toThrow();
      expect(migrated.listStrips()).toHaveLength(2);
    } finally {
      migrated.close();
      fs.rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('schema 6 → 7 — file ids move from INTEGER to UUIDv7 TEXT', () => {
  /** A `.geotagger/edits.sqlite` as a pre-UUID GeoTagger left it, with integer file ids. */
  function writeSchema6Store(dir: string): void {
    fs.mkdirSync(path.join(dir, '.geotagger'), { recursive: true });
    const db = new Database(path.join(dir, '.geotagger', 'edits.sqlite'));
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '6'), ('grouping_mode', 'device');

      CREATE TABLE devices (
        id       TEXT PRIMARY KEY,
        make     TEXT,
        model    TEXT,
        serial   TEXT,
        label    TEXT NOT NULL,
        group_id INTEGER
      );

      CREATE TABLE files (
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
        orig_alt                   REAL,
        first_seen_at              INTEGER NOT NULL,
        last_scanned_at            INTEGER NOT NULL,
        missing                    INTEGER NOT NULL DEFAULT 0,
        thumb_state                TEXT NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE strips (
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

      CREATE TABLE strip_files (
        strip_id INTEGER NOT NULL REFERENCES strips(id) ON DELETE CASCADE,
        file_id  INTEGER NOT NULL REFERENCES files(id)  ON DELETE CASCADE,
        PRIMARY KEY (file_id)
      );

      CREATE TABLE edits (
        file_id                    INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
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

      CREATE TABLE persisted (
        file_id                INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        persisted_at           INTEGER NOT NULL,
        original_snapshot_json TEXT,
        written_tags_json      TEXT,
        exiftool_result        TEXT
      );

      CREATE TABLE oplog (
        id          INTEGER PRIMARY KEY,
        ts          INTEGER NOT NULL,
        file_id     INTEGER,
        action      TEXT NOT NULL,
        before_json TEXT,
        after_json  TEXT,
        ok          INTEGER NOT NULL DEFAULT 1,
        error       TEXT
      );

      INSERT INTO files (id, rel_path, filename, ext, kind, size_bytes, mtime, content_sig,
                          first_seen_at, last_scanned_at, missing, thumb_state)
      VALUES
        (1, 'a.jpg', 'a.jpg', 'jpg', 'image', 100, 1, '100:1', 1, 1, 0, 'ready'),
        (2, 'b.jpg', 'b.jpg', 'jpg', 'image', 200, 2, '200:2', 2, 2, 0, 'ready'),
        (3, 'c.jpg', 'c.jpg', 'jpg', 'image', 300, 3, '300:3', 3, 3, 0, 'ready');

      INSERT INTO strips (id, lane, ordinal, label, grouping_source, created_at)
      VALUES (1, 0, 0, 'device', 'device', 1);

      INSERT INTO strip_files (strip_id, file_id) VALUES (1, 1), (1, 2);

      -- A confirmed (known) position on file 1, a pending drag on file 2.
      INSERT INTO edits (file_id, lat, lon, position_source, uncertainty_m, confirmed_at)
      VALUES (1, 41.9, 12.5, 'drag', NULL, 5);
      INSERT INTO edits (file_id, pending_lat, pending_lon, placed_at)
      VALUES (2, 45.5, 9.2, 6);

      INSERT INTO persisted (file_id, persisted_at, original_snapshot_json, written_tags_json, exiftool_result)
      VALUES (1, 7, '{"tags":{}}', '{"EXIF:GPSLatitude":"41.9"}', '{"updated":1,"warnings":[]}');

      -- One oplog entry tied to a file, one with no file (file_id NULL).
      INSERT INTO oplog (ts, file_id, action, before_json, after_json, ok)
      VALUES (8, 1, 'persist', '{"tags":{}}', '{"tags":{}}', 1);
      INSERT INTO oplog (ts, file_id, action, ok, error)
      VALUES (9, NULL, 'scan', 0, 'boom');
    `);
    db.close();
  }

  function open(): { store: FolderStore; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-schema6-'));
    writeSchema6Store(dir);
    return { store: FolderStore.open(dir), dir };
  }

  it('carries every relation across to the new UUID ids', () => {
    const { store: migrated, dir } = open();
    try {
      const files = migrated.listFiles();
      expect(files.map((f) => f.relPath)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);

      // New ids are UUID-shaped strings, and unique.
      for (const f of files) {
        expect(f.id).toMatch(/^[0-9a-f-]{36}$/i);
      }
      expect(new Set(files.map((f) => f.id)).size).toBe(files.length);

      const a = files.find((f) => f.relPath === 'a.jpg') as (typeof files)[number];
      const b = files.find((f) => f.relPath === 'b.jpg') as (typeof files)[number];
      const c = files.find((f) => f.relPath === 'c.jpg') as (typeof files)[number];

      // The strip membership (a, b) survived, keyed by the new ids.
      const assignments = migrated.stripAssignments();
      expect(assignments[a.id]).toBeDefined();
      expect(assignments[b.id]).toBeDefined();
      expect(assignments[c.id]).toBeUndefined();
      expect(migrated.stripMemberIds(assignments[a.id] as number).sort()).toEqual([a.id, b.id].sort());

      // The confirmed position on a, and the pending drag on b.
      expect(migrated.listConfirmedPositions().get(a.id)).toEqual({ lat: 41.9, lon: 12.5 });
      expect(migrated.listPendingPositions().get(b.id)).toEqual({ lat: 45.5, lon: 9.2 });

      // The persisted row on a.
      const persisted = migrated.getPersisted(a.id);
      expect(persisted?.writtenTagsJson).toBe('{"EXIF:GPSLatitude":"41.9"}');

      // The oplog: one entry mapped through to a's new id, one left null.
      const oplog = migrated.listOplog();
      const withFile = oplog.find((e) => e.action === 'persist');
      const withoutFile = oplog.find((e) => e.action === 'scan');
      expect(withFile?.fileId).toBe(a.id);
      expect(withoutFile?.fileId).toBeNull();

      // Foreign keys are consistent after the rebuild.
      expect(migrated.db.pragma('foreign_key_check')).toEqual([]);
      expect(migrated.getMeta('schema_version')).toBe('7');
      // Old thumbnails are keyed by the retired integer ids and can never be found
      // again, so every file is back to pending and will regenerate on next access.
      expect(files.every((f) => f.thumbState === 'pending')).toBe(true);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op the second time the same folder is opened', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-schema6-reopen-'));
    writeSchema6Store(dir);
    const first = FolderStore.open(dir);
    const idsBefore = first.listFiles().map((f) => f.id).sort();
    first.close();

    const second = FolderStore.open(dir);
    try {
      const idsAfter = second.listFiles().map((f) => f.id).sort();
      expect(idsAfter).toEqual(idsBefore);
      expect(second.getMeta('schema_version')).toBe('7');
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
