import { describe, it, expect } from 'vitest';
import type { FileRecord, StripRecord } from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import { buildTimeline } from './timeline.js';

const at = (iso: string) => naiveToMs(iso) as number;

// Denver in August: MDT, UTC-6.
const DENVER = { lat: 39.7392, lon: -104.9903 };

function file(over: Partial<FileRecord>): FileRecord {
  return {
    id: 'f1',
    relPath: 'IMG_0001.JPG',
    filename: 'IMG_0001.JPG',
    ext: 'jpg',
    kind: 'image',
    sizeBytes: 100,
    mtime: 0,
    deviceId: null,
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    captureTimeRaw: '2024-08-22T18:08:56',
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

function strip(over: Partial<StripRecord>): StripRecord {
  return {
    id: 1,
    lane: 0,
    ordinal: 0,
    label: 'strip',
    groupingSource: 'device',
    parentStripId: null,
    offsetSeconds: 0,
    drift: 0,
    driftOriginMs: null,
    pinnedFileIds: [],
    locked: false,
    utcOffsetOverrideMinutes: null,
    createdAt: 0,
    fileCount: 0,
    firstCaptureMs: null,
    lastCaptureMs: null,
    firstEffectiveMs: null,
    lastEffectiveMs: null,
    ...over,
  };
}

describe('buildTimeline', () => {
  it('shows a photo and a video shot minutes apart at the same place at the same offset', () => {
    // Reproduces the report: a phone photo (EXIF, explicit -06:00) and a video from
    // the same place moments later (QuickTime, UTC by convention, with its own GPS)
    // used to alternate between -06:00 and +00:00 in resolution order.
    const photo = file({
      id: 'f1',
      captureTimeRaw: '2024-08-22T18:08:56',
      captureTimeSource: 'exif:DateTimeOriginal',
      captureUtcOffsetMinutes: -360,
    });
    const video = file({
      id: 'f2',
      kind: 'video',
      captureTimeRaw: '2024-08-23T00:37:40',
      captureTimeSource: 'quicktime:CreateDate',
      captureUtcOffsetMinutes: 0,
      origGpsPresent: true,
      origLat: DENVER.lat,
      origLon: DENVER.lon,
    });
    const s = strip({ id: 1 });

    const timeline = buildTimeline({
      files: [photo, video],
      strips: [s],
      assignments: { f1: 1, f2: 1 },
      rules: [],
      folderUtcOffsetMinutes: null,
      fileOverrides: new Map(),
    });

    const [photoLine, videoLine] = timeline.files;
    expect(photoLine?.utcOffsetMinutes).toBe(-360);
    expect(videoLine?.utcOffsetMinutes).toBe(-360);

    // The video's absolute instant is untouched — still derived with the true `0`
    // adjustment, not shifted by the display offset above.
    expect(videoLine?.effectiveMs).toBe(at('2024-08-23T00:37:40'));
    // 28m44s after the photo, exactly as the raw readings say.
    expect((videoLine?.effectiveMs as number) - (photoLine?.effectiveMs as number)).toBe(28 * 60_000 + 44_000);
  });

  it("evaluates a stretched strip's correction at each file's own raw reading (SPEC §4.3)", () => {
    const early = file({ id: 'f1', captureTimeRaw: '2024-07-12T10:00:00', captureUtcOffsetMinutes: 0 });
    const late = file({ id: 'f2', captureTimeRaw: '2024-07-12T16:00:00', captureUtcOffsetMinutes: 0 });
    // Pinned at 10:00 with a 30 s offset, gaining 10 s an hour from there.
    const s = strip({ id: 1, offsetSeconds: 30, drift: 10 / 3600, driftOriginMs: at('2024-07-12T10:00:00') });

    const timeline = buildTimeline({
      files: [early, late],
      strips: [s],
      assignments: { f1: 1, f2: 1 },
      rules: [],
      folderUtcOffsetMinutes: null,
      fileOverrides: new Map(),
    });

    const [earlyLine, lateLine] = timeline.files;
    expect(earlyLine?.offsetSeconds).toBe(30);
    expect(earlyLine?.effectiveMs).toBe(at('2024-07-12T10:00:30'));
    expect(lateLine?.offsetSeconds).toBeCloseTo(90, 9);
    expect(lateLine?.effectiveMs).toBeCloseTo(at('2024-07-12T16:01:30'), 3);
  });
});
