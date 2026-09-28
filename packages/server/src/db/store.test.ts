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
