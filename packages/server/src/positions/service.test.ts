import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolderStore } from '../db/store.js';
import { StripService } from '../strips/service.js';
import { PositionService } from './service.js';

const ROME = { lat: 41.9028, lon: 12.4964 };
const MILAN = { lat: 45.4642, lon: 9.19 };

let folder: string;
let store: FolderStore;
let strips: StripService;
let positions: PositionService;

function addFile(
  relPath: string,
  localIso: string | null,
  extra: { gps?: { lat: number; lon: number } } = {},
): number {
  const { id } = store.upsertScanned(
    { relPath, filename: relPath, ext: 'jpg', kind: 'image', sizeBytes: 1024, mtime: 1 },
    1,
  );
  store.applyScanResult(
    id,
    {
      deviceId: 'sony',
      width: null,
      height: null,
      durationMs: null,
      orientation: null,
      captureTimeRaw: localIso,
      captureTimeSource: localIso === null ? 'none' : 'exif:DateTimeOriginal',
      captureUtcOffsetMinutes: 0,
      gpsTimeUtc: null,
      origGpsPresent: extra.gps !== undefined,
      origLat: extra.gps?.lat ?? null,
      origLon: extra.gps?.lon ?? null,
      origAlt: null,
    },
    { id: 'sony', make: null, model: 'sony', serial: null, label: 'Sony' },
  );
  return id;
}

function settlePosition(fileId: number, lat: number, lon: number, confirmed: boolean): void {
  store.setDraggedPosition(fileId, lat, lon);
  if (confirmed) store.confirmPosition(fileId, lat, lon, null, true);
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-positions-'));
  store = FolderStore.open(folder);
  strips = new StripService(store);
  positions = new PositionService(store, strips);
});

afterEach(() => {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('PositionService.compute', () => {
  it('anchors on camera GPS and interpolates the file between two of them', () => {
    const a = addFile('a.jpg', '2024-07-12T09:00:00', { gps: ROME });
    const mid = addFile('mid.jpg', '2024-07-12T09:30:00');
    const c = addFile('c.jpg', '2024-07-12T10:00:00', { gps: MILAN });
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    const byId = new Map(result.map((p) => [p.fileId, p]));

    expect(byId.get(a)).toMatchObject({ lat: ROME.lat, lon: ROME.lon, source: 'camera-gps', uncertaintyM: null });
    expect(byId.get(c)).toMatchObject({ lat: MILAN.lat, lon: MILAN.lon, source: 'camera-gps', uncertaintyM: null });
    const midPos = byId.get(mid)!;
    expect(midPos.source).toBe('estimate');
    expect(midPos.lat).toBeGreaterThan(Math.min(ROME.lat, MILAN.lat));
    expect(midPos.lat).toBeLessThan(Math.max(ROME.lat, MILAN.lat));
    expect(midPos.uncertaintyM).not.toBeNull();
  });

  it('sends every file to the tray when the folder has no GPS at all', () => {
    addFile('a.jpg', '2024-07-12T09:00:00');
    addFile('b.jpg', '2024-07-12T10:00:00');
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    expect(result.every((p) => p.source === 'none')).toBe(true);
  });

  it('prefers a settled edit-store position over camera GPS, confirmed or not', () => {
    const dragged = addFile('dragged.jpg', '2024-07-12T09:00:00', { gps: ROME });
    settlePosition(dragged, MILAN.lat, MILAN.lon, false);
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    const pos = result.find((p) => p.fileId === dragged)!;
    expect(pos).toMatchObject({ lat: MILAN.lat, lon: MILAN.lon, source: 'manual', uncertaintyM: null });
  });

  it('reports a confirmed edit-store position with source "confirmed"', () => {
    const fileId = addFile('confirmed.jpg', '2024-07-12T09:00:00');
    settlePosition(fileId, ROME.lat, ROME.lon, true);
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    expect(result.find((p) => p.fileId === fileId)).toMatchObject({ source: 'confirmed', uncertaintyM: null });
  });

  it('does not let a dragged, unconfirmed file anchor its neighbours (SPEC §5.5)', () => {
    addFile('a.jpg', '2024-07-12T09:00:00', { gps: ROME });
    const mid = addFile('mid.jpg', '2024-07-12T09:30:00');
    const dragged = addFile('dragged.jpg', '2024-07-12T10:00:00');
    settlePosition(dragged, MILAN.lat, MILAN.lon, false);
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    const byId = new Map(result.map((p) => [p.fileId, p]));

    // Only the camera GPS file is a real anchor, so mid — bracketed only by the
    // dragged file until it is confirmed — has nothing to interpolate between.
    expect(byId.get(mid)).toMatchObject({ source: 'none' });
    expect(byId.get(dragged)).toMatchObject({ lat: MILAN.lat, lon: MILAN.lon, source: 'manual' });
  });

  it('lets that same file anchor its neighbours once confirmed', () => {
    addFile('a.jpg', '2024-07-12T09:00:00', { gps: ROME });
    const mid = addFile('mid.jpg', '2024-07-12T09:30:00');
    const c = addFile('c.jpg', '2024-07-12T10:00:00');
    settlePosition(c, MILAN.lat, MILAN.lon, true);
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    const result = positions.compute(store.listFiles());
    const midPos = result.find((p) => p.fileId === mid)!;
    expect(midPos.source).toBe('estimate');
    expect(midPos.lat).toBeGreaterThan(Math.min(ROME.lat, MILAN.lat));
    expect(midPos.lat).toBeLessThan(Math.max(ROME.lat, MILAN.lat));
  });

  it('keeps neighbours anchored on the old position while an already-confirmed file is re-dragged (SPEC §5.6)', () => {
    const TOKYO = { lat: 35.6762, lon: 139.6503 };
    addFile('a.jpg', '2024-07-12T09:00:00', { gps: ROME });
    const mid = addFile('mid.jpg', '2024-07-12T09:30:00');
    const c = addFile('c.jpg', '2024-07-12T10:00:00');
    store.confirmPosition(c, MILAN.lat, MILAN.lon, null, false);
    strips.refreshUtcOffsetRules();
    strips.regroup('device');

    store.setDraggedPosition(c, TOKYO.lat, TOKYO.lon);

    const result = positions.compute(store.listFiles());
    const byId = new Map(result.map((p) => [p.fileId, p]));

    // The re-dragged file shows the new spot but ghosts the old, still-anchoring one.
    expect(byId.get(c)).toMatchObject({
      lat: TOKYO.lat,
      lon: TOKYO.lon,
      source: 'manual',
      anchorLat: MILAN.lat,
      anchorLon: MILAN.lon,
    });
    // mid is still interpolated between Rome and Milan — Tokyo has not moved it.
    const midPos = byId.get(mid)!;
    expect(midPos.source).toBe('estimate');
    expect(midPos.lat).toBeGreaterThan(Math.min(ROME.lat, MILAN.lat));
    expect(midPos.lat).toBeLessThan(Math.max(ROME.lat, MILAN.lat));
  });
});
