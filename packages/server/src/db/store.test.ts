import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(store.listStrips()[0]).toMatchObject({
      offsetStartSeconds: 0,
      offsetEndSeconds: 0,
      locked: false,
    });
  });
});
