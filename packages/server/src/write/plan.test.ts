import { describe, it, expect } from 'vitest';
import type { FileId, FileRecord, PersistPlanEntry, StripRecord, TimelineFile } from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import { buildPersistPlan, type ConfirmedPositionEdit, type PlanContext } from './plan.js';
import type { Timeline } from '../time/timeline.js';
import type { OriginalTagValues } from './tags.js';

const at = (iso: string) => naiveToMs(iso) as number;

function file(over: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 'f1',
    relPath: 'IMG_0001.JPG',
    filename: 'IMG_0001.JPG',
    ext: 'jpg',
    kind: 'image',
    sizeBytes: 1024,
    mtime: 10,
    deviceId: null,
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    captureTimeRaw: '2024-07-12T14:00:00',
    captureTimeSource: 'exif:DateTimeOriginal',
    captureUtcOffsetMinutes: null,
    gpsTimeUtc: null,
    origGpsPresent: false,
    origLat: null,
    origLon: null,
    origAlt: null,
    firstSeenAt: 0,
    lastScannedAt: 0,
    missing: false,
    thumbState: 'ready',
    ...over,
  };
}

function line(over: Partial<TimelineFile> = {}): TimelineFile {
  return {
    id: 'f1',
    stripId: 1,
    rawCaptureMs: at('2024-07-12T14:00:00'),
    utcOffsetMinutes: 120,
    utcOffsetSource: 'inherited',
    offsetSeconds: 0,
    effectiveMs: at('2024-07-12T12:00:00'),
    ...over,
  };
}

function strip(over: Partial<StripRecord> = {}): StripRecord {
  return {
    id: 1,
    lane: 0,
    ordinal: 0,
    label: 'strip',
    groupingSource: 'device',
    parentStripId: null,
    offsetSeconds: 0,
    locked: false,
    utcOffsetOverrideMinutes: null,
    createdAt: 0,
    fileCount: 1,
    firstCaptureMs: null,
    lastCaptureMs: null,
    firstEffectiveMs: null,
    lastEffectiveMs: null,
    ...over,
  };
}

function context(
  files: FileRecord[],
  lines: TimelineFile[],
  over: Partial<Omit<PlanContext, 'timeline'>> & { strips?: StripRecord[] } = {},
): PlanContext {
  const { strips, ...rest } = over;
  const timeline: Timeline = {
    files: lines,
    strips: strips ?? [strip()],
    displayUtcOffsetMinutes: 120,
    byId: new Map(lines.map((l) => [l.id, l])),
  };
  return {
    files,
    timeline,
    written: new Map<FileId, OriginalTagValues>(),
    confirmedPositions: new Map<FileId, ConfirmedPositionEdit>(),
    currentSig: () => '1024:10',
    storedSig: () => '1024:10',
    ...rest,
  };
}

/** The tags an entry changes, as `tag → new value`. */
function changed(entry: PersistPlanEntry | undefined): Record<string, string> {
  return Object.fromEntries((entry?.changes ?? []).map((c) => [c.tag, c.next]));
}

function stamping(entry: PersistPlanEntry | undefined): string[] {
  return (entry?.changes ?? []).filter((c) => c.stampsOriginal).map((c) => c.tag);
}

describe('buildPersistPlan — the per-tag diff (SPEC §9.1)', () => {
  it('writes the UTC offset to a file that had none, even with no correction', () => {
    const plan = buildPersistPlan(context([file()], [line()]));
    expect(changed(plan.entries[0])).toEqual({
      'EXIF:OffsetTimeOriginal': '+02:00',
      'EXIF:OffsetTimeDigitized': '+02:00',
    });
    expect(plan.entries[0]?.fields).toEqual([{ field: 'utcOffset', oldMinutes: null, newMinutes: 120 }]);
    expect(plan.correctedTimestamps).toBe(0);
    expect(plan.utcOffsetsAdded).toBe(1);
  });

  it('preserves the original of every tag it writes for the first time', () => {
    const plan = buildPersistPlan(context([file()], [line()]));
    expect(stamping(plan.entries[0])).toEqual(['EXIF:OffsetTimeOriginal', 'EXIF:OffsetTimeDigitized']);
  });

  it('writes a corrected timestamp, both date tags together', () => {
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line({ offsetSeconds: 3600, effectiveMs: at('2024-07-12T13:00:00') })]),
    );
    expect(changed(plan.entries[0])).toEqual({
      'EXIF:DateTimeOriginal': '2024:07:12 15:00:00',
      'EXIF:CreateDate': '2024:07:12 15:00:00',
    });
    expect(plan.entries[0]?.fields).toEqual([
      { field: 'timestamp', oldLocalIso: '2024-07-12T14:00:00', newLocalIso: '2024-07-12T15:00:00' },
    ]);
    expect(plan.entries[0]?.timeShiftSeconds).toBe(3600);
    expect(plan.correctedTimestamps).toBe(1);
  });

  it('leaves out a file that already says exactly what it should', () => {
    const plan = buildPersistPlan(context([file({ captureUtcOffsetMinutes: 120 })], [line()]));
    expect(plan.entries).toEqual([]);
  });

  it('leaves out a tag GeoTagger already wrote the same value to', () => {
    const written = new Map<FileId, OriginalTagValues>([
      ['f1', { 'EXIF:DateTimeOriginal': '2024:07:12 15:00:00', 'EXIF:CreateDate': '2024:07:12 15:00:00', 'EXIF:OffsetTimeOriginal': '+02:00', 'EXIF:OffsetTimeDigitized': '+02:00' }],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 3600, effectiveMs: at('2024-07-12T13:00:00') })], { written }),
    );
    expect(plan.entries).toEqual([]);
  });

  it('writes only the tags that moved when the correction was changed after a persist', () => {
    const written = new Map<FileId, OriginalTagValues>([
      ['f1', { 'EXIF:DateTimeOriginal': '2024:07:12 15:00:00', 'EXIF:CreateDate': '2024:07:12 15:00:00', 'EXIF:OffsetTimeOriginal': '+02:00', 'EXIF:OffsetTimeDigitized': '+02:00' }],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 7200, effectiveMs: at('2024-07-12T14:00:00') })], { written }),
    );
    expect(changed(plan.entries[0])).toEqual({
      'EXIF:DateTimeOriginal': '2024:07:12 16:00:00',
      'EXIF:CreateDate': '2024:07:12 16:00:00',
    });
    // The offset is unchanged, so it is not rewritten — and its original stays preserved.
    expect(stamping(plan.entries[0])).toEqual([]);
  });

  it('writes a video’s UTC and asks for no offset tag', () => {
    const plan = buildPersistPlan(
      context(
        [file({ kind: 'video', ext: 'mp4', captureTimeRaw: '2024-07-12T12:00:00', captureUtcOffsetMinutes: 0 })],
        [line({ offsetSeconds: 600, effectiveMs: at('2024-07-12T12:10:00') })],
      ),
    );
    expect(changed(plan.entries[0])).toEqual({ 'QuickTime:CreateDate': '2024:07:12 12:10:00' });
  });

  it('never writes an offset that was only assumed (SPEC §4.2)', () => {
    // Nothing in the folder knew its offset, so UTC was assumed to place the file on the
    // timeline. Writing that into the file would turn a guess into a fact.
    const plan = buildPersistPlan(
      context([file()], [line({ utcOffsetMinutes: 0, utcOffsetSource: 'assumed', effectiveMs: at('2024-07-12T14:00:00') })]),
    );
    expect(plan.entries).toEqual([]);
  });

  it('still corrects the time of a file whose offset is only assumed, without the offset tags', () => {
    const plan = buildPersistPlan(
      context(
        [file()],
        [line({ utcOffsetMinutes: 0, utcOffsetSource: 'assumed', offsetSeconds: 3600, effectiveMs: at('2024-07-12T15:00:00') })],
      ),
    );
    expect(changed(plan.entries[0])).toEqual({
      'EXIF:DateTimeOriginal': '2024:07:12 15:00:00',
      'EXIF:CreateDate': '2024:07:12 15:00:00',
    });
  });

  it('flags a file that changed on disk since it was scanned (SPEC §8.3)', () => {
    const plan = buildPersistPlan(context([file()], [line()], { currentSig: () => '2048:99' }));
    expect(plan.entries[0]?.stale).toBe(true);
    expect(plan.staleCount).toBe(1);
  });

  it('flags a file that has gone missing as stale rather than writing it', () => {
    const plan = buildPersistPlan(context([file()], [line()], { currentSig: () => null }));
    expect(plan.entries[0]?.stale).toBe(true);
  });

  it('skips a file with no timestamp at all', () => {
    const plan = buildPersistPlan(
      context([file({ captureTimeRaw: null, captureTimeSource: 'none' })], [line({ rawCaptureMs: null, effectiveMs: null })]),
    );
    expect(plan.entries).toEqual([]);
  });
});

describe('buildPersistPlan — position (SPEC §9.1, §9.2)', () => {
  const confirmed = new Map<FileId, ConfirmedPositionEdit>([
    ['f1', { lat: 47.1, lon: 11.2, positionSource: 'drag', uncertaintyM: null }],
  ]);

  it('leaves the position tags alone for a file with no confirmed position, even with camera GPS', () => {
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120, origGpsPresent: true, origLat: 1, origLon: 2 })], [line()]),
    );
    expect(plan.entries).toEqual([]);
  });

  it('writes a confirmed manual position across every tag that carries it', () => {
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()], { confirmedPositions: confirmed }),
    );
    expect(changed(plan.entries[0])).toEqual({
      'EXIF:GPSLatitude': '47.1',
      'EXIF:GPSLatitudeRef': 'N',
      'EXIF:GPSLongitude': '11.2',
      'EXIF:GPSLongitudeRef': 'E',
      'XMP:GPSLatitude': '47.1',
      'XMP:GPSLongitude': '11.2',
    });
    expect(plan.entries[0]?.fields).toEqual([
      { field: 'position', oldLat: null, oldLon: null, newLat: 47.1, newLon: 11.2 },
    ]);
    expect(plan.entries[0]?.positionSource).toBe('manual');
  });

  it('marks an accepted estimate as "confirmed" provenance', () => {
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()], {
        confirmedPositions: new Map([['f1', { lat: 47.1, lon: 11.2, positionSource: 'estimate', uncertaintyM: 30 }]]),
      }),
    );
    expect(plan.entries[0]?.positionSource).toBe('confirmed');
    expect(plan.entries[0]?.positionUncertaintyM).toBe(30);
  });

  it('leaves out a confirmed position GeoTagger already wrote', () => {
    const written = new Map<FileId, OriginalTagValues>([
      ['f1', { 'EXIF:GPSLatitude': '47.1', 'EXIF:GPSLatitudeRef': 'N', 'EXIF:GPSLongitude': '11.2', 'EXIF:GPSLongitudeRef': 'E', 'XMP:GPSLatitude': '47.1', 'XMP:GPSLongitude': '11.2' }],
    ]);
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()], { confirmedPositions: confirmed, written }),
    );
    expect(plan.entries).toEqual([]);
  });

  it('writes nothing when the confirmed position is what the camera already recorded', () => {
    // Accepting the camera's own fix changes no value, so there is nothing to write —
    // the scan cannot see which tags carried it, so it is read as carrying all of them.
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120, origGpsPresent: true, origLat: 47.1, origLon: 11.2 })], [line()], {
        confirmedPositions: confirmed,
      }),
    );
    expect(plan.entries).toEqual([]);
  });
});

describe('buildPersistPlan — one field at a time (SPEC §9.3)', () => {
  it('does not propose a field again after writing the other one', () => {
    // The bug this replaces: the record of the last write covered the whole file, so a
    // write of one field forgot the other and proposed it again on every Persist, for ever.
    const written = new Map<FileId, OriginalTagValues>([
      ['f1', {
        'EXIF:DateTimeOriginal': '2024:07:12 16:00:00',
        'EXIF:CreateDate': '2024:07:12 16:00:00',
        'EXIF:OffsetTimeOriginal': '+02:00',
        'EXIF:OffsetTimeDigitized': '+02:00',
        'EXIF:GPSLatitude': '47.1',
        'EXIF:GPSLatitudeRef': 'N',
        'EXIF:GPSLongitude': '11.2',
        'EXIF:GPSLongitudeRef': 'E',
        'XMP:GPSLatitude': '47.1',
        'XMP:GPSLongitude': '11.2',
      }],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 7200, effectiveMs: at('2024-07-12T14:00:00') })], {
        written,
        confirmedPositions: new Map([['f1', { lat: 47.1, lon: 11.2, positionSource: 'drag', uncertaintyM: null }]]),
      }),
    );
    expect(plan.entries).toEqual([]);
  });

  it('preserves only the originals of the tags in this write', () => {
    const written = new Map<FileId, OriginalTagValues>([
      ['f1', { 'EXIF:DateTimeOriginal': '2024:07:12 15:00:00', 'EXIF:CreateDate': '2024:07:12 15:00:00', 'EXIF:OffsetTimeOriginal': '+02:00', 'EXIF:OffsetTimeDigitized': '+02:00' }],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 3600, effectiveMs: at('2024-07-12T13:00:00') })], {
        written,
        confirmedPositions: new Map([['f1', { lat: 47.1, lon: 11.2, positionSource: 'drag', uncertaintyM: null }]]),
      }),
    );
    // The time tags have been written before; the position tags have not.
    expect(stamping(plan.entries[0])).toEqual([
      'EXIF:GPSLatitude',
      'EXIF:GPSLatitudeRef',
      'EXIF:GPSLongitude',
      'EXIF:GPSLongitudeRef',
      'XMP:GPSLatitude',
      'XMP:GPSLongitude',
    ]);
  });
});
