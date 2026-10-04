import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileId, StripRecord } from '@geotagger/shared';
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
): FileId {
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
      origAlt: null,
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
  let phoneFile: FileId;

  beforeEach(() => {
    phoneFile = addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', gps: ROME });
    addFile('phone/IMG_2.JPG', '2024-07-12T12:00:00', { device: 'phone', gps: ROME });
    addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00', { device: 'sony' });
    addFile('sony/DSC_2.JPG', '2024-07-12T11:00:00', { device: 'sony' });
    service.refreshUtcOffsetRules();
    service.regroup('device');
  });

  it('shifts every file in a strip by a constant offset', () => {
    const sony = stripFor('sony');
    service.setOffset(sony.id, 3600);
    const moved = service.timeline().files.filter((f) => f.stripId === sony.id);
    expect(moved.map((f) => f.offsetSeconds)).toEqual([3600, 3600]);
    expect(moved[0]?.effectiveMs).toBe(at('2024-07-12T07:00:00'));
  });

  it('refuses every change to a locked strip', () => {
    const sony = stripFor('sony');
    service.setLocked(sony.id, true);
    expect(() => service.setOffset(sony.id, 60)).toThrow(/locked/i);
    expect(() => service.reset(sony.id)).toThrow(/locked/i);
    expect(() => service.cut(sony.id, at('2024-07-12T09:30:00'))).toThrow(/locked/i);
    expect(() => service.moveToLane(sony.id, 3)).toThrow(/locked/i);
    expect(() => service.setUtcOffsetOverride(sony.id, 60)).toThrow(/locked/i);
    expect(() => service.setTrueTime(phoneFile, '2024-07-12T09:00:00')).not.toThrow();
  });

  it('leaves a locked strip fully readable, so it stays a snap target', () => {
    const sony = stripFor('sony');
    service.setOffset(sony.id, 1800);
    service.setLocked(sony.id, true);
    const after = stripFor('sony');
    expect(after.locked).toBe(true);
    expect(after.fileCount).toBe(2);
    expect(after.firstEffectiveMs).not.toBeNull();
    expect(service.timeline().files.filter((f) => f.stripId === sony.id)).toHaveLength(2);
  });

  it('resets the offset, and can be undone', () => {
    const sony = stripFor('sony');
    service.setOffset(sony.id, 600);
    service.reset(sony.id);
    expect(stripFor('sony').offsetSeconds).toBe(0);
    expect(service.undo()).toBe(true);
    expect(stripFor('sony').offsetSeconds).toBe(600);
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
    service.setOffset(rightId, -4 * 3600);
    expect(lane(rightId)).not.toBe(lane(leftId));
  });

  it('merges two segments back under the left segment’s offset', () => {
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T08:30:00'));
    service.setOffset(leftId, 100);
    service.setOffset(rightId, 300);
    const mergedId = service.merge(leftId, rightId);
    const merged = service.strips().strips.find((s) => s.id === mergedId) as StripRecord;
    expect(merged.fileCount).toBe(6);
    expect(merged.offsetSeconds).toBe(100);
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
    service.setOffset(rightId, -4 * 3600);
    const lanesAfterCut = new Set(service.strips().strips.map((s) => s.lane)).size;
    service.setOffset(rightId, 0);
    service.merge(leftId, rightId);
    expect(new Set(service.strips().strips.map((s) => s.lane)).size).toBeLessThan(lanesAfterCut);
  });
});

describe('set true time (SPEC §4.3)', () => {
  it('shifts the whole strip so the file lands on the time given', () => {
    const first = addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00');
    addFile('sony/DSC_2.JPG', '2024-07-12T12:00:00');
    store.folderUtcOffsetMinutes = 0;
    service.regroup('device');

    service.setTrueTime(first, '2024-07-12T09:15:00');
    const timeline = service.timeline();
    expect(timeline.byId.get(first)?.effectiveMs).toBe(at('2024-07-12T09:15:00'));
    // Everything else in the strip moved with it, including the files after it.
    expect(timeline.files[1]?.effectiveMs).toBe(at('2024-07-12T13:15:00'));
  });

  it("reads the time given in the file's own offset, not the trip's dominant one", () => {
    addFile('phone/IMG_1.JPG', '2024-07-12T09:00:00', { device: 'phone', utcOffsetMinutes: -360 });
    addFile('phone/IMG_2.JPG', '2024-07-12T10:00:00', { device: 'phone', utcOffsetMinutes: -360 });
    const late = addFile('sony/DSC_1.JPG', '2024-07-12T15:00:00', { device: 'sony', utcOffsetMinutes: -420 });
    service.regroup('device');
    expect(service.timeline().displayUtcOffsetMinutes).toBe(-360);

    service.setTrueTime(late, '2024-07-12T16:00:00');
    expect(service.timeline().byId.get(late)?.effectiveMs).toBe(at('2024-07-12T23:00:00'));
  });

  it('refuses to move a file in a locked strip', () => {
    const first = addFile('sony/DSC_1.JPG', '2024-07-12T08:00:00');
    service.regroup('device');
    service.setLocked(stripFor('sony').id, true);
    expect(() => service.setTrueTime(first, '2024-07-12T09:15:00')).toThrow(/locked/i);
  });
});

describe('pinning and stretching (SPEC §4.3)', () => {
  // Five photos two hours apart on a camera that gained a minute over the eight hours;
  // a phone beside it knows the right time.
  let sonyFiles: FileId[];
  let sony: StripRecord;
  const effective = (id: FileId): number => service.timeline().byId.get(id)?.effectiveMs as number;

  beforeEach(() => {
    store.folderUtcOffsetMinutes = 0;
    addFile('phone/IMG_1.JPG', '2024-07-12T08:00:00', { device: 'phone' });
    sonyFiles = [8, 10, 12, 14, 16].map((h) => addFile(`sony/DSC_${h}.JPG`, `2024-07-12T${String(h).padStart(2, '0')}:00:00`));
    service.regroup('device');
    sony = stripFor('sony');
  });

  it('never moves anything by pinning or unpinning', () => {
    service.setOffset(sony.id, 120);
    const before = sonyFiles.map(effective);
    service.setPinned(sonyFiles[1] as FileId, true);
    expect(sonyFiles.map(effective)).toEqual(before);
    expect(stripFor('sony').pinnedFileIds).toEqual([sonyFiles[1]]);
    service.setPinned(sonyFiles[1] as FileId, false);
    expect(sonyFiles.map(effective)).toEqual(before);
    expect(stripFor('sony').pinnedFileIds).toEqual([]);
  });

  it('holds the pin exactly, lands the stretched file exactly, and scales and extrapolates the rest', () => {
    const [f8, f10, f12, f14, f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    service.setOffset(sony.id, 30);
    service.setPinned(f10, true);
    const pinBefore = effective(f10);

    // 16:00 on the camera was really 16:01:30 (+30 s offset already, +60 s more).
    service.stretch(sony.id, f16, at('2024-07-12T16:01:30'));

    expect(effective(f10)).toBe(pinBefore);
    expect(effective(f16)).toBe(at('2024-07-12T16:01:30'));
    // A minute over six hours from the pin: 10 s per hour, either side of it.
    expect(effective(f12)).toBeCloseTo(at('2024-07-12T12:00:50'), -1);
    expect(effective(f14)).toBeCloseTo(at('2024-07-12T14:01:10'), -1);
    expect(effective(f8)).toBeCloseTo(at('2024-07-12T08:00:10'), -1);
    expect(stripFor('sony').drift).toBeCloseTo(60 / (6 * 3600), 10);
  });

  it('carries the per-file shift into the timeline line the write plan reads', () => {
    const [, f10, , , f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    service.setPinned(f10, true);
    service.stretch(sony.id, f16, at('2024-07-12T16:01:00'));
    const line = (id: FileId) => service.timeline().byId.get(id);
    expect(line(f10)?.offsetSeconds).toBe(0);
    expect(line(f16)?.offsetSeconds).toBeCloseTo(60, 6);
  });

  it('refuses shifts on a pinned strip, and stretches once there are two pins', () => {
    const [f8, f10, , , f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    expect(() => service.stretch(sony.id, f16, at('2024-07-12T16:01:00'))).toThrow(/no pinned photo/i);

    service.setPinned(f10, true);
    expect(() => service.setOffset(sony.id, 60)).toThrow(/pinned/i);
    expect(() => service.reset(sony.id)).toThrow(/pinned/i);
    expect(() => service.stretch(sony.id, f10, at('2024-07-12T10:05:00'))).toThrow(/pinned/i);

    service.setPinned(f8, true);
    expect(() => service.stretch(sony.id, f16, at('2024-07-12T16:01:00'))).toThrow(/two pinned/i);
  });

  it('refuses a stretch no clock could need', () => {
    const [, f10, f12] = sonyFiles as [FileId, FileId, FileId];
    service.setPinned(f10, true);
    expect(() => service.stretch(sony.id, f12, at('2024-07-12T13:00:00'))).toThrow(/h\/day.*cutting the strip/);
  });

  it('stretches about the pin when a true time is set on a pinned strip', () => {
    const [, f10, , , f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    service.setPinned(f10, true);
    const pinBefore = effective(f10);
    service.setTrueTime(f16, '2024-07-12T15:59:00');
    expect(effective(f10)).toBe(pinBefore);
    expect(effective(f16)).toBe(at('2024-07-12T15:59:00'));
    // Setting a true time does not pin the file.
    expect(stripFor('sony').pinnedFileIds).toEqual([f10]);
  });

  it('cuts a stretched strip without anything jumping, pins going with their files', () => {
    const [, f10, , , f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    service.setPinned(f10, true);
    service.stretch(sony.id, f16, at('2024-07-12T16:01:00'));
    const before = sonyFiles.map(effective);

    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T13:00:00'));
    expect(sonyFiles.map(effective)).toEqual(before);
    const strips = service.strips().strips;
    expect(strips.find((s) => s.id === leftId)?.pinnedFileIds).toEqual([f10]);
    expect(strips.find((s) => s.id === rightId)?.pinnedFileIds).toEqual([]);

    // Untouched since the cut, the two corrections still agree: merging moves nothing.
    service.merge(leftId, rightId);
    expect(sonyFiles.map(effective)).toEqual(before);
  });

  it('refuses a merge that would move a pinned photo of the later segment', () => {
    const [, , , f14] = sonyFiles as [FileId, FileId, FileId, FileId];
    const { leftId, rightId } = service.cut(sony.id, at('2024-07-12T13:00:00'));
    service.setOffset(rightId, 90);
    service.setPinned(f14, true);
    expect(() => service.merge(leftId, rightId)).toThrow(/pinned/i);
  });

  it('undoes a pin and a stretch', () => {
    const [, f10, , , f16] = sonyFiles as [FileId, FileId, FileId, FileId, FileId];
    const before = sonyFiles.map(effective);
    service.setPinned(f10, true);
    service.stretch(sony.id, f16, at('2024-07-12T16:01:00'));
    service.undo();
    expect(sonyFiles.map(effective)).toEqual(before);
    expect(stripFor('sony').pinnedFileIds).toEqual([f10]);
    service.undo();
    expect(stripFor('sony').pinnedFileIds).toEqual([]);
  });

  it('drops pins on files moved into a hand-made strip', () => {
    const [, f10] = sonyFiles as [FileId, FileId];
    service.setPinned(f10, true);
    service.regroup('manual', { fileIds: [f10], label: 'Picked' });
    expect(stripFor('Picked').pinnedFileIds).toEqual([]);
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
    service.setOffset(stripFor('sony').id, 3600);
    service.regroup('subfolder');
    const strips = service.strips().strips;
    expect(strips.map((s) => s.label).sort()).toEqual(['a', 'b']);
    expect(strips.every((s) => s.offsetSeconds === 0)).toBe(true);
  });

  it('makes a strip out of a hand-picked selection', () => {
    service.regroup('device');
    const ids = store.listFiles().map((f) => f.id);
    service.regroup('manual', { fileIds: [ids[0] as FileId, ids[2] as FileId], label: 'Borrowed camera' });
    const strips = service.strips().strips;
    expect(strips.find((s) => s.label === 'Borrowed camera')?.fileCount).toBe(2);
    expect(strips.reduce((n, s) => n + s.fileCount, 0)).toBe(3);
  });

  it('puts everything back with reset all, and undo restores the work', () => {
    service.regroup('device');
    const sony = stripFor('sony');
    service.cut(sony.id, at('2024-07-12T10:30:00'));
    service.setOffset(stripFor('phone').id, 600);
    service.resetAll();
    expect(service.strips().strips).toHaveLength(2);
    expect(service.strips().strips.every((s) => s.offsetSeconds === 0)).toBe(true);

    service.undo();
    expect(service.strips().strips).toHaveLength(3);
  });
});
