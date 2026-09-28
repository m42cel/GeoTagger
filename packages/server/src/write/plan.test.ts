import { describe, it, expect } from 'vitest';
import type { FileRecord, StripRecord, TimelineFile } from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import { buildPersistPlan, type ConfirmedPositionEdit, type PlanContext } from './plan.js';
import type { Timeline } from '../time/timeline.js';
import type { AppliedState, OriginalSnapshot } from './tags.js';

const at = (iso: string) => naiveToMs(iso) as number;

function file(over: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 1,
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
    id: 1,
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
    resetToOriginalAt: null,
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
    applied: new Map<number, AppliedState>(),
    originals: new Map<number, OriginalSnapshot>(),
    confirmedPositions: new Map<number, ConfirmedPositionEdit>(),
    positionResetToOriginalFileIds: new Set<number>(),
    currentSig: () => '1024:10',
    storedSig: () => '1024:10',
    ...rest,
  };
}

describe('buildPersistPlan — time (SPEC §9.1)', () => {
  it('writes the UTC offset to a file that had none, even with no correction', () => {
    const plan = buildPersistPlan(context([file()], [line()]));
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.timeKind).toBe('none');
    expect(plan.entries[0]?.writesUtcOffset).toBe(true);
    expect(plan.correctedTimestamps).toBe(0);
    expect(plan.utcOffsetsAdded).toBe(1);
  });

  it('writes a corrected timestamp', () => {
    const plan = buildPersistPlan(
      context(
        [file()],
        [line({ offsetSeconds: 3600, effectiveMs: at('2024-07-12T13:00:00') })],
      ),
    );
    expect(plan.entries[0]?.timeKind).toBe('write');
    expect(plan.entries[0]?.newLocalIso).toBe('2024-07-12T15:00:00');
    expect(plan.entries[0]?.timeShiftSeconds).toBe(3600);
    expect(plan.correctedTimestamps).toBe(1);
  });

  it('leaves out a file that already says exactly what it should', () => {
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()]),
    );
    expect(plan.entries).toEqual([]);
  });

  it('leaves out a file GeoTagger already wrote the same value to', () => {
    const applied = new Map<number, AppliedState>([
      [1, timeApplied('2024-07-12T15:00:00', 120, 3600)],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 3600, effectiveMs: at('2024-07-12T13:00:00') })], { applied }),
    );
    expect(plan.entries).toEqual([]);
  });

  it('writes the difference when the correction was changed after a persist', () => {
    const applied = new Map<number, AppliedState>([
      [1, timeApplied('2024-07-12T15:00:00', 120, 3600)],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 7200, effectiveMs: at('2024-07-12T14:00:00') })], { applied }),
    );
    expect(plan.entries[0]?.newLocalIso).toBe('2024-07-12T16:00:00');
  });

  it('writes a video’s UTC and asks for no offset tag', () => {
    const plan = buildPersistPlan(
      context(
        [file({ kind: 'video', ext: 'mp4', captureTimeRaw: '2024-07-12T12:00:00', captureUtcOffsetMinutes: 0 })],
        [line({ offsetSeconds: 600, effectiveMs: at('2024-07-12T12:10:00') })],
      ),
    );
    expect(plan.entries[0]?.newLocalIso).toBe('2024-07-12T12:10:00');
    expect(plan.entries[0]?.writesUtcOffset).toBe(false);
  });

  it('never writes an offset that was only assumed (SPEC §4.2)', () => {
    // Nothing in the folder knew its offset, so UTC was assumed to place the file on
    // the timeline. Writing that into the file would turn a guess into a fact.
    const plan = buildPersistPlan(
      // Assumed UTC: the file's wall clock is taken at face value, so it already
      // says exactly what it would be written.
      context(
        [file()],
        [line({ utcOffsetMinutes: 0, utcOffsetSource: 'assumed', effectiveMs: at('2024-07-12T14:00:00') })],
      ),
    );
    expect(plan.entries).toEqual([]);
  });

  it('still corrects the time of a file whose offset is only assumed', () => {
    const plan = buildPersistPlan(
      context(
        [file()],
        [line({ utcOffsetMinutes: 0, utcOffsetSource: 'assumed', offsetSeconds: 3600, effectiveMs: at('2024-07-12T15:00:00') })],
      ),
    );
    expect(plan.entries[0]?.timeKind).toBe('write');
    expect(plan.entries[0]?.writesUtcOffset).toBe(false);
    expect(plan.entries[0]?.newLocalIso).toBe('2024-07-12T15:00:00');
  });

  it('flags a file that changed on disk since it was scanned (SPEC §8.3)', () => {
    const plan = buildPersistPlan(
      context([file()], [line()], { currentSig: () => '2048:99' }),
    );
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
  it('leaves out a file with no confirmed position, even with camera GPS or an estimate', () => {
    const plan = buildPersistPlan(context([file({ origGpsPresent: true, origLat: 1, origLon: 2 })], [line()]));
    expect(plan.entries[0]?.positionKind).toBe('none');
  });

  it('writes a confirmed manual position', () => {
    const confirmedPositions = new Map<number, ConfirmedPositionEdit>([
      [1, { lat: 47.1, lon: 11.2, positionSource: 'drag', uncertaintyM: null }],
    ]);
    const plan = buildPersistPlan(context([file()], [line()], { confirmedPositions }));
    expect(plan.entries[0]?.positionKind).toBe('write');
    expect(plan.entries[0]?.newLat).toBe(47.1);
    expect(plan.entries[0]?.newLon).toBe(11.2);
    expect(plan.entries[0]?.positionSource).toBe('manual');
  });

  it('marks an accepted estimate as "confirmed" provenance', () => {
    const confirmedPositions = new Map<number, ConfirmedPositionEdit>([
      [1, { lat: 47.1, lon: 11.2, positionSource: 'estimate', uncertaintyM: 30 }],
    ]);
    const plan = buildPersistPlan(context([file()], [line()], { confirmedPositions }));
    expect(plan.entries[0]?.positionSource).toBe('confirmed');
    expect(plan.entries[0]?.positionUncertaintyM).toBe(30);
  });

  it('leaves out a confirmed position GeoTagger already wrote', () => {
    const confirmedPositions = new Map<number, ConfirmedPositionEdit>([
      [1, { lat: 47.1, lon: 11.2, positionSource: 'drag', uncertaintyM: null }],
    ]);
    const applied = new Map<number, AppliedState>([
      [1, timeApplied(null, null, 0, { lat: 47.1, lon: 11.2 })],
    ]);
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()], { confirmedPositions, applied }),
    );
    expect(plan.entries).toEqual([]);
  });

  it('resolves to a restore when the confirmed position happens to equal the stored original', () => {
    const confirmedPositions = new Map<number, ConfirmedPositionEdit>([
      [1, { lat: 1.5, lon: 2.5, positionSource: 'drag', uncertaintyM: null }],
    ]);
    const originals = new Map<number, OriginalSnapshot>([
      [1, originalSnapshot({ gpsPresent: true, gpsLatitude: 1.5, gpsLongitude: 2.5 })],
    ]);
    const plan = buildPersistPlan(context([file()], [line()], { confirmedPositions, originals }));
    expect(plan.entries[0]?.positionKind).toBe('restore');
  });

  it('forces a restore to the original when reset-to-original is pending, regardless of camera GPS', () => {
    const originals = new Map<number, OriginalSnapshot>([
      [1, originalSnapshot({ gpsPresent: true, gpsLatitude: 5, gpsLongitude: 6 })],
    ]);
    const plan = buildPersistPlan(
      context([file({ origGpsPresent: true, origLat: 99, origLon: 99 })], [line()], {
        originals,
        positionResetToOriginalFileIds: new Set([1]),
      }),
    );
    expect(plan.entries[0]?.positionKind).toBe('restore');
    expect(plan.entries[0]?.newLat).toBe(5);
    expect(plan.entries[0]?.newLon).toBe(6);
  });

  it('needs nothing when reset-to-original is pending and the file already matches its original', () => {
    const originals = new Map<number, OriginalSnapshot>([
      [1, originalSnapshot({ gpsPresent: true, gpsLatitude: 5, gpsLongitude: 6 })],
    ]);
    const applied = new Map<number, AppliedState>([[1, timeApplied(null, null, 0, { lat: 5, lon: 6 })]]);
    const plan = buildPersistPlan(
      context([file({ captureUtcOffsetMinutes: 120 })], [line()], {
        originals,
        applied,
        positionResetToOriginalFileIds: new Set([1]),
      }),
    );
    expect(plan.entries).toEqual([]);
  });
});

describe('buildPersistPlan — strip reset-to-original (SPEC §9.4)', () => {
  it('forces every already-persisted file in a flagged strip back to its own raw original time', () => {
    const originals = new Map<number, OriginalSnapshot>([
      [1, originalSnapshot({ dateTimeOriginal: '2024-07-12T09:00:00', offsetTimeOriginal: null })],
    ]);
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 0, effectiveMs: at('2024-07-12T12:00:00') })], {
        originals,
        strips: [strip({ resetToOriginalAt: Date.now() })],
      }),
    );
    expect(plan.entries[0]?.timeKind).toBe('restore');
    expect(plan.entries[0]?.newLocalIso).toBe('2024-07-12T09:00:00');
  });

  it('leaves a never-persisted file in a flagged strip to the ordinary zeroed-offset write', () => {
    const plan = buildPersistPlan(
      context([file()], [line({ offsetSeconds: 0, effectiveMs: at('2024-07-12T12:00:00') })], {
        strips: [strip({ resetToOriginalAt: Date.now() })],
      }),
    );
    expect(plan.entries[0]?.timeKind).toBe('none');
  });
});

function timeApplied(
  localIso: string | null,
  utcOffsetMinutes: number | null,
  timeShiftSeconds: number,
  position: { lat: number | null; lon: number | null } = { lat: null, lon: null },
): AppliedState {
  return {
    localIso,
    utcOffsetMinutes,
    timeShiftSeconds,
    lat: position.lat,
    lon: position.lon,
    positionSource: null,
    positionUncertaintyM: null,
  };
}

function originalSnapshot(over: Partial<OriginalSnapshot> = {}): OriginalSnapshot {
  return {
    dateTimeOriginal: null,
    offsetTimeOriginal: null,
    gpsPresent: false,
    gpsLatitude: null,
    gpsLongitude: null,
    ...over,
  };
}
