import { describe, it, expect } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import type { PersistTagChange } from '@geotagger/shared';
import {
  buildWrite,
  coordsFromTags,
  desiredTagValues,
  formatCoord,
  fromExifDate,
  legacyWrittenTags,
  localIsoForFile,
  preservedTagsFor,
  toExifDate,
  writesUtcOffsetTag,
  type OriginalTagValues,
  type Provenance,
  type TimeIntent,
} from './tags.js';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

const at = (iso: string) => naiveToMs(iso) as number;

/** 14:32:10 local at +02:00. */
const time: TimeIntent = { effectiveMs: at('2024-07-12T12:32:10'), utcOffsetMinutes: 120, writeOffset: true };
const provenance: Provenance = { timeShiftSeconds: 3732, positionSource: 'manual', positionUncertaintyM: null, appVersion: '0.1.0' };

function change(over: Partial<PersistTagChange> & Pick<PersistTagChange, 'tag'>): PersistTagChange {
  return { field: 'timestamp', old: null, next: 'x', stampsOriginal: false, ...over };
}

describe('localIsoForFile', () => {
  it('writes a photo’s local wall clock', () => {
    expect(localIsoForFile('image', time)).toBe('2024-07-12T14:32:10');
  });

  it('writes a video’s UTC, which is what QuickTime stores', () => {
    expect(localIsoForFile('video', time)).toBe('2024-07-12T12:32:10');
  });
});

describe('desiredTagValues', () => {
  it('gives a photo both date tags and both offset tags', () => {
    const want = desiredTagValues('image', time, null);
    expect(want['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(want['EXIF:CreateDate']).toBe('2024:07:12 14:32:10');
    expect(want['EXIF:OffsetTimeOriginal']).toBe('+02:00');
    expect(want['EXIF:OffsetTimeDigitized']).toBe('+02:00');
  });

  it('withholds the offset tags when the plan says so, keeping the dates', () => {
    // §4.2 withholds the tag, not the arithmetic: the wall clock is still the one the
    // offset implies, it is just not claimed in the file.
    const want = desiredTagValues('image', { ...time, writeOffset: false }, null);
    expect(want['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(want['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(want['EXIF:OffsetTimeDigitized']).toBeUndefined();
  });

  it('gives a video UTC and no offset tags at all', () => {
    const want = desiredTagValues('video', { ...time, writeOffset: false }, null);
    expect(want['QuickTime:CreateDate']).toBe('2024:07:12 12:32:10');
    expect(want['EXIF:DateTimeOriginal']).toBeUndefined();
    expect(writesUtcOffsetTag('video')).toBe(false);
  });

  it('splits a photo’s position into the EXIF pair with refs and mirrors it in XMP', () => {
    const want = desiredTagValues('image', null, { lat: 47.1234, lon: 11.3456 });
    expect(want['EXIF:GPSLatitude']).toBe('47.1234');
    expect(want['EXIF:GPSLatitudeRef']).toBe('N');
    expect(want['EXIF:GPSLongitude']).toBe('11.3456');
    expect(want['EXIF:GPSLongitudeRef']).toBe('E');
    expect(want['XMP:GPSLatitude']).toBe('47.1234');
    expect(want['XMP:GPSLongitude']).toBe('11.3456');
    // Nothing time-related: the plan had no opinion about it.
    expect(want['EXIF:DateTimeOriginal']).toBeUndefined();
  });

  it('uses south/west refs and unsigned EXIF values for negative coordinates', () => {
    const want = desiredTagValues('image', null, { lat: -8.5, lon: -34.2 });
    expect(want['EXIF:GPSLatitude']).toBe('8.5');
    expect(want['EXIF:GPSLatitudeRef']).toBe('S');
    expect(want['EXIF:GPSLongitude']).toBe('34.2');
    expect(want['EXIF:GPSLongitudeRef']).toBe('W');
    // XMP is signed, so it keeps them negative.
    expect(want['XMP:GPSLatitude']).toBe('-8.5');
    expect(want['XMP:GPSLongitude']).toBe('-34.2');
  });

  it('gives a video ISO 6709 coordinates, and XMP alongside', () => {
    const want = desiredTagValues('video', null, { lat: 47.1234, lon: 11.3456 });
    expect(want['QuickTime:GPSCoordinates']).toBe('+47.1234+11.3456/');
    expect(want['EXIF:GPSLatitude']).toBeUndefined();
    expect(want['XMP:GPSLatitude']).toBe('47.1234');
  });

  it('formats a coordinate the same way every time, however it was derived', () => {
    // The plan compares strings, so 1e-9 of drift must not read as a change to write.
    expect(formatCoord(47.12340000000001)).toBe(formatCoord(47.1234));
    expect(formatCoord(0.1 + 0.2)).toBe('0.3');
  });
});

describe('buildWrite', () => {
  it('writes each changed tag and nothing else', () => {
    const tags = buildWrite(
      { kind: 'image' },
      [change({ tag: 'EXIF:DateTimeOriginal', next: '2024:07:12 14:32:10' })],
      {},
      provenance,
    );
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:CreateDate']).toBeUndefined();
    expect(tags['EXIF:OffsetTimeOriginal']).toBeUndefined();
  });

  it('preserves the prior value of a tag it writes for the first time', () => {
    const original: OriginalTagValues = { 'EXIF:DateTimeOriginal': '2024:07:12 13:30:00', 'EXIF:CreateDate': null };
    const tags = buildWrite(
      { kind: 'image' },
      [
        change({ tag: 'EXIF:DateTimeOriginal', next: '2024:07:12 14:32:10', stampsOriginal: true }),
        change({ tag: 'EXIF:CreateDate', next: '2024:07:12 14:32:10', stampsOriginal: true }),
      ],
      original,
      provenance,
    );
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBe('2024:07:12 13:30:00');
    // Its own prior value, and `n/a` because the file did not have the tag at all.
    expect(tags[`${GEOTAGGER_GROUP}:OriginalCreateDate`]).toBe('n/a');
  });

  it('leaves the preserved original alone on a tag it has written before', () => {
    const tags = buildWrite(
      { kind: 'image' },
      [change({ tag: 'EXIF:DateTimeOriginal', next: '2024:07:12 15:00:00', stampsOriginal: false })],
      { 'EXIF:DateTimeOriginal': '2024:07:12 13:30:00' },
      provenance,
    );
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
    // The shift still updates: it describes the write, not the original.
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
  });

  it('writes the provenance of the fields it touched, and no other field’s', () => {
    const tags = buildWrite(
      { kind: 'image' },
      [change({ tag: 'EXIF:GPSLatitude', field: 'position', next: '47.1' })],
      {},
      { ...provenance, positionSource: 'interpolated-confirmed', positionUncertaintyM: 42.4 },
    );
    expect(tags[`${GEOTAGGER_GROUP}:PositionSource`]).toBe('interpolated-confirmed');
    expect(tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`]).toBe('42');
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBeUndefined();
  });

  it('stamps ModifiedAt and AppVersion on every write', () => {
    const tags = buildWrite({ kind: 'image' }, [change({ tag: 'EXIF:DateTimeOriginal' })], {}, provenance);
    expect(tags[`${GEOTAGGER_GROUP}:AppVersion`]).toBe('0.1.0');
    expect(tags[`${GEOTAGGER_GROUP}:ModifiedAt`]).toBeTruthy();
  });
});

describe('preservedTagsFor', () => {
  it('gives every tag an Original of its own', () => {
    const originals = preservedTagsFor('image').map((p) => p.original);
    expect(new Set(originals).size).toBe(originals.length);
    expect(originals).toContain('OriginalXMPGPSLatitude');
  });

  it('gives a video only the tags a video has', () => {
    const tags = preservedTagsFor('video').map((p) => p.tag);
    expect(tags).toContain('QuickTime:CreateDate');
    expect(tags).toContain('QuickTime:GPSCoordinates');
    expect(tags.some((t) => t.startsWith('EXIF:'))).toBe(false);
  });
});

describe('coordsFromTags', () => {
  it('reads a photo’s signed position back out of the EXIF pair and its refs', () => {
    expect(coordsFromTags('image', { 'EXIF:GPSLatitude': '8.5', 'EXIF:GPSLatitudeRef': 'S', 'EXIF:GPSLongitude': '34.2', 'EXIF:GPSLongitudeRef': 'W' })).toEqual({ lat: -8.5, lon: -34.2 });
  });

  it('reads a video’s out of ISO 6709', () => {
    expect(coordsFromTags('video', { 'QuickTime:GPSCoordinates': '+47.1234+11.3456/' })).toEqual({ lat: 47.1234, lon: 11.3456 });
  });

  it('is null when the tags are not there', () => {
    expect(coordsFromTags('image', { 'EXIF:GPSLatitude': null })).toBeNull();
  });
});

describe('legacyWrittenTags', () => {
  it('reconstructs the tags of the halves an older row says were written', () => {
    const tags = legacyWrittenTags(
      'image',
      { localIso: '2024-07-12T15:00:00', utcOffsetMinutes: 120, lat: 47.5, lon: 11.5 },
      { wroteTime: true, wroteGps: true },
    );
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 15:00:00');
    expect(tags['EXIF:OffsetTimeOriginal']).toBe('+02:00');
    expect(tags['EXIF:GPSLatitude']).toBe('47.5');
    expect(tags['XMP:GPSLongitude']).toBe('11.5');
  });

  it('leaves out a half that row never wrote, so its originals are still preserved later', () => {
    const tags = legacyWrittenTags(
      'image',
      { localIso: '2024-07-12T15:00:00', utcOffsetMinutes: 120, lat: 47.5, lon: 11.5 },
      { wroteTime: true, wroteGps: false },
    );
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 15:00:00');
    expect(tags['EXIF:GPSLatitude']).toBeUndefined();
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
