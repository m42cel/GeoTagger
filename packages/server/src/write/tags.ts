import type { FileRecord, MediaKind } from '@geotagger/shared';
import { formatUtcOffset, msToNaive } from '@geotagger/shared';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

/**
 * Turning an intended time into the tags ExifTool writes (SPEC §9.2, §9.3).
 *
 * Pure, because this is where a mistake is silent: a photo written with the wrong tag
 * looks fine until a year later when something else reads it.
 */

/**
 * The value a tag held before GeoTagger wrote it, keyed by the tag name exactly as it
 * is written. `null` means the file did not have that tag at all.
 */
export type OriginalTagValues = Record<string, string | null>;

/** What a file said before GeoTagger touched it, kept for revert (SPEC §9.3, §9.4). */
export interface OriginalSnapshot {
  /** The capture time as the app read it, for the plan's own comparisons and the dialog. */
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  /**
   * Every tag either half writes, as the file held it. Separate from the four above,
   * which are what the *app* derived (the capture time can come from a tag GeoTagger
   * never writes, SPEC §4.1); these are the literal tags, one per `Original*` stamped
   * into the file.
   */
  tags: OriginalTagValues;
}

/** The value written for a tag the file did not have, so absence is recorded as such. */
export const ORIGINAL_ABSENT = 'n/a';

/** A tag GeoTagger writes, paired with the `geotagger` tag its prior value is kept in. */
export interface PreservedTag {
  /** Group-prefixed, exactly as handed to ExifTool. */
  tag: string;
  /** The bare name inside the `geotagger` namespace (SPEC §9.3). */
  original: string;
}

/**
 * The time half's tags (SPEC §9.2), each with the `Original*` that preserves it.
 *
 * A video's `CreateDate` and a photo's share one `OriginalCreateDate`: a file is one
 * kind or the other, so the two can never collide in the same file.
 */
export function timeTagsFor(kind: MediaKind): PreservedTag[] {
  return kind === 'video'
    ? [{ tag: 'QuickTime:CreateDate', original: 'OriginalCreateDate' }]
    : [
        { tag: 'EXIF:DateTimeOriginal', original: 'OriginalDateTimeOriginal' },
        { tag: 'EXIF:CreateDate', original: 'OriginalCreateDate' },
        { tag: 'EXIF:OffsetTimeOriginal', original: 'OriginalOffsetTimeOriginal' },
        { tag: 'EXIF:OffsetTimeDigitized', original: 'OriginalOffsetTimeDigitized' },
      ];
}

/** The position half's tags (SPEC §9.2), each with the `Original*` that preserves it. */
export function positionTagsFor(kind: MediaKind): PreservedTag[] {
  const xmp: PreservedTag[] = [
    { tag: 'XMP:GPSLatitude', original: 'OriginalXMPGPSLatitude' },
    { tag: 'XMP:GPSLongitude', original: 'OriginalXMPGPSLongitude' },
  ];
  return kind === 'video'
    ? [{ tag: 'QuickTime:GPSCoordinates', original: 'OriginalGPSCoordinates' }, ...xmp]
    : [
        { tag: 'EXIF:GPSLatitude', original: 'OriginalGPSLatitude' },
        { tag: 'EXIF:GPSLatitudeRef', original: 'OriginalGPSLatitudeRef' },
        { tag: 'EXIF:GPSLongitude', original: 'OriginalGPSLongitude' },
        { tag: 'EXIF:GPSLongitudeRef', original: 'OriginalGPSLongitudeRef' },
        ...xmp,
      ];
}

/** Both halves at once, for the one read that captures a file's originals. */
export function preservedTagsFor(kind: MediaKind): PreservedTag[] {
  return [...timeTagsFor(kind), ...positionTagsFor(kind)];
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
  /**
   * Whether the offset may be written at all — the plan's decision, not this module's.
   * An offset nothing established is a guess, and §4.2 has the app ask for it rather
   * than stamp UTC onto a photo as though it were known; a date correction to such a
   * file must leave its local time as ambiguous as it found it.
   */
  writesUtcOffset: boolean;
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
  stampOriginal: OriginalTagValues | null,
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

  const wroteUtcOffset = resolved.writesUtcOffset && writesUtcOffsetTag(file.kind);
  if (wroteUtcOffset) {
    const offset = formatUtcOffset(resolved.utcOffsetMinutes);
    tags['EXIF:OffsetTimeOriginal'] = offset;
    tags['EXIF:OffsetTimeDigitized'] = offset;
  }

  if (stampOriginal) Object.assign(tags, stampsFor(timeTagsFor(file.kind), stampOriginal));
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
  stampOriginal: OriginalTagValues | null,
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

  if (stampOriginal) Object.assign(tags, stampsFor(positionTagsFor(file.kind), stampOriginal));
  tags[`${GEOTAGGER_GROUP}:PositionSource`] = payload.source;
  if (payload.uncertaintyM !== null) {
    tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`] = String(Math.round(payload.uncertaintyM));
  }

  return { tags, writtenLat: payload.lat, writtenLon: payload.lon };
}

/**
 * One `geotagger:Original*` per tag the half writes, holding what the file had there.
 *
 * A tag the file did not have is preserved as the literal `n/a` rather than left out:
 * the two must be distinguishable later, since one means "remove this tag again" and
 * the other means "GeoTagger has never written this half".
 */
function stampsFor(preserved: PreservedTag[], original: OriginalTagValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { tag, original: name } of preserved) {
    out[`${GEOTAGGER_GROUP}:${name}`] = original[tag] ?? ORIGINAL_ABSENT;
  }
  return out;
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
