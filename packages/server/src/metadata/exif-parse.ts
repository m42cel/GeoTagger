import type { DateCandidate, DateCandidates } from './capture-time.js';

/** Raw ExifTool output for one file, read with `-G0` so the group is part of the key. */
export type RawTags = Record<string, unknown>;

function str(tags: RawTags, key: string): string | null {
  const v = tags[key];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
}

function num(tags: RawTags, key: string): number | null {
  const v = tags[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Parses an ExifTool date string into a naive wall clock plus an offset when the
 * value carries one.
 *
 * ExifTool emits `2024:07:12 14:32:10`, optionally with `.sss`, and optionally with
 * `Z` or `±HH:MM`. Zero-filled values — which cameras write for "unset" — parse
 * structurally here and are rejected later by the plausibility check.
 */
export function parseExifDate(raw: string | null): DateCandidate | null {
  if (!raw) return null;
  const m =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m as unknown as [
    string, string, string, string, string, string, string, string | undefined,
  ];
  return {
    localIso: `${y}-${mo}-${d}T${h}:${mi}:${s}`,
    utcOffsetMinutes: zone ? parseOffset(zone) : null,
  };
}

/** `Z`, `+02:00` or `-0500` to minutes east of UTC. */
export function parseOffset(zone: string): number | null {
  if (zone === 'Z' || zone === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone.trim());
  if (!m) return null;
  const [, sign, hh, mm] = m as unknown as [string, string, string, string];
  const minutes = Number(hh) * 60 + Number(mm);
  if (Number(mm) > 59) return null;
  return sign === '-' ? -minutes : minutes;
}

/**
 * Maps raw tags onto the candidate sources of SPEC §4.1.
 *
 * `CreateDate` is read from the EXIF group for images and the QuickTime group for
 * videos, which is what separates the naive local time a camera writes from the UTC
 * a container stores. Where a bare EXIF date has no zone but the file carries
 * `OffsetTimeOriginal`, that offset is attached — it is exactly the tag GeoTagger
 * itself writes on persist (SPEC §4.2).
 */
export function collectDateCandidates(tags: RawTags): DateCandidates {
  const out: DateCandidates = {};

  const explicitOffset =
    parseOffset(str(tags, 'EXIF:OffsetTimeOriginal') ?? '') ??
    parseOffset(str(tags, 'EXIF:OffsetTimeDigitized') ?? '') ??
    parseOffset(str(tags, 'EXIF:OffsetTime') ?? '');

  const withFallbackOffset = (c: DateCandidate | null): DateCandidate | null =>
    c && c.utcOffsetMinutes === null && explicitOffset !== null
      ? { ...c, utcOffsetMinutes: explicitOffset }
      : c;

  const dto = withFallbackOffset(
    parseExifDate(str(tags, 'EXIF:DateTimeOriginal') ?? str(tags, 'Composite:SubSecDateTimeOriginal')),
  );
  if (dto) out['exif:DateTimeOriginal'] = dto;

  const created = withFallbackOffset(
    parseExifDate(str(tags, 'EXIF:CreateDate') ?? str(tags, 'EXIF:DateTimeDigitized')),
  );
  if (created) out['exif:CreateDate'] = created;

  // QuickTime stores UTC, so a value without an explicit zone is UTC by definition.
  const qt = parseExifDate(str(tags, 'QuickTime:CreateDate'));
  if (qt) out['quicktime:CreateDate'] = { ...qt, utcOffsetMinutes: qt.utcOffsetMinutes ?? 0 };

  const xmp = withFallbackOffset(
    parseExifDate(str(tags, 'XMP:DateCreated') ?? str(tags, 'XMP:CreateDate')),
  );
  if (xmp) out['xmp:DateCreated'] = xmp;

  // Satellite time: UTC, and authoritative for the moment it was taken.
  const gps = parseExifDate(str(tags, 'Composite:GPSDateTime') ?? str(tags, 'EXIF:GPSDateTime'));
  if (gps) out['exif:GPSDateTime'] = { ...gps, utcOffsetMinutes: gps.utcOffsetMinutes ?? 0 };

  const modify = parseExifDate(str(tags, 'File:FileModifyDate'));
  if (modify) out['file:ModifyDate'] = modify;

  return out;
}

export interface RawGps {
  lat: number;
  lon: number;
}

/**
 * Reads the camera's own coordinates. `Composite:GPSLatitude` is a signed decimal
 * that already accounts for the N/S and E/W reference tags, which is why it is
 * preferred over the raw EXIF pair.
 *
 * A 0,0 fix is treated as absent: Null Island is what a camera writes when it has a
 * GPS field but no lock, and is never a real holiday photo.
 */
export function collectGps(tags: RawTags): RawGps | null {
  const lat = num(tags, 'Composite:GPSLatitude') ?? num(tags, 'EXIF:GPSLatitude');
  const lon = num(tags, 'Composite:GPSLongitude') ?? num(tags, 'EXIF:GPSLongitude');
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

export interface RawDimensions {
  /** Display width — swapped against the stored one when orientation is 5–8. */
  width: number | null;
  height: number | null;
  durationMs: number | null;
  orientation: number | null;
}

/**
 * EXIF orientation, 1–8, or null when absent or out of range.
 *
 * 1 is "already upright"; 2–4 are mirrors; 5–8 involve a quarter turn, so for those
 * the stored width and height are the other way round from how the image displays.
 */
export function collectOrientation(tags: RawTags): number | null {
  const raw = num(tags, 'EXIF:Orientation');
  if (raw !== null && Number.isInteger(raw) && raw >= 1 && raw <= 8) return raw;

  // ExifTool prints this tag as prose ("Rotate 90 CW") unless the value is requested
  // numerically. The read args ask for the number, but falling back on the words
  // costs nothing and the failure mode otherwise is silent: no rotation at all.
  const text = str(tags, 'EXIF:Orientation');
  return text === null ? null : (ORIENTATION_WORDS[text.toLowerCase()] ?? null);
}

const ORIENTATION_WORDS: Record<string, number> = {
  'horizontal (normal)': 1,
  'mirror horizontal': 2,
  'rotate 180': 3,
  'mirror vertical': 4,
  'mirror horizontal and rotate 270 cw': 5,
  'rotate 90 cw': 6,
  'mirror horizontal and rotate 90 cw': 7,
  'rotate 270 cw': 8,
};

/** True for the four orientations that involve a quarter turn. */
export function swapsAxes(orientation: number | null): boolean {
  return orientation !== null && orientation >= 5 && orientation <= 8;
}

export function collectDimensions(tags: RawTags): RawDimensions {
  const width =
    num(tags, 'File:ImageWidth') ??
    num(tags, 'EXIF:ExifImageWidth') ??
    num(tags, 'QuickTime:ImageWidth');
  const height =
    num(tags, 'File:ImageHeight') ??
    num(tags, 'EXIF:ExifImageHeight') ??
    num(tags, 'QuickTime:ImageHeight');
  const durationSeconds = parseDuration(tags['QuickTime:Duration'] ?? tags['Composite:Duration']);
  const orientation = collectOrientation(tags);

  // Report the dimensions as the image displays, not as it is stored: a portrait
  // photo from a phone is stored landscape with Orientation 6, and showing the
  // user "4032 x 3024" for an obviously portrait picture is simply wrong.
  const swap = swapsAxes(orientation);
  return {
    width: (swap ? height : width) ?? null,
    height: (swap ? width : height) ?? null,
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    orientation,
  };
}

/** ExifTool reports duration as seconds, or as `0:01:23` / `1.23 s`. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const hms = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (hms) {
    const [, h, m, s] = hms as unknown as [string, string, string, string];
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A stable identity for the camera that took a file, from `Make` / `Model` /
 * `SerialNumber` (SPEC §4.4 "By device"). Returns null when the file names no device
 * at all, which is common for screenshots and downloaded media.
 */
export function collectDevice(tags: RawTags): { id: string; make: string | null; model: string | null; serial: string | null; label: string } | null {
  const make = str(tags, 'EXIF:Make') ?? str(tags, 'QuickTime:Make') ?? str(tags, 'XMP:Make');
  const model = str(tags, 'EXIF:Model') ?? str(tags, 'QuickTime:Model') ?? str(tags, 'XMP:Model');
  const serial =
    str(tags, 'EXIF:SerialNumber') ??
    str(tags, 'EXIF:BodySerialNumber') ??
    str(tags, 'MakerNotes:SerialNumber');
  if (make === null && model === null && serial === null) return null;

  const id = [make ?? '', model ?? '', serial ?? ''].join('|').toLowerCase();
  return { id, make, model, serial, label: deviceLabel(make, model, serial) };
}

/** "Apple iPhone 14 Pro", dropping a make already repeated in the model. */
export function deviceLabel(make: string | null, model: string | null, serial: string | null): string {
  const parts: string[] = [];
  if (make && !(model?.toLowerCase().startsWith(make.toLowerCase()))) parts.push(make);
  if (model) parts.push(model);
  if (parts.length === 0) return serial ? `Unknown camera (${serial})` : 'Unknown camera';
  return parts.join(' ');
}
