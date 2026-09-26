import { describe, it, expect } from 'vitest';
import type { FileRecord, UtcOffsetRule } from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import {
  buildUtcOffsetRules,
  displayOffsetFor,
  dominantOffsetMinutes,
  hasTrustworthyClock,
  resolveUtcOffset,
  ruleForNaiveReading,
} from './utc-offset.js';
import { offsetForNaiveReading, zoneForCoordinates, zoneOffsetMinutes } from './zones.js';

const at = (iso: string) => naiveToMs(iso) as number;

const ROME = { lat: 41.9028, lon: 12.4964 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };

function file(over: Partial<FileRecord>): FileRecord {
  return {
    id: 1,
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
    captureTimeRaw: '2024-07-12T14:32:10',
    captureTimeSource: 'exif:DateTimeOriginal',
    captureUtcOffsetMinutes: null,
    gpsTimeUtc: null,
    origGpsPresent: false,
    origLat: null,
    origLon: null,
    firstSeenAt: 0,
    lastScannedAt: 0,
    missing: false,
    thumbState: 'ready',
    ...over,
  };
}

describe('zones', () => {
  it('finds the zone a coordinate falls in, offline', () => {
    expect(zoneForCoordinates(ROME.lat, ROME.lon)).toBe('Europe/Rome');
    expect(zoneForCoordinates(NEW_YORK.lat, NEW_YORK.lon)).toBe('America/New_York');
  });

  it('refuses coordinates that are not coordinates', () => {
    expect(zoneForCoordinates(Number.NaN, 0)).toBeNull();
    expect(zoneForCoordinates(120, 0)).toBeNull();
  });

  it('knows summer time from winter time', () => {
    expect(zoneOffsetMinutes('Europe/Rome', Date.UTC(2024, 6, 12, 12))).toBe(120);
    expect(zoneOffsetMinutes('Europe/Rome', Date.UTC(2024, 0, 12, 12))).toBe(60);
    expect(zoneOffsetMinutes('America/New_York', Date.UTC(2024, 6, 12, 12))).toBe(-240);
  });

  it('resolves a bare wall-clock reading against a zone', () => {
    expect(offsetForNaiveReading('Europe/Rome', at('2024-07-12T14:32:10'))).toBe(120);
    expect(offsetForNaiveReading('Europe/Rome', at('2024-01-12T14:32:10'))).toBe(60);
  });
});

describe('buildUtcOffsetRules', () => {
  it('derives one period for a trip that stayed put', () => {
    const rules = buildUtcOffsetRules([
      file({ id: 1, captureTimeRaw: '2024-07-12T09:00:00', origGpsPresent: true, origLat: ROME.lat, origLon: ROME.lon }),
      file({ id: 2, captureTimeRaw: '2024-07-14T18:00:00', origGpsPresent: true, origLat: ROME.lat, origLon: ROME.lon }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.offsetMinutes).toBe(120);
    expect(rules[0]?.zone).toBe('Europe/Rome');
    expect(rules[0]?.fromUtc).toBe(at('2024-07-12T07:00:00'));
    expect(rules[0]?.toUtc).toBe(at('2024-07-14T16:00:00'));
  });

  it('splits into periods when the trip crossed a border', () => {
    const rules = buildUtcOffsetRules([
      file({ id: 1, captureTimeRaw: '2024-07-12T09:00:00', origGpsPresent: true, origLat: ROME.lat, origLon: ROME.lon }),
      file({ id: 2, captureTimeRaw: '2024-07-15T09:00:00', origGpsPresent: true, origLat: NEW_YORK.lat, origLon: NEW_YORK.lon }),
    ]);
    expect(rules.map((r) => r.offsetMinutes)).toEqual([120, -240]);
  });

  it('ignores a file whose time came from its name or its mtime', () => {
    const untrustworthy = file({
      captureTimeSource: 'filename',
      origGpsPresent: true,
      origLat: ROME.lat,
      origLon: ROME.lon,
    });
    expect(hasTrustworthyClock(untrustworthy)).toBe(false);
    expect(buildUtcOffsetRules([untrustworthy])).toEqual([]);
  });

  it('ignores a file with a clock but no coordinates', () => {
    expect(buildUtcOffsetRules([file({})])).toEqual([]);
  });

  it('uses the offset a file states about itself to place it', () => {
    // A video: its reading is UTC, so 07:00 UTC is 09:00 in Rome.
    const rules = buildUtcOffsetRules([
      file({
        kind: 'video',
        captureTimeRaw: '2024-07-12T07:00:00',
        captureTimeSource: 'quicktime:CreateDate',
        captureUtcOffsetMinutes: 0,
        origGpsPresent: true,
        origLat: ROME.lat,
        origLon: ROME.lon,
      }),
    ]);
    expect(rules[0]?.fromUtc).toBe(at('2024-07-12T07:00:00'));
    expect(rules[0]?.offsetMinutes).toBe(120);
  });
});

describe('ruleForNaiveReading', () => {
  const rules: UtcOffsetRule[] = [
    { id: 1, fromUtc: at('2024-07-12T07:00:00'), toUtc: at('2024-07-14T16:00:00'), offsetMinutes: 120, source: 'gps', zone: 'Europe/Rome' },
    { id: 2, fromUtc: at('2024-07-16T13:00:00'), toUtc: at('2024-07-18T20:00:00'), offsetMinutes: -240, source: 'gps', zone: 'America/New_York' },
  ];

  it('matches a reading inside a period, compared in that period’s own local time', () => {
    expect(ruleForNaiveReading(rules, at('2024-07-13T11:00:00'))?.id).toBe(1);
    expect(ruleForNaiveReading(rules, at('2024-07-17T11:00:00'))?.id).toBe(2);
  });

  it('falls back to the nearest period in the gap between two', () => {
    expect(ruleForNaiveReading(rules, at('2024-07-15T02:00:00'))?.id).toBe(1);
    expect(ruleForNaiveReading(rules, at('2024-07-16T06:00:00'))?.id).toBe(2);
  });

  it('has nothing to say with no rules at all', () => {
    expect(ruleForNaiveReading([], at('2024-07-13T11:00:00'))).toBeNull();
  });
});

describe('resolveUtcOffset', () => {
  const rules: UtcOffsetRule[] = [
    { id: 1, fromUtc: at('2024-07-12T07:00:00'), toUtc: at('2024-07-14T16:00:00'), offsetMinutes: 120, source: 'gps', zone: 'Europe/Rome' },
  ];
  const none = { file: null, strip: null, folder: null };

  it('inherits from the period a local-time-only file falls in', () => {
    const resolved = resolveUtcOffset(file({}), at('2024-07-13T11:00:00'), rules, none);
    expect(resolved).toEqual({ minutes: 120, source: 'inherited' });
  });

  it('prefers what the file states about itself over inheritance', () => {
    const resolved = resolveUtcOffset(file({ captureUtcOffsetMinutes: 0 }), at('2024-07-13T11:00:00'), rules, none);
    expect(resolved).toEqual({ minutes: 0, source: 'file' });
  });

  it('lets a strip override win over the file, and a file override over both', () => {
    const f = file({ captureUtcOffsetMinutes: 0 });
    expect(resolveUtcOffset(f, 0, rules, { ...none, strip: 60 }).source).toBe('strip');
    expect(resolveUtcOffset(f, 0, rules, { ...none, strip: 60, file: 90 })).toEqual({
      minutes: 90,
      source: 'file-override',
    });
  });

  it('uses the folder answer when there is nothing to inherit from', () => {
    expect(resolveUtcOffset(file({}), at('2024-07-13T11:00:00'), [], { ...none, folder: 330 })).toEqual({
      minutes: 330,
      source: 'folder',
    });
  });

  it('assumes UTC as the last resort rather than refusing to place the file', () => {
    expect(resolveUtcOffset(file({}), at('2024-07-13T11:00:00'), [], none)).toEqual({
      minutes: 0,
      source: 'assumed',
    });
  });
});

describe('displayOffsetFor', () => {
  const noRules: UtcOffsetRule[] = [];

  it('leaves a local-time-only resolution alone', () => {
    const resolved = { minutes: 120, source: 'inherited' as const };
    expect(displayOffsetFor(file({}), at('2024-07-13T11:00:00'), resolved, noRules)).toBe(120);
  });

  it('leaves a genuinely stated EXIF offset alone', () => {
    // An EXIF file's own OffsetTimeOriginal is a real, stated zone, not a UTC-by-
    // convention placeholder, so there is nothing to look up.
    const resolved = { minutes: -360, source: 'file' as const };
    expect(displayOffsetFor(file({}), at('2024-07-13T11:00:00'), resolved, noRules)).toBe(-360);
  });

  it('derives the real zone from a video’s own GPS instead of showing UTC', () => {
    // The video's reading (07:00) is genuinely the UTC instant, and NY is on
    // daylight time at that point in the year.
    const resolved = { minutes: 0, source: 'file' as const };
    const video = file({
      kind: 'video',
      captureTimeSource: 'quicktime:CreateDate',
      captureUtcOffsetMinutes: 0,
      origGpsPresent: true,
      origLat: NEW_YORK.lat,
      origLon: NEW_YORK.lon,
    });
    expect(displayOffsetFor(video, at('2024-07-12T07:00:00'), resolved, noRules)).toBe(-240);
  });

  it('falls back to the covering trip period for a video with no GPS of its own', () => {
    const rules: UtcOffsetRule[] = [
      { id: 1, fromUtc: at('2024-07-12T05:00:00'), toUtc: at('2024-07-14T14:00:00'), offsetMinutes: -240, source: 'gps', zone: 'America/New_York' },
    ];
    const resolved = { minutes: 0, source: 'file' as const };
    const video = file({
      kind: 'video',
      captureTimeSource: 'quicktime:CreateDate',
      captureUtcOffsetMinutes: 0,
      origGpsPresent: false,
    });
    expect(displayOffsetFor(video, at('2024-07-12T07:00:00'), resolved, rules)).toBe(-240);
  });

  it('falls back to the placeholder when there is nowhere else to look', () => {
    const resolved = { minutes: 0, source: 'file' as const };
    const video = file({
      kind: 'video',
      captureTimeSource: 'quicktime:CreateDate',
      captureUtcOffsetMinutes: 0,
      origGpsPresent: false,
    });
    expect(displayOffsetFor(video, at('2024-07-12T07:00:00'), resolved, noRules)).toBe(0);
  });
});

describe('dominantOffsetMinutes', () => {
  it('picks the offset most of the folder is in', () => {
    expect(dominantOffsetMinutes([120, 120, -240])).toBe(120);
  });
  it('falls back when there is nothing to count', () => {
    expect(dominantOffsetMinutes([], 60)).toBe(60);
  });
});
