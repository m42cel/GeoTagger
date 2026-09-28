import { describe, it, expect } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import {
  buildModifiedStamp,
  buildPositionRestore,
  buildPositionWrite,
  buildTimeRestore,
  buildTimeWrite,
  clearModifiedStamp,
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

const resolved: ResolvedTimeWrite = { localIso: '2024-07-12T14:32:10', utcOffsetMinutes: 120, timeShiftSeconds: 3732 };
const resolvedVideo: ResolvedTimeWrite = { localIso: '2024-07-12T12:32:10', utcOffsetMinutes: 120, timeShiftSeconds: 3732 };

const original: OriginalSnapshot = {
  dateTimeOriginal: '2024-07-12T13:30:00',
  offsetTimeOriginal: null,
  gpsPresent: false,
  gpsLatitude: null,
  gpsLongitude: null,
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

  it('writes QuickTime UTC for a video, and no EXIF offset tags', () => {
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'video' }, resolvedVideo, null);
    expect(tags['QuickTime:CreateDate']).toBe('2024:07:12 12:32:10');
    expect(tags['EXIF:DateTimeOriginal']).toBeUndefined();
    expect(tags['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(wroteUtcOffset).toBe(false);
    expect(writesUtcOffsetTag('video')).toBe(false);
  });

  it('preserves the original values in the geotagger namespace on the first write', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, resolved, original);
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBe('2024:07:12 13:30:00');
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
    // GPS originals are the position half's business, not time's.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`]).toBeUndefined();
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

  it('preserves the original GPS in the geotagger namespace on the first write', () => {
    const { tags } = buildPositionWrite(
      { kind: 'image' },
      positionPayload,
      { gpsPresent: true, gpsLatitude: 1.5, gpsLongitude: 2.5 },
    );
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`]).toBe('True');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBe('1.5');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitude`]).toBe('2.5');
  });
});

describe('buildTimeRestore', () => {
  it('puts back what the file said, and clears only the time half', () => {
    const { tags, restoredLocalIso } = buildTimeRestore({ kind: 'image' }, original);
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 13:30:00');
    expect(tags['EXIF:OffsetTimeOriginal']).toBeNull();
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeNull();
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBeNull();
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`]).toBeUndefined();
    expect(restoredLocalIso).toBe('2024-07-12T13:30:00');
  });

  it('removes the tags entirely from a file that never had a date', () => {
    const { tags } = buildTimeRestore({ kind: 'image' }, { ...original, dateTimeOriginal: null });
    expect(tags['EXIF:DateTimeOriginal']).toBeNull();
    expect(tags['EXIF:CreateDate']).toBeNull();
  });

  it('reverts a video’s QuickTime date and nothing EXIF', () => {
    const { tags } = buildTimeRestore({ kind: 'video' }, original);
    expect(tags['QuickTime:CreateDate']).toBe('2024:07:12 13:30:00');
    expect(tags['EXIF:DateTimeOriginal']).toBeUndefined();
  });
});

describe('buildPositionRestore', () => {
  it('puts back the original GPS and clears only the position half', () => {
    const { tags, restoredLat, restoredLon } = buildPositionRestore(
      { kind: 'image' },
      { gpsPresent: true, gpsLatitude: 1.5, gpsLongitude: -2.5 },
    );
    expect(tags['EXIF:GPSLatitude']).toBe(1.5);
    expect(tags['EXIF:GPSLatitudeRef']).toBe('N');
    expect(tags['EXIF:GPSLongitude']).toBe(2.5);
    expect(tags['EXIF:GPSLongitudeRef']).toBe('W');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`]).toBeNull();
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
    expect(restoredLat).toBe(1.5);
    expect(restoredLon).toBe(-2.5);
  });

  it('removes GPS tags entirely from a file that never had any', () => {
    const { tags, restoredLat, restoredLon } = buildPositionRestore(
      { kind: 'image' },
      { gpsPresent: false, gpsLatitude: null, gpsLongitude: null },
    );
    expect(tags['EXIF:GPSLatitude']).toBeNull();
    expect(tags['XMP:GPSLatitude']).toBeNull();
    expect(restoredLat).toBeNull();
    expect(restoredLon).toBeNull();
  });
});

describe('the shared ModifiedAt/AppVersion stamp', () => {
  it('is written once for whichever half(s) are active', () => {
    const stamp = buildModifiedStamp('0.1.0');
    expect(stamp[`${GEOTAGGER_GROUP}:AppVersion`]).toBe('0.1.0');
    expect(stamp[`${GEOTAGGER_GROUP}:ModifiedAt`]).toBeTruthy();
  });

  it('clears cleanly once neither half remains', () => {
    const cleared = clearModifiedStamp();
    expect(cleared[`${GEOTAGGER_GROUP}:ModifiedAt`]).toBeNull();
    expect(cleared[`${GEOTAGGER_GROUP}:AppVersion`]).toBeNull();
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
