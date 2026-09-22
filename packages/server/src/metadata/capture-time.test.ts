import { describe, expect, it } from 'vitest';
import {
  isPlausible,
  parseTimestampFromFilename,
  resolveCaptureTime,
  type DateCandidates,
} from './capture-time.js';

const naive = (localIso: string) => ({ localIso, utcOffsetMinutes: null });
const utc = (localIso: string) => ({ localIso, utcOffsetMinutes: 0 });

describe('resolveCaptureTime — SPEC §4.1 precedence', () => {
  it('prefers DateTimeOriginal over every later source', () => {
    const c: DateCandidates = {
      'exif:DateTimeOriginal': naive('2024-07-12T14:32:10'),
      'exif:CreateDate': naive('2024-07-12T14:32:11'),
      'quicktime:CreateDate': utc('2024-07-12T12:32:10'),
      'exif:GPSDateTime': utc('2024-07-12T12:32:09'),
      'file:ModifyDate': naive('2025-01-01T00:00:00'),
    };
    expect(resolveCaptureTime(c, 'IMG_4471.JPG')).toEqual({
      localIso: '2024-07-12T14:32:10',
      utcOffsetMinutes: null,
      source: 'exif:DateTimeOriginal',
    });
  });

  it('falls through each step of the order in turn', () => {
    const steps: [DateCandidates, string][] = [
      [{ 'exif:CreateDate': naive('2024-07-12T14:32:10') }, 'exif:CreateDate'],
      [{ 'quicktime:CreateDate': utc('2024-07-12T12:32:10') }, 'quicktime:CreateDate'],
      [{ 'xmp:DateCreated': naive('2024-07-12T14:32:10') }, 'xmp:DateCreated'],
      [{ 'exif:GPSDateTime': utc('2024-07-12T12:32:10') }, 'exif:GPSDateTime'],
    ];
    for (const [candidates, expected] of steps) {
      expect(resolveCaptureTime(candidates, 'x.jpg').source).toBe(expected);
    }
  });

  it('keeps the UTC offset for zone-aware sources and leaves it null for naive ones', () => {
    expect(resolveCaptureTime({ 'quicktime:CreateDate': utc('2024-07-12T12:32:10') }, 'v.mp4'))
      .toMatchObject({ utcOffsetMinutes: 0 });
    expect(resolveCaptureTime({ 'exif:DateTimeOriginal': naive('2024-07-12T14:32:10') }, 'p.jpg'))
      .toMatchObject({ utcOffsetMinutes: null });
    expect(
      resolveCaptureTime(
        { 'exif:DateTimeOriginal': { localIso: '2024-07-12T14:32:10', utcOffsetMinutes: 120 } },
        'p.jpg',
      ),
    ).toMatchObject({ utcOffsetMinutes: 120 });
  });

  it('uses the filename ahead of mtime, because copying destroys mtime but not the name', () => {
    const c: DateCandidates = { 'file:ModifyDate': naive('2025-03-01T09:00:00') };
    expect(resolveCaptureTime(c, 'IMG_20240712_143210.jpg')).toEqual({
      localIso: '2024-07-12T14:32:10',
      utcOffsetMinutes: null,
      source: 'filename',
    });
  });

  it('falls back to mtime last', () => {
    const c: DateCandidates = { 'file:ModifyDate': naive('2025-03-01T09:00:00') };
    expect(resolveCaptureTime(c, 'DSC_0001.JPG').source).toBe('file:ModifyDate');
  });

  it('reports "none" when nothing yields a value', () => {
    expect(resolveCaptureTime({}, 'DSC_0001.JPG')).toEqual({
      localIso: '',
      utcOffsetMinutes: null,
      source: 'none',
    });
  });

  it('skips malformed and implausible values rather than trusting them', () => {
    const c: DateCandidates = {
      'exif:DateTimeOriginal': naive('0000-00-00T00:00:00'),
      'exif:CreateDate': naive('1904-01-01T00:00:00'),
      'xmp:DateCreated': naive('2024-07-12T14:32:10'),
    };
    expect(resolveCaptureTime(c, 'x.jpg').source).toBe('xmp:DateCreated');
  });
});

describe('parseTimestampFromFilename — SPEC §4.1 item 6', () => {
  const cases: [string, string | null][] = [
    ['IMG_20240712_143210.JPG', '2024-07-12T14:32:10'],
    ['VID_20240712_143210.mp4', '2024-07-12T14:32:10'],
    ['PXL_20240712_143210.MP.jpg', '2024-07-12T14:32:10'],
    ['20240712_143210.jpg', '2024-07-12T14:32:10'],
    ['20240712T143210.jpg', '2024-07-12T14:32:10'],
    ['Screenshot_20240712-143210.png', '2024-07-12T14:32:10'],
    ['2024-07-12 14.32.10.jpg', '2024-07-12T14:32:10'],
    ['2024-07-12_14-32-10.mov', '2024-07-12T14:32:10'],
    ['photo 2024-07-12 at 14.32.10.heic', null],
    ['DSC_0001.JPG', null],
    ['IMG_4471.JPG', null],
    // A long digit run must not be sliced into a date.
    ['DSC_202407121432109.JPG', null],
    // Plausibility rejects a match that is not a real date.
    ['IMG_20241340_143210.JPG', null],
    ['IMG_20240712_256010.JPG', null],
  ];

  for (const [name, expected] of cases) {
    it(`${name} -> ${expected ?? 'no match'}`, () => {
      expect(parseTimestampFromFilename(name)).toBe(expected);
    });
  }
});

describe('isPlausible', () => {
  const now = new Date('2026-09-22T00:00:00Z');
  it('accepts an ordinary date', () => {
    expect(isPlausible('2024-07-12T14:32:10', now)).toBe(true);
  });
  it('accepts a leap day and rejects a non-leap 29 February', () => {
    expect(isPlausible('2024-02-29T10:00:00', now)).toBe(true);
    expect(isPlausible('2023-02-29T10:00:00', now)).toBe(false);
  });
  it('accepts a leap second', () => {
    expect(isPlausible('2016-12-31T23:59:60', now)).toBe(true);
  });
  it('rejects dates before 1970 and more than a year ahead', () => {
    expect(isPlausible('1904-01-01T00:00:00', now)).toBe(false);
    expect(isPlausible('2099-01-01T00:00:00', now)).toBe(false);
  });
  it('rejects malformed input', () => {
    expect(isPlausible('', now)).toBe(false);
    expect(isPlausible('2024-07-12', now)).toBe(false);
    expect(isPlausible('not a date', now)).toBe(false);
  });
});
