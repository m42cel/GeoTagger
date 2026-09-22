import { describe, expect, it } from 'vitest';
import {
  collectDateCandidates,
  collectOrientation,
  swapsAxes,
  collectDevice,
  collectDimensions,
  collectGps,
  deviceLabel,
  parseDuration,
  parseExifDate,
  parseOffset,
} from './exif-parse.js';

describe('parseExifDate', () => {
  it('parses the colon-separated form ExifTool emits', () => {
    expect(parseExifDate('2024:07:12 14:32:10')).toEqual({
      localIso: '2024-07-12T14:32:10',
      utcOffsetMinutes: null,
    });
  });

  it('parses subseconds and zone suffixes', () => {
    expect(parseExifDate('2024:07:12 14:32:10.123')).toMatchObject({ localIso: '2024-07-12T14:32:10' });
    expect(parseExifDate('2024:07:12 14:32:10Z')).toMatchObject({ utcOffsetMinutes: 0 });
    expect(parseExifDate('2024:07:12 14:32:10+02:00')).toMatchObject({ utcOffsetMinutes: 120 });
    expect(parseExifDate('2024:07:12 14:32:10-0500')).toMatchObject({ utcOffsetMinutes: -300 });
  });

  it('parses a zero date structurally, leaving plausibility to reject it', () => {
    expect(parseExifDate('0000:00:00 00:00:00')).toEqual({
      localIso: '0000-00-00T00:00:00',
      utcOffsetMinutes: null,
    });
  });

  it('returns null for absent or malformed values', () => {
    expect(parseExifDate(null)).toBeNull();
    expect(parseExifDate('')).toBeNull();
    expect(parseExifDate('not a date')).toBeNull();
    expect(parseExifDate('2024:07:12')).toBeNull();
  });
});

describe('parseOffset', () => {
  it('reads Z and both signed forms', () => {
    expect(parseOffset('Z')).toBe(0);
    expect(parseOffset('+02:00')).toBe(120);
    expect(parseOffset('-05:30')).toBe(-330);
    expect(parseOffset('+0545')).toBe(345);
  });
  it('rejects nonsense', () => {
    expect(parseOffset('')).toBeNull();
    expect(parseOffset('+02:99')).toBeNull();
    expect(parseOffset('east')).toBeNull();
  });
});

describe('collectDateCandidates — SPEC §4.1 sources', () => {
  it('separates EXIF from QuickTime CreateDate by group', () => {
    const c = collectDateCandidates({
      'EXIF:CreateDate': '2024:07:12 14:32:10',
      'QuickTime:CreateDate': '2024:07:12 12:32:10',
    });
    expect(c['exif:CreateDate']).toMatchObject({ localIso: '2024-07-12T14:32:10' });
    expect(c['quicktime:CreateDate']).toMatchObject({ localIso: '2024-07-12T12:32:10' });
  });

  it('treats a zoneless QuickTime date as UTC, because that is what the container stores', () => {
    const c = collectDateCandidates({ 'QuickTime:CreateDate': '2024:07:12 12:32:10' });
    expect(c['quicktime:CreateDate']?.utcOffsetMinutes).toBe(0);
  });

  it('treats GPSDateTime as UTC', () => {
    const c = collectDateCandidates({ 'Composite:GPSDateTime': '2024:07:12 12:32:09' });
    expect(c['exif:GPSDateTime']?.utcOffsetMinutes).toBe(0);
  });

  it('attaches OffsetTimeOriginal to an otherwise zoneless EXIF date', () => {
    const c = collectDateCandidates({
      'EXIF:DateTimeOriginal': '2024:07:12 14:32:10',
      'EXIF:OffsetTimeOriginal': '+02:00',
    });
    expect(c['exif:DateTimeOriginal']).toEqual({
      localIso: '2024-07-12T14:32:10',
      utcOffsetMinutes: 120,
    });
  });

  it('does not let an offset tag override a zone the date already carries', () => {
    const c = collectDateCandidates({
      'EXIF:DateTimeOriginal': '2024:07:12 14:32:10+01:00',
      'EXIF:OffsetTimeOriginal': '+02:00',
    });
    expect(c['exif:DateTimeOriginal']?.utcOffsetMinutes).toBe(60);
  });

  it('does not attach a photo offset to the QuickTime UTC value', () => {
    const c = collectDateCandidates({
      'QuickTime:CreateDate': '2024:07:12 12:32:10',
      'EXIF:OffsetTimeOriginal': '+02:00',
    });
    expect(c['quicktime:CreateDate']?.utcOffsetMinutes).toBe(0);
  });

  it('yields nothing for a file with no dates at all', () => {
    expect(collectDateCandidates({})).toEqual({});
  });
});

describe('collectGps', () => {
  it('prefers the signed composite over the raw EXIF pair', () => {
    expect(collectGps({ 'Composite:GPSLatitude': -41.9, 'Composite:GPSLongitude': 12.5 })).toEqual({
      lat: -41.9,
      lon: 12.5,
    });
  });

  it('treats a 0,0 fix as absent, since that is what a camera writes without a lock', () => {
    expect(collectGps({ 'Composite:GPSLatitude': 0, 'Composite:GPSLongitude': 0 })).toBeNull();
  });

  it('rejects out-of-range and incomplete coordinates', () => {
    expect(collectGps({ 'Composite:GPSLatitude': 91, 'Composite:GPSLongitude': 12 })).toBeNull();
    expect(collectGps({ 'Composite:GPSLatitude': 41.9 })).toBeNull();
    expect(collectGps({})).toBeNull();
  });

  it('keeps a real coordinate on either side of zero', () => {
    expect(collectGps({ 'Composite:GPSLatitude': 0, 'Composite:GPSLongitude': 12.5 })).toEqual({
      lat: 0,
      lon: 12.5,
    });
  });
});

describe('collectDimensions', () => {
  it('reads image dimensions', () => {
    expect(collectDimensions({ 'File:ImageWidth': 4032, 'File:ImageHeight': 3024 })).toEqual({
      width: 4032,
      height: 3024,
      durationMs: null,
      orientation: null,
    });
  });

  it('reports how the image displays, not how it is stored', () => {
    // A portrait phone photo: stored landscape, displayed portrait.
    expect(
      collectDimensions({ 'File:ImageWidth': 4032, 'File:ImageHeight': 3024, 'EXIF:Orientation': 6 }),
    ).toEqual({ width: 3024, height: 4032, durationMs: null, orientation: 6 });
  });

  it('leaves the axes alone for the mirror-only orientations', () => {
    expect(
      collectDimensions({ 'File:ImageWidth': 4032, 'File:ImageHeight': 3024, 'EXIF:Orientation': 2 }),
    ).toEqual({ width: 4032, height: 3024, durationMs: null, orientation: 2 });
  });

  it('reads video dimensions and duration', () => {
    expect(
      collectDimensions({
        'QuickTime:ImageWidth': 1920,
        'QuickTime:ImageHeight': 1080,
        'QuickTime:Duration': '6.00 s',
      }),
    ).toEqual({ width: 1920, height: 1080, durationMs: 6000, orientation: null });
  });

  it('returns nulls rather than guesses when nothing is there', () => {
    expect(collectDimensions({})).toEqual({
      width: null,
      height: null,
      durationMs: null,
      orientation: null,
    });
  });
});

describe('collectOrientation', () => {
  it('reads the numeric form the scanner asks ExifTool for', () => {
    expect(collectOrientation({ 'EXIF:Orientation': 6 })).toBe(6);
    expect(collectOrientation({ 'EXIF:Orientation': '8' })).toBe(8);
  });

  it('falls back to the prose form, so a missing "#" does not silently untilt photos', () => {
    expect(collectOrientation({ 'EXIF:Orientation': 'Rotate 90 CW' })).toBe(6);
    expect(collectOrientation({ 'EXIF:Orientation': 'Horizontal (normal)' })).toBe(1);
    expect(collectOrientation({ 'EXIF:Orientation': 'Mirror horizontal and rotate 270 CW' })).toBe(5);
  });

  it('returns null for an absent or out-of-range value', () => {
    expect(collectOrientation({})).toBeNull();
    expect(collectOrientation({ 'EXIF:Orientation': 0 })).toBeNull();
    expect(collectOrientation({ 'EXIF:Orientation': 9 })).toBeNull();
    expect(collectOrientation({ 'EXIF:Orientation': 'sideways-ish' })).toBeNull();
  });
});

describe('swapsAxes', () => {
  it('is true exactly for the four quarter-turn orientations', () => {
    expect([1, 2, 3, 4].map(swapsAxes)).toEqual([false, false, false, false]);
    expect([5, 6, 7, 8].map(swapsAxes)).toEqual([true, true, true, true]);
    expect(swapsAxes(null)).toBe(false);
  });
});

describe('parseDuration', () => {
  it('accepts seconds, "N s" and H:MM:SS', () => {
    expect(parseDuration(6)).toBe(6);
    expect(parseDuration('6.00 s')).toBe(6);
    expect(parseDuration('0:01:23')).toBe(83);
    expect(parseDuration('1:00:00.5')).toBe(3600.5);
  });
  it('rejects nonsense', () => {
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('unknown')).toBeNull();
  });
});

describe('collectDevice — SPEC §4.4 "By device"', () => {
  it('builds a stable id from make, model and serial', () => {
    const d = collectDevice({ 'EXIF:Make': 'SONY', 'EXIF:Model': 'ILCE-7M4', 'EXIF:SerialNumber': '00123456' });
    expect(d?.id).toBe('sony|ilce-7m4|00123456');
    expect(d?.label).toBe('SONY ILCE-7M4');
  });

  it('separates two bodies of the same model by serial', () => {
    const a = collectDevice({ 'EXIF:Make': 'SONY', 'EXIF:Model': 'ILCE-7M4', 'EXIF:SerialNumber': '1' });
    const b = collectDevice({ 'EXIF:Make': 'SONY', 'EXIF:Model': 'ILCE-7M4', 'EXIF:SerialNumber': '2' });
    expect(a?.id).not.toBe(b?.id);
  });

  it('returns null when the file names no device, so those files group together', () => {
    expect(collectDevice({})).toBeNull();
    expect(collectDevice({ 'EXIF:DateTimeOriginal': '2024:07:12 14:32:10' })).toBeNull();
  });

  it('falls back to the QuickTime group for videos', () => {
    expect(collectDevice({ 'QuickTime:Make': 'Apple', 'QuickTime:Model': 'iPhone 14' })?.label).toBe(
      'Apple iPhone 14',
    );
  });
});

describe('deviceLabel', () => {
  it('does not repeat a make the model already starts with', () => {
    expect(deviceLabel('Canon', 'Canon EOS R6', null)).toBe('Canon EOS R6');
    expect(deviceLabel('Apple', 'iPhone 14 Pro', null)).toBe('Apple iPhone 14 Pro');
  });
  it('names a serial-only device rather than leaving it blank', () => {
    expect(deviceLabel(null, null, 'X1')).toBe('Unknown camera (X1)');
  });
});
