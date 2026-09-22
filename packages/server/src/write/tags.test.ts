import { describe, it, expect } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import {
  buildTimeRevert,
  buildTimeWrite,
  fromExifDate,
  localIsoForFile,
  toExifDate,
  writesUtcOffsetTag,
  type OriginalSnapshot,
  type TimePayload,
} from './tags.js';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

const at = (iso: string) => naiveToMs(iso) as number;

const payload: TimePayload = {
  effectiveMs: at('2024-07-12T12:32:10'),
  utcOffsetMinutes: 120,
  timeShiftSeconds: 3732,
};

const original: OriginalSnapshot = {
  dateTimeOriginal: '2024-07-12T13:30:00',
  offsetTimeOriginal: null,
  gpsPresent: false,
  gpsLatitude: null,
  gpsLongitude: null,
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
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'image' }, payload, null, '0.1.0');
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:CreateDate']).toBe('2024:07:12 14:32:10');
    expect(tags['EXIF:OffsetTimeOriginal']).toBe('+02:00');
    expect(tags['EXIF:OffsetTimeDigitized']).toBe('+02:00');
    expect(wroteUtcOffset).toBe(true);
  });

  it('writes QuickTime UTC for a video, and no EXIF offset tags', () => {
    const { tags, wroteUtcOffset } = buildTimeWrite({ kind: 'video' }, payload, null, '0.1.0');
    expect(tags['QuickTime:CreateDate']).toBe('2024:07:12 12:32:10');
    expect(tags['EXIF:DateTimeOriginal']).toBeUndefined();
    expect(tags['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(wroteUtcOffset).toBe(false);
    expect(writesUtcOffsetTag('video')).toBe(false);
  });

  it('preserves the original values in the geotagger namespace on the first write', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, payload, original, '0.1.0');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBe('2024:07:12 13:30:00');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`]).toBe('False');
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
    expect(tags[`${GEOTAGGER_GROUP}:AppVersion`]).toBe('0.1.0');
  });

  it('leaves the preserved originals alone on a second write', () => {
    const { tags } = buildTimeWrite({ kind: 'image' }, payload, null, '0.1.0');
    expect(tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
    // The shift and the stamp still update: they describe the write, not the original.
    expect(tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe('3732');
  });
});

describe('buildTimeRevert', () => {
  it('puts back what the file said, and clears the geotagger block', () => {
    const { tags, restoredLocalIso } = buildTimeRevert({ kind: 'image' }, original);
    expect(tags['EXIF:DateTimeOriginal']).toBe('2024:07:12 13:30:00');
    expect(tags['EXIF:OffsetTimeOriginal']).toBeNull();
    expect(tags[`${GEOTAGGER_GROUP}:all`]).toBeNull();
    expect(restoredLocalIso).toBe('2024-07-12T13:30:00');
  });

  it('removes the tags entirely from a file that never had a date', () => {
    const { tags } = buildTimeRevert({ kind: 'image' }, { ...original, dateTimeOriginal: null });
    expect(tags['EXIF:DateTimeOriginal']).toBeNull();
    expect(tags['EXIF:CreateDate']).toBeNull();
  });

  it('reverts a video’s QuickTime date and nothing EXIF', () => {
    const { tags } = buildTimeRevert({ kind: 'video' }, original);
    expect(tags['QuickTime:CreateDate']).toBe('2024:07:12 13:30:00');
    expect(tags['EXIF:DateTimeOriginal']).toBeUndefined();
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
