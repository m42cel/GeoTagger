import { describe, it, expect } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import {
  buildModifiedStamp,
  buildPositionWrite,
  buildTimeWrite,
  fromExifDate,
  localIsoForFile,
  toExifDate,
  writesUtcOffsetTag,
  type OriginalSnapshot,
  type PositionPayload,
  type ResolvedTimeWrite,
  type TimePayload,
} from './tags.js';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

const at = (iso: string) => naiveToMs(iso) as number;

const payload: TimePayload = {
  effectiveMs: at('2024-07-12T12:32:10'),
  utcOffsetMinutes: 120,
  timeShiftSeconds: 3732,
};

const resolved: ResolvedTimeWrite = { localIso: '2024-07-12T14:32:10', utcOffsetMinutes: 120, writesUtcOffset: true, timeShiftSeconds: 3732 };
const resolvedVideo: ResolvedTimeWrite = { localIso: '2024-07-12T12:32:10', utcOffsetMinutes: 120, writesUtcOffset: false, timeShiftSeconds: 3732 };

/** A photo with a date but no offset and no GPS, as the file itself held it. */
const original: OriginalSnapshot = {
  dateTimeOriginal: '2024-07-12T13:30:00',
  offsetTimeOriginal: null,
  gpsLatitude: null,
  gpsLongitude: null,
  tags: {
    'EXIF:DateTimeOriginal': '2024:07:12 13:30:00',
    'EXIF:CreateDate': '2024:07:12 13:29:00',
    'EXIF:OffsetTimeOriginal': null,
    'EXIF:OffsetTimeDigitized': null,
    'QuickTime:CreateDate': '2024:07:12 13:30:00',
    'EXIF:GPSLatitude': null,
    'EXIF:GPSLatitudeRef': null,
    'EXIF:GPSLongitude': null,
    'EXIF:GPSLongitudeRef': null,
    'QuickTime:GPSCoordinates': null,
    'XMP:GPSLatitude': null,
    'XMP:GPSLongitude': null,
  },
};

/** The same file with the camera's own coordinates, EXIF only — no XMP block. */
const withCameraGps: OriginalSnapshot = {
  ...original,
  gpsLatitude: 1.5,
  gpsLongitude: -2.5,
  tags: {
    ...original.tags,
    'EXIF:GPSLatitude': '1.5',
    'EXIF:GPSLatitudeRef': 'N',
    'EXIF:GPSLongitude': '2.5',
    'EXIF:GPSLongitudeRef': 'W',
  },
};

const positionPayload: PositionPayload = {
  lat: 47.1234,
  lon: 11.3456,
  source: 'manual',
  uncertaintyM: null,
};

describe('localIsoForFile', () => {
  it('writes a photo’s local wall clock', () => {
    expect(localIsoForFile('image', payload)).toBe('2024-07-12T14:32:10');
  });

  it('writes a video’s UTC, which is what QuickTime stores', () => {
    expect(localIsoForFile('video', payload)).toBe('2024-07-12T12:32:10');
  });
});

describe('buildTimeWrite', () => {
  it('writes both EXIF date tags and the offset for a photo', () => {
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'image' }, resolved, null);
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:CreateDate']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:OffsetTimeOriginal']).toBe('+02:00');
    expect(tags['EXIF:OffsetTimeDigitized']).toBe('+02:00');
    expect(wroteUtcOffset).toBe(true);
  });

  it('corrects the date without touching the offset tags when the plan withholds it', () => {
    // The offset was only assumed, so §4.2 keeps the file's local time as ambiguous as
    // it was: the date is still corrected, but nothing claims to know the zone.
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'image' }, { ...resolved, writesUtcOffset: false }, null);
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(tags['EXIF:OffsetTimeDigitized']).toBeUndefined();
    expect(wroteUtcOffset).toBe(false);
  });

  it('writes QuickTime UTC for a video, and no EXIF offset tags', () => {
    // Passed `writesUtcOffset: true` a video still gets none: the tags are EXIF.
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'video' }, { ...resolvedVideo, writesUtcOffset: true }, null);
    expect(tags['QuickTime:CreateDate']).toBe('2024:07:12 12:32:10');
    expect(tags['EXIF:DateTimeOriginal']).toBeUndefined();
    expect(tags['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(wroteUtcOffset).toBe(false);
    expect(writesUtcOffsetTag('video')).toBe(false);
  });

  it('preserves one original per tag it writes, on the first write', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, resolved, original.tags);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBe('2024:07:12 13:30:00');
    // Its own value, not the one derived from DateTimeOriginal.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalCreateDate`]).toBe('2024:07:12 13:29:00');
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
    // GPS originals are the position half's business, not time's.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBeUndefined();
  });

  it('preserves a tag the file did not have as n/a, not as nothing at all', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, resolved, original.tags);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBe('n/a');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeDigitized`]).toBe('n/a');
  });

  it('preserves only the video tag it actually writes', () => {
    const { tags } = buildTimeWrite({ kind: 'video' }, resolvedVideo, original.tags);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalCreateDate`]).toBe('2024:07:12 13:30:00');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
    expect(tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBeUndefined();
  });

  it('leaves the preserved originals alone on a second write', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, resolved, null);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
    // The shift still updates: it describes the write, not the original.
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
  });
});

describe('buildPositionWrite', () => {
  it('writes EXIF lat/lon with refs and mirrors XMP for a photo', () => {
    const { tags } = buildPositionWrite({ kind: 'image' }, positionPayload, null);
    expect(tags['EXIF:GPSLatitude']).toBe(47.1234);
    expect(tags['EXIF:GPSLatitudeRef']).toBe('N');
    expect(tags['EXIF:GPSLongitude']).toBe(11.3456);
    expect(tags['EXIF:GPSLongitudeRef']).toBe('E');
    expect(tags['XMP:GPSLatitude']).toBe(47.1234);
    expect(tags['XMP:GPSLongitude']).toBe(11.3456);
  });

  it('uses south/west refs for negative coordinates', () => {
    const { tags } = buildPositionWrite({ kind: 'image' }, { ...positionPayload, lat: -8.5, lon: -34.2 }, null);
    expect(tags['EXIF:GPSLatitude']).toBe(8.5);
    expect(tags['EXIF:GPSLatitudeRef']).toBe('S');
    expect(tags['EXIF:GPSLongitude']).toBe(34.2);
    expect(tags['EXIF:GPSLongitudeRef']).toBe('W');
  });

  it('writes ISO 6709 QuickTime:GPSCoordinates for a video, and XMP alongside', () => {
    const { tags } = buildPositionWrite({ kind: 'video' }, positionPayload, null);
    expect(tags['QuickTime:GPSCoordinates']).toBe('+47.1234+11.3456/');
    expect(tags['EXIF:GPSLatitude']).toBeUndefined();
    expect(tags['XMP:GPSLatitude']).toBe(47.1234);
  });

  it('writes provenance on every write, not just the first', () => {
    const { tags } = buildPositionWrite(
      { kind: 'image' },
      { lat: 1, lon: 2, source: 'interpolated-confirmed', uncertaintyM: 42.4 },
      null,
    );
    expect(tags[`${GEOTAGGER_GROUP}:PositionSource`]).toBe('interpolated-confirmed');
    expect(tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`]).toBe('42');
  });

  it('preserves one original per GPS tag it writes, on the first write', () => {
    const { tags } = buildPositionWrite({ kind: 'image' }, positionPayload, withCameraGps.tags);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBe('1.5');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitudeRef`]).toBe('N');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitude`]).toBe('2.5');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitudeRef`]).toBe('W');
    // The file had EXIF coordinates but no XMP ones, and says so.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalXMPGPSLatitude`]).toBe('n/a');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalXMPGPSLongitude`]).toBe('n/a');
    // Time originals are the other half's business.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
  });
});

describe('the shared ModifiedAt/AppVersion stamp', () => {
  it('is written once for whichever half(s) are active', () => {
    const stamp = buildModifiedStamp('0.1.0');
    expect(stamp[`${GEOTAGGER_GROUP}:AppVersion`]).toBe('0.1.0');
    expect(stamp[`${GEOTAGGER_GROUP}:ModifiedAt`]).toBeTruthy();
  });
});

describe('ExifTool date formatting', () => {
  it('round-trips', () => {
    expect(fromExifDate(toExifDate('2024-07-12T14:32:10'))).toBe('2024-07-12T14:32:10');
  });

  it('refuses something that is not a timestamp', () => {
    expect(() => toExifDate('soon')).toThrow();
    expect(fromExifDate('soon')).toBeNull();
  });
});
