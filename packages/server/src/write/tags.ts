import type { FileRecord, MediaKind } from '@geotagger/shared';
import { formatUtcOffset, msToNaive } from '@geotagger/shared';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

/**
 * Turning an intended time into the tags ExifTool writes (SPEC §9.2, §9.3).
 *
 * Pure, because this is where a mistake is silent: a photo written with the wrong tag
 * looks fine until a year later when something else reads it.
 */

/** What a file said before GeoTagger touched it, kept for revert (SPEC §9.3, §9.4). */
export interface OriginalSnapshot {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
  gpsPresent: boolean;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
}

/** What GeoTagger last wrote, so a second persist knows whether anything changed. */
export interface AppliedState {
  localIso: string | null;
  utcOffsetMinutes: number | null;
  timeShiftSeconds: number;
  lat: number | null;
  lon: number | null;
  positionSource: PositionSourceTag | null;
  positionUncertaintyM: number | null;
}

export interface TimePayload {
  /** The corrected instant, epoch ms. */
  effectiveMs: number;
  utcOffsetMinutes: number;
  /** The correction relative to what the file says, in seconds. */
  timeShiftSeconds: number;
}

/** How a confirmed position was arrived at, written as `geotagger:PositionSource` (SPEC §9.2). */
export type PositionSourceTag = 'manual' | 'interpolated-confirmed';

export interface PositionPayload {
  lat: number;
  lon: number;
  source: PositionSourceTag;
  uncertaintyM: number | null;
}

/**
 * The wall clock that goes into the file.
 *
 * A photo's date tags are naive local time, so the instant is converted into the
 * file's own offset. A video's `QuickTime:CreateDate` is UTC by definition, so it gets
 * the instant itself — this is the conversion that puts both on one timeline in the
 * first place (SPEC §4.2), run backwards.
 */
export function localIsoForFile(kind: MediaKind, payload: TimePayload): string {
  return kind === 'video'
    ? msToNaive(payload.effectiveMs)
    : msToNaive(payload.effectiveMs + payload.utcOffsetMinutes * 60_000);
}

/**
 * UTC offset tags are EXIF, so only an image can carry them.
 *
 * A video needs none: its `CreateDate` is UTC already, which is unambiguous without
 * an offset — the ambiguity §4.2 is about only exists for a naive local reading.
 */
export function writesUtcOffsetTag(kind: MediaKind): boolean {
  return kind === 'image';
}

export interface BuiltWrite {
  tags: Record<string, string | number>;
  /** The wall clock written, for verification afterwards. */
  writtenLocalIso: string;
  wroteTime: boolean;
  wroteUtcOffset: boolean;
}

export interface ResolvedTimeWrite {
  /** The wall clock to write, naive ISO — already resolved by the persist plan. */
  localIso: string;
  utcOffsetMinutes: number;
  timeShiftSeconds: number;
}

/**
 * Builds the time half of an ExifTool write.
 *
 * The caller merges this with `buildPositionWrite`'s tags into one write per file
 * (SPEC §9.1), and adds the shared `ModifiedAt`/`AppVersion` stamp once — they belong
 * to neither half (SPEC §9.3).
 *
 * `stampOriginal` is passed only on this half's first-ever write: the value GeoTagger
 * preserves must be the one that predates it, never the one it put there last time.
 */
export function buildTimeWrite(
  file: Pick<FileRecord, 'kind'>,
  resolved: ResolvedTimeWrite,
  stampOriginal: Pick<OriginalSnapshot, 'dateTimeOriginal' | 'offsetTimeOriginal'> | null,
): BuiltWrite {
  const exifDate = toExifDate(resolved.localIso);
  const tags: Record<string, string | number> = {};

  if (file.kind === 'video') {
    // QuickTime stores UTC (SPEC §4.1, §9.2).
    tags['QuickTime:CreateDate'] = exifDate;
  } else {
    tags['EXIF:DateTimeOriginal'] = exifDate;
    tags['EXIF:CreateDate'] = exifDate;
  }

  const wroteUtcOffset = writesUtcOffsetTag(file.kind);
  if (wroteUtcOffset) {
    const offset = formatUtcOffset(resolved.utcOffsetMinutes);
    tags['EXIF:OffsetTimeOriginal'] = offset;
    tags['EXIF:OffsetTimeDigitized'] = offset;
  }

  if (stampOriginal) {
    // Written in ExifTool's own date format, because the point of this block is that
    // it can be read outside GeoTagger — by exiftool itself, or by a person.
    tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`] =
      stampOriginal.dateTimeOriginal === null ? '' : toExifDate(stampOriginal.dateTimeOriginal);
    tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`] = stampOriginal.offsetTimeOriginal ?? '';
  }
  tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`] = String(Math.round(resolved.timeShiftSeconds));

  return { tags, writtenLocalIso: resolved.localIso, wroteTime: true, wroteUtcOffset };
}

export interface BuiltPositionWrite {
  tags: Record<string, string | number>;
  writtenLat: number;
  writtenLon: number;
}

/**
 * Builds the position half of an ExifTool write (SPEC §9.2). `stampOriginal` is passed
 * only on this half's first-ever write, same rule as `buildTimeWrite`'s.
 *
 * `PositionSource`/`PositionUncertaintyMeters` are written on every position write,
 * not just the first — they describe the current edit's provenance, not the original.
 */
export function buildPositionWrite(
  file: Pick<FileRecord, 'kind'>,
  payload: PositionPayload,
  stampOriginal: Pick<OriginalSnapshot, 'gpsPresent' | 'gpsLatitude' | 'gpsLongitude'> | null,
): BuiltPositionWrite {
  const tags: Record<string, string | number> = {};

  if (file.kind === 'video') {
    tags['QuickTime:GPSCoordinates'] = iso6709(payload.lat, payload.lon);
  } else {
    tags['EXIF:GPSLatitude'] = Math.abs(payload.lat);
    tags['EXIF:GPSLatitudeRef'] = payload.lat >= 0 ? 'N' : 'S';
    tags['EXIF:GPSLongitude'] = Math.abs(payload.lon);
    tags['EXIF:GPSLongitudeRef'] = payload.lon >= 0 ? 'E' : 'W';
  }
  tags['XMP:GPSLatitude'] = payload.lat;
  tags['XMP:GPSLongitude'] = payload.lon;

  if (stampOriginal) {
    tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`] = stampOriginal.gpsPresent ? 'True' : 'False';
    if (stampOriginal.gpsLatitude !== null) {
      tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`] = String(stampOriginal.gpsLatitude);
    }
    if (stampOriginal.gpsLongitude !== null) {
      tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitude`] = String(stampOriginal.gpsLongitude);
    }
  }
  tags[`${GEOTAGGER_GROUP}:PositionSource`] = payload.source;
  if (payload.uncertaintyM !== null) {
    tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`] = String(Math.round(payload.uncertaintyM));
  }

  return { tags, writtenLat: payload.lat, writtenLon: payload.lon };
}

/** ISO 6709 for `QuickTime:GPSCoordinates` (SPEC §9.2), e.g. `+47.1234+011.3456/`. */
function iso6709(lat: number, lon: number): string {
  const sign = (v: number) => (v >= 0 ? '+' : '');
  return `${sign(lat)}${lat.toFixed(4)}${sign(lon)}${lon.toFixed(4)}/`;
}

/** The shared stamp neither half owns, present as long as either half is (SPEC §9.3). */
export function buildModifiedStamp(appVersion: string): Record<string, string> {
  return {
    [`${GEOTAGGER_GROUP}:ModifiedAt`]: toExifDate(msToNaive(Date.now())),
    [`${GEOTAGGER_GROUP}:AppVersion`]: appVersion,
  };
}

/**
 * Builds the write that restores a file's time to its original (SPEC §9.4, tier 3).
 *
 * A file that had no date before gets the tags removed rather than zeroed, so it ends
 * up as it started: an empty tag is not the same as an absent one to anything that
 * reads it later. Clears only the time half of the `geotagger` block — the caller
 * clears the whole thing (including the shared `ModifiedAt`/`AppVersion` stamp)
 * separately, only once the position half is gone too (SPEC §9.3).
 */
export function buildTimeRestore(
  file: Pick<FileRecord, 'kind'>,
  original: Pick<OriginalSnapshot, 'dateTimeOriginal' | 'offsetTimeOriginal'>,
): { tags: Record<string, string | null>; restoredLocalIso: string | null } {
  const tags: Record<string, string | null> = {};
  const value = original.dateTimeOriginal === null ? null : toExifDate(original.dateTimeOriginal);

  if (file.kind === 'video') {
    tags['QuickTime:CreateDate'] = value;
  } else {
    tags['EXIF:DateTimeOriginal'] = value;
    tags['EXIF:CreateDate'] = value;
    tags['EXIF:OffsetTimeOriginal'] = original.offsetTimeOriginal;
    tags['EXIF:OffsetTimeDigitized'] = original.offsetTimeOriginal;
  }

  tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`] = null;
  tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`] = null;
  tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`] = null;

  return { tags, restoredLocalIso: original.dateTimeOriginal };
}

/**
 * Builds the write that restores a file's position to its original (SPEC §9.4, tier
 * 3). A file that had no GPS before gets the tags removed. Clears only the position
 * half of the `geotagger` block, on the same terms as `buildTimeRestore`.
 */
export function buildPositionRestore(
  file: Pick<FileRecord, 'kind'>,
  original: Pick<OriginalSnapshot, 'gpsPresent' | 'gpsLatitude' | 'gpsLongitude'>,
): { tags: Record<string, string | number | null>; restoredLat: number | null; restoredLon: number | null } {
  const tags: Record<string, string | number | null> = {};
  const present = original.gpsPresent && original.gpsLatitude !== null && original.gpsLongitude !== null;

  if (present) {
    const lat = original.gpsLatitude as number;
    const lon = original.gpsLongitude as number;
    if (file.kind === 'video') {
      tags['QuickTime:GPSCoordinates'] = iso6709(lat, lon);
    } else {
      tags['EXIF:GPSLatitude'] = Math.abs(lat);
      tags['EXIF:GPSLatitudeRef'] = lat >= 0 ? 'N' : 'S';
      tags['EXIF:GPSLongitude'] = Math.abs(lon);
      tags['EXIF:GPSLongitudeRef'] = lon >= 0 ? 'E' : 'W';
    }
    tags['XMP:GPSLatitude'] = lat;
    tags['XMP:GPSLongitude'] = lon;
  } else {
    if (file.kind === 'video') {
      tags['QuickTime:GPSCoordinates'] = null;
    } else {
      tags['EXIF:GPSLatitude'] = null;
      tags['EXIF:GPSLatitudeRef'] = null;
      tags['EXIF:GPSLongitude'] = null;
      tags['EXIF:GPSLongitudeRef'] = null;
    }
    tags['XMP:GPSLatitude'] = null;
    tags['XMP:GPSLongitude'] = null;
  }

  tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`] = null;
  tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`] = null;
  tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitude`] = null;
  tags[`${GEOTAGGER_GROUP}:PositionSource`] = null;
  tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`] = null;

  return { tags, restoredLat: present ? (original.gpsLatitude as number) : null, restoredLon: present ? (original.gpsLongitude as number) : null };
}

/** Clears the shared stamp too, once neither half remains (SPEC §9.3). */
export function clearModifiedStamp(): Record<string, null> {
  return {
    [`${GEOTAGGER_GROUP}:ModifiedAt`]: null,
    [`${GEOTAGGER_GROUP}:AppVersion`]: null,
  };
}

/** `2024-07-12T14:32:10` to the `2024:07:12 14:32:10` ExifTool writes. */
export function toExifDate(localIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(localIso);
  if (!m) throw new Error(`Not a timestamp: ${localIso}`);
  return `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** The inverse, for checking what came back out of a file after it was written. */
export function fromExifDate(raw: string): string | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}
