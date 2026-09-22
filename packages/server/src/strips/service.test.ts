import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StripRecord } from '@geotagger/shared';
import { naiveToMs, originId } from '@geotagger/shared';
import { FolderStore } from '../db/store.js';
import { StripService } from './service.js';

const at = (iso: string) => naiveToMs(iso) as number;
const ROME = { lat: 41.9028, lon: 12.4964 };

let folder: string;
let store: FolderStore;
let service: StripService;

/** Adds a file to the index with its metadata already resolved, as a scan would. */
function addFile(
  relPath: string,
  localIso: string | null,
  extra: { device?: string; gps?: { lat: number; lon: number }; utcOffsetMinutes?: number | null; source?: 'exif:DateTimeOriginal' | 'filename' } = {},
): number {
  const { id } = store.upsertScanned(
    {
      relPath,
      filename: relPath.split('/').pop() as string,
      ext: 'jpg',
      kind: 'image',
      sizeBytes: 1024,
      mtime: 1,
    },
    1,
  );
  const device = extra.device ?? 'sony';
  store.applyScanResult(
    id,
    {
      deviceId: device,
      width: null,
      height: null,
      durationMs: null,
      orientation: null,
      captureTimeRaw: localIso,
      captureTimeSource: localIso === null ? 'none' : extra.source ?? 'exif:DateTimeOriginal',
      captureUtcOffsetMinutes: extra.utcOffsetMinutes ?? null,
      gpsTimeUtc: null,
      origGpsPresent: extra.gps !== undefined,
      origLat: extra.gps?.lat ?? null,
      origLon: extra.gps?.lon ?? null,
    },
    { id: device, make: null, model: device, serial: null, label: device },
  );
  return id;
}

function stripFor(label: string): StripRecord {
  const found = service.strips().strips.find((s) => s.label === label);
  if (!found) throw new Error(`no strip ${label}`);
  return found;
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-strips-'));
  store = FolderStore.open(folder);
  service = new StripService(store);
});

afterEach(() => {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('UTC offset inheritance (SPEC §4.2)', () => {
  it('gives a local-time-only file the offset of the GPS-bearing file beside it', () => {
    addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', gps: ROME });
    const camera = addFile('sony/DSC_1.JPG', '2024-07-12T10:00:00', { device: 'sony' });
    service.refreshUtcOffsetRules();
    service.regroup('device');

    const line = service.timeline().byId.get(camera);
    expect(line?.utcOffsetMinutes).toBe(120);
    expect(line?.utcOffsetSource).toBe('inherited');
    // 10:00 in Rome is 08:00 UTC — which is where it has to sit to be comparable
    // with a video's UTC reading.
    expect(line?.effectiveMs).toBe(at('2024-07-12T08:00:00'));
  });

  it('asks for the offset when the folder holds nothing that knows one', () => {
    addFile('sony/DSC_1.JPG', '2024-07-12T10:00:00');
    service.refreshUtcOffsetRules();
    service.regroup('device');
    expect(service.timelineResponse().needsUtcOffsetAnswer).toBe(true);

    store.folderUtcOffsetMinutes = 120;
    const answered = service.timelineResponse();
    expect(answered.needsUtcOffsetAnswer).toBe(false);
    expect(answered.files[0]?.utcOffsetSource).toBe('folder');
  });

  it('lets a strip override what would be inherited', () => {
    addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', gps: ROME });
    addFile('sony/DSC_1.JPG', '2024-07-12T10:00:00', { device: 'sony' });
    service.refreshUtcOffsetRules();
    service.regroup('device');

    service.setUtcOffsetOverride(stripFor('sony').id, -300);
    const line = service.timeline().files.find((f) => f.stripId === stripFor('sony').id);
    expect(line?.utcOffsetMinutes).toBe(-300);
    expect(line?.utcOffsetSource).toBe('strip');
  });
});

describe('offsets and locking (SPEC §4.3)', () => {
  beforeEach(() => {
    addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', gps: ROME });
    addFile('phone/IMG_2.JPG', '2024-07-12T12:00:00', { device: 'phone', gps: ROME });
    addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00', { device: 'sony' });
    addFile('sony/DSC_2.JPG', '2024-07-12T11:00:00', { device: 'sony' });
    service.refreshUtcOffsetRules();
    service.regroup('device');
  });

  it('shifts every file in a strip by a constant offset', () => {
    const sony = stripFor('sony');
    service.setOffsets(sony.id, 3600);
    const moved = service.timeline().files.filter((f) => f.stripId === sony.id);
    expect(moved.map((f) => f.offsetSeconds)).toEqual([3600, 3600]);
    expect(moved[0]?.effectiveMs).toBe(at('2024-07-12T07:00:00'));
  });

  it('ramps the offset across a stretched strip', () => {
    const sony = stripFor('sony');
    service.setOffsets(sony.id, 0, 3600);
    const moved = service.timeline().files.filter((f) => f.stripId === sony.id);
    expect(moved.map((f) => f.offsetSeconds)).toEqual([0, 3600]);
  });

  it('refuses every change to a locked strip', () => {
    const sony = stripFor('sony');
    service.setLocked(sony.id, true);
    expect(() => service.setOffsets(sony.id, 60)).toThrow(/locked/i);
    expect(() => service.reset(sony.id)).toThrow(/locked/i);
    expect(() => service.cut(sony.id, at('2024-07-12T09:30:00'))).toThrow(/locked/i);
    expect(() => service.moveToLane(sony.id, 3)).toThrow(/locked/i);
    expect(() => service.setUtcOffsetOverride(sony.id, 60)).toThrow(/locked/i);
    expect(() => service.pinTrueTime(1, '2024-07-12T09:00:00', 0)).not.toThrow();
  });

  it('leaves a locked strip fully readable, so it stays a snap target', () => {
    const sony = stripFor('sony');
    service.setOffsets(sony.id, 1800);
    service.setLocked(sony.id, true);
    const after = stripFor('sony');
    expect(after.locked).toBe(true);
    expect(after.fileCount).toBe(2);
    expect(after.firstEffectiveMs).not.toBeNull();
    expect(service.timeline().files.filter((f) => f.stripId === sony.id)).toHaveLength(2);
  });

  it('resets offset and stretch in one go, and can be undone', () => {
    const sony = stripFor('sony');
    service.setOffsets(sony.id, 600, 900);
    service.reset(sony.id);
    expect(stripFor('sony').offsetStartSeconds).toBe(0);
    expect(stripFor('sony').offsetEndSeconds).toBe(0);
    expect(service.undo()).toBe(true);
    expect(stripFor('sony').offsetStartSeconds).toBe(600);
    expect(stripFor('sony').offsetEndSeconds).toBe(900);
  });
});

describe('cutting, merging and lanes (SPEC §4.3)', () => {
  let sony: StripRecord;

  beforeEach(() => {
    addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', gps: ROME });
    for (let i = 0; i < 6; i += 1) {
      addFile(`sony/DSC_${i}.JPG`, `2024-07-12T${String(8 + i).padStart(2, '0')}:00:00`, { device: 'sony' });
    }
    service.refreshUtcOffsetRules();
    service.regroup('device');
    sony = stripFor('sony');
  });

  it('splits a strip in two without moving any file', () => {
    const before = new Map(service.timeline().files.map((f) => [f.id, f.effectiveMs]));
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    const after = service.timeline();
    for (const f of after.files) expect(f.effectiveMs).toBe(before.get(f.id));
    expect(after.strips.find((s) => s.id === leftId)?.fileCount).toBe(3);
    expect(after.strips.find((s) => s.id === rightId)?.fileCount).toBe(3);
  });

  it('keeps both segments in the same lane until they actually overlap', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    const strips = service.strips().strips;
    const left = strips.find((s) => s.id === leftId) as StripRecord;
    const right = strips.find((s) => s.id === rightId) as StripRecord;
    expect(right.lane).toBe(left.lane);
    expect(right.ordinal).toBe(left.ordinal + 1);
  });

  it('promotes a segment to its own lane once dragging makes it overlap', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    const lane = (id: number): number => service.strips().strips.find((s) => s.id === id)?.lane as number;
    expect(lane(rightId)).toBe(lane(leftId));

    // Drag the right segment back past the left one.
    service.setOffsets(rightId, -4 * 3600);
    expect(lane(rightId)).not.toBe(lane(leftId));
  });

  it('merges two segments back, ramping from the left start to the right end', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    service.setOffsets(leftId, 100, 200);
    service.setOffsets(rightId, 300, 400);
    const mergedId = service.merge(leftId, rightId);
    const merged = service.strips().strips.find((s) => s.id === mergedId) as StripRecord;
    expect(merged.fileCount).toBe(6);
    expect(merged.offsetStartSeconds).toBe(100);
    expect(merged.offsetEndSeconds).toBe(400);
  });

  it('refuses to merge two strips that were never one', () => {
    const { leftId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    expect(() => service.merge(leftId, stripFor('phone').id)).toThrow(/same strip/i);
  });

  it('refuses to merge across a segment that sits between them', () => {
    // The cut points are instants on the shared axis, which for these Rome files is
    // two hours behind the wall clock they were shot at.
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T09:30:00'));
    const second = service.cut(rightId, at('2024-07-12T10:30:00'));
    expect(() => service.merge(leftId, second.rightId)).toThrow(/between/i);
    expect(() => service.merge(leftId, second.leftId)).not.toThrow();
  });

  it('keeps the family link alive across a second cut', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T09:30:00'));
    const second = service.cut(rightId, at('2024-07-12T10:30:00'));
    const strips = service.strips().strips;
    const ids = [leftId, second.leftId, second.rightId];
    const origins = new Set(ids.map((id) => originId(strips.find((s) => s.id === id) as StripRecord)));
    expect(origins.size).toBe(1);
  });

  it('refuses a cut that would leave one side empty', () => {
    expect(() => service.cut(sony.id, at('2024-07-11T00:00:00'))).toThrow(/empty/i);
  });

  it('collapses a lane left empty by a merge', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    service.setOffsets(rightId, -4 * 3600);
    const lanesAfterCut = new Set(service.strips().strips.map((s) => s.lane)).size;
    service.setOffsets(rightId, 0);
    service.merge(leftId, rightId);
    expect(new Set(service.strips().strips.map((s) => s.lane)).size).toBeLessThan(lanesAfterCut);
  });
});

describe('pin true time (SPEC §4.3)', () => {
  it('shifts the whole strip so the pinned file lands on the time given', () => {
    const first = addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00');
    addFile('sony/DSC_2.JPG', '2024-07-12T12:00:00');
    store.folderUtcOffsetMinutes = 0;
    service.regroup('device');

    service.pinTrueTime(first, '2024-07-12T09:15:00', 0);
    const timeline = service.timeline();
    expect(timeline.byId.get(first)?.effectiveMs).toBe(at('2024-07-12T09:15:00'));
    // Everything else in the strip moved with it, including the files after it.
    expect(timeline.files[1]?.effectiveMs).toBe(at('2024-07-12T13:15:00'));
  });

  it('refuses to pin a file in a locked strip', () => {
    const first = addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00');
    service.regroup('device');
    service.setLocked(stripFor('sony').id, true);
    expect(() => service.pinTrueTime(first, '2024-07-12T09:15:00', 0)).toThrow(/locked/i);
  });
});

describe('grouping (SPEC §4.4)', () => {
  beforeEach(() => {
    addFile('a/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone' });
    addFile('b/DSC_1.JPG', '2024-07-12T10:00:00', { device: 'sony' });
    addFile('b/DSC_2.JPG', '2024-07-12T11:00:00', { device: 'sony' });
    store.folderUtcOffsetMinutes = 0;
  });

  it('builds one strip per device by default', () => {
    service.regroup('device');
    expect(service.strips().strips.map((s) => s.label).sort()).toEqual(['phone', 'sony']);
  });

  it('rebuilds from subfolders, discarding offsets', () => {
    service.regroup('device');
    service.setOffsets(stripFor('sony').id, 3600);
    service.regroup('subfolder');
    const strips = service.strips().strips;
    expect(strips.map((s) => s.label).sort()).toEqual(['a', 'b']);
    expect(strips.every((s) => s.offsetStartSeconds === 0)).toBe(true);
  });

  it('makes a strip out of a hand-picked selection', () => {
    service.regroup('device');
    const ids = store.listFiles().map((f) => f.id);
    service.regroup('manual', { fileIds: [ids[0] as number, ids[2] as number], label: 'Borrowed camera' });
    const strips = service.strips().strips;
    expect(strips.find((s) => s.label === 'Borrowed camera')?.fileCount).toBe(2);
    expect(strips.reduce((n, s) => n + s.fileCount, 0)).toBe(3);
  });

  it('puts everything back with reset all, and undo restores the work', () => {
    service.regroup('device');
    const sony = stripFor('sony');
    service.cut(sony.id, at('2024-07-12T10:30:00'));
    service.setOffsets(stripFor('phone').id, 600);
    service.resetAll();
    expect(service.strips().strips).toHaveLength(2);
    expect(service.strips().strips.every((s) => s.offsetStartSeconds === 0)).toBe(true);

    service.undo();
    expect(service.strips().strips).toHaveLength(3);
  });
});
