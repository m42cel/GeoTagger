import type { FileRecord, MediaKind, PersistField, PersistTagChange } from '@geotagger/shared';
import { formatUtcOffset, msToNaive } from '@geotagger/shared';
import { GEOTAGGER_GROUP } from './exiftool-config.js';

/**
 * The tags ExifTool writes, one value at a time (SPEC §9.2, §9.3).
 *
 * Every tag GeoTagger writes is its own unit: it has an intended value, a value the file
 * holds now, and a `geotagger:Original*` that records what was there before the first
 * time GeoTagger touched *that tag*. The persist plan is the difference between the first
 * two, tag by tag; nothing groups them beyond the field labels the review list shows.
 *
 * Pure, because this is where a mistake is silent: a photo written with the wrong tag
 * looks fine until a year later when something else reads it.
 */

/**
 * The value a tag holds, keyed by the tag name exactly as it is written. `null` means
 * the file does not have that tag at all.
 */
export type OriginalTagValues = Record<string, string | null>;

/** What a file said before GeoTagger touched it, kept as its pre-GeoTagger record (SPEC §9.3). */
export interface OriginalSnapshot {
  /** The capture time as the app read it, for the human-readable record. */
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  /**
   * Every tag either field writes, as the file held it — the literal values, one per
   * `Original*` stamped into the file. Separate from the four above, which are what the
   * *app* derived (a capture time can come from a tag GeoTagger never writes, SPEC §4.1).
   */
  tags: OriginalTagValues;
}

/** The value written for a tag the file did not have, so absence is recorded as such. */
export const ORIGINAL_ABSENT = 'n/a';

/** A tag GeoTagger writes, with the `geotagger` tag preserving it and its display field. */
export interface PreservedTag {
  /** Group-prefixed, exactly as handed to ExifTool. */
  tag: string;
  /** The bare name inside the `geotagger` namespace (SPEC §9.3). */
  original: string;
  /** Which of the review list's three rows this tag belongs under (SPEC §9.1). */
  field: PersistField;
}

/**
 * Every tag GeoTagger writes for a file of this kind, each with the `Original*` that
 * preserves it.
 *
 * A video's `CreateDate` and a photo's share one `OriginalCreateDate`: a file is one kind
 * or the other, so the two can never collide in the same file. A video has no offset tags
 * at all — `QuickTime:CreateDate` is UTC by definition (SPEC §4.2).
 */
export function preservedTagsFor(kind: MediaKind): PreservedTag[] {
  return kind === 'video'
    ? [
        { tag: 'QuickTime:CreateDate', original: 'OriginalCreateDate', field: 'timestamp' },
        { tag: 'QuickTime:GPSCoordinates', original: 'OriginalGPSCoordinates', field: 'position' },
        { tag: 'XMP:GPSLatitude', original: 'OriginalXMPGPSLatitude', field: 'position' },
        { tag: 'XMP:GPSLongitude', original: 'OriginalXMPGPSLongitude', field: 'position' },
      ]
    : [
        { tag: 'EXIF:DateTimeOriginal', original: 'OriginalDateTimeOriginal', field: 'timestamp' },
        { tag: 'EXIF:CreateDate', original: 'OriginalCreateDate', field: 'timestamp' },
        { tag: 'EXIF:OffsetTimeOriginal', original: 'OriginalOffsetTimeOriginal', field: 'utcOffset' },
        { tag: 'EXIF:OffsetTimeDigitized', original: 'OriginalOffsetTimeDigitized', field: 'utcOffset' },
        { tag: 'EXIF:GPSLatitude', original: 'OriginalGPSLatitude', field: 'position' },
        { tag: 'EXIF:GPSLatitudeRef', original: 'OriginalGPSLatitudeRef', field: 'position' },
        { tag: 'EXIF:GPSLongitude', original: 'OriginalGPSLongitude', field: 'position' },
        { tag: 'EXIF:GPSLongitudeRef', original: 'OriginalGPSLongitudeRef', field: 'position' },
        { tag: 'XMP:GPSLatitude', original: 'OriginalXMPGPSLatitude', field: 'position' },
        { tag: 'XMP:GPSLongitude', original: 'OriginalXMPGPSLongitude', field: 'position' },
      ];
}

/** The instant and offset a file should end up saying, as the plan resolved them. */
export interface TimeIntent {
  /** The corrected instant, epoch ms. */
  effectiveMs: number;
  /** The offset the app placed the file at — always known, since the instant needs it. */
  utcOffsetMinutes: number;
  /**
   * Whether that offset may be *written*. A video has no offset tags at all, and an
   * offset nothing established is a guess §4.2 will not stamp into a file — but either
   * way it is still what converts the instant back into a wall clock.
   */
  writeOffset: boolean;
}

/** The position a file should end up saying — only ever a confirmed one (SPEC §5.5). */
export interface PositionIntent {
  lat: number;
  lon: number;
}

/**
 * The value every tag should hold, for the fields the plan has an opinion about.
 *
 * A field left out (no confirmed position, a video's offset) yields no entries at all,
 * which is what keeps those tags out of the diff — GeoTagger never removes a tag, so
 * "no opinion" and "should be absent" never have to be told apart.
 */
export function desiredTagValues(
  kind: MediaKind,
  time: TimeIntent | null,
  position: PositionIntent | null,
): Record<string, string> {
  const out: Record<string, string> = {};

  if (time !== null) {
    const localIso = localIsoForFile(kind, time);
    const exifDate = toExifDate(localIso);
    if (kind === 'video') {
      // QuickTime stores UTC (SPEC §4.1, §9.2).
      out['QuickTime:CreateDate'] = exifDate;
    } else {
      out['EXIF:DateTimeOriginal'] = exifDate;
      out['EXIF:CreateDate'] = exifDate;
      if (time.writeOffset) {
        const offset = formatUtcOffset(time.utcOffsetMinutes);
        out['EXIF:OffsetTimeOriginal'] = offset;
        out['EXIF:OffsetTimeDigitized'] = offset;
      }
    }
  }

  if (position !== null) {
    if (kind === 'video') {
      out['QuickTime:GPSCoordinates'] = iso6709(position.lat, position.lon);
    } else {
      out['EXIF:GPSLatitude'] = formatCoord(Math.abs(position.lat));
      out['EXIF:GPSLatitudeRef'] = position.lat >= 0 ? 'N' : 'S';
      out['EXIF:GPSLongitude'] = formatCoord(Math.abs(position.lon));
      out['EXIF:GPSLongitudeRef'] = position.lon >= 0 ? 'E' : 'W';
    }
    out['XMP:GPSLatitude'] = formatCoord(position.lat);
    out['XMP:GPSLongitude'] = formatCoord(position.lon);
  }

  return out;
}

/**
 * The wall clock that goes into a file.
 *
 * A photo's date tags are naive local time, so the instant is converted into the file's
 * own offset. A video's `QuickTime:CreateDate` is UTC by definition, so it gets the
 * instant itself — this is the conversion that puts both on one timeline in the first
 * place (SPEC §4.2), run backwards. An offset the plan withholds still has to be *used*
 * here, or the wall clock written would be a different instant than the one intended.
 */
export function localIsoForFile(kind: MediaKind, time: Pick<TimeIntent, 'effectiveMs' | 'utcOffsetMinutes'>): string {
  return kind === 'video'
    ? msToNaive(time.effectiveMs)
    : msToNaive(time.effectiveMs + time.utcOffsetMinutes * 60_000);
}

/**
 * UTC offset tags are EXIF, so only an image can carry them.
 *
 * A video needs none: its `CreateDate` is UTC already, which is unambiguous without an
 * offset — the ambiguity §4.2 is about only exists for a naive local reading.
 */
export function writesUtcOffsetTag(kind: MediaKind): boolean {
  return kind === 'image';
}

/** How a confirmed position was arrived at, written as `geotagger:PositionSource` (SPEC §9.2). */
export type PositionSourceTag = 'manual' | 'interpolated-confirmed';

export interface Provenance {
  /** The correction relative to what the file said, in seconds. */
  timeShiftSeconds: number;
  positionSource: PositionSourceTag | null;
  positionUncertaintyM: number | null;
  appVersion: string;
}

/**
 * The whole ExifTool write for one file (SPEC §9.1): every changed tag, the
 * `geotagger:Original*` for each tag being written for the first time, the provenance of
 * the fields touched, and the shared `ModifiedAt`/`AppVersion` stamp.
 *
 * `original` is the file's own pre-GeoTagger values, read a moment earlier; a tag whose
 * `Original*` is already in the file is not in `changes` with `stampsOriginal` set, so
 * the preserved value can never be overwritten by one GeoTagger itself wrote (SPEC §9.3).
 */
export function buildWrite(
  file: Pick<FileRecord, 'kind'>,
  changes: readonly PersistTagChange[],
  original: OriginalTagValues,
  provenance: Provenance,
): Record<string, string> {
  const tags: Record<string, string> = {};
  const byTag = new Map(preservedTagsFor(file.kind).map((p) => [p.tag, p]));
  const fields = new Set<PersistField>();

  for (const change of changes) {
    tags[change.tag] = change.next;
    const preserved = byTag.get(change.tag);
    if (preserved === undefined) continue;
    fields.add(preserved.field);
    if (change.stampsOriginal) {
      tags[`${GEOTAGGER_GROUP}:${preserved.original}`] = original[change.tag] ?? ORIGINAL_ABSENT;
    }
  }

  // Provenance describes this edit, not the original, so it is rewritten every time the
  // field it belongs to is touched — and left alone on a field this write did not change.
  if (fields.has('timestamp') || fields.has('utcOffset')) {
    tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`] = String(Math.round(provenance.timeShiftSeconds));
  }
  if (fields.has('position') && provenance.positionSource !== null) {
    tags[`${GEOTAGGER_GROUP}:PositionSource`] = provenance.positionSource;
    if (provenance.positionUncertaintyM !== null) {
      tags[`${GEOTAGGER_GROUP}:PositionUncertaintyMeters`] = String(Math.round(provenance.positionUncertaintyM));
    }
  }

  tags[`${GEOTAGGER_GROUP}:ModifiedAt`] = toExifDate(msToNaive(Date.now()));
  tags[`${GEOTAGGER_GROUP}:AppVersion`] = provenance.appVersion;

  return tags;
}

/**
 * The per-tag record for a file persisted before GeoTagger kept one (SPEC §9.3).
 *
 * Such a row holds only the logical values of the last write plus which of the two halves
 * it covered, so the tags of those halves are reconstructed from them. Getting this right
 * matters more than it looks: a tag missing from the record reads as one GeoTagger has
 * never written, and its `Original*` would be stamped a second time — overwriting the
 * file's preserved original with a value GeoTagger itself wrote.
 */
export function legacyWrittenTags(
  kind: MediaKind,
  applied: { localIso: string | null; utcOffsetMinutes: number | null; lat: number | null; lon: number | null },
  halves: { wroteTime: boolean; wroteGps: boolean },
): OriginalTagValues {
  const time =
    halves.wroteTime && applied.localIso !== null
      ? { effectiveMs: instantOfNaive(kind, applied.localIso, applied.utcOffsetMinutes ?? 0), utcOffsetMinutes: applied.utcOffsetMinutes ?? 0, writeOffset: applied.utcOffsetMinutes !== null }
      : null;
  const position = halves.wroteGps && applied.lat !== null && applied.lon !== null ? { lat: applied.lat, lon: applied.lon } : null;
  return desiredTagValues(kind, time, position);
}

/**
 * A naive wall clock back to the instant `desiredTagValues` starts from — the inverse of
 * `localIsoForFile`, for the two places that have a reading rather than an instant: a
 * legacy record of what was written, and the scan's own reading of a file.
 */
export function instantOfNaive(kind: MediaKind, localIso: string, utcOffsetMinutes: number): number {
  const ms = Date.parse(`${localIso}Z`);
  return kind === 'video' ? ms : ms - utcOffsetMinutes * 60_000;
}

/** ISO 6709 for `QuickTime:GPSCoordinates` (SPEC §9.2), e.g. `+47.1234+011.3456/`. */
function iso6709(lat: number, lon: number): string {
  const sign = (v: number) => (v >= 0 ? '+' : '');
  return `${sign(lat)}${lat.toFixed(4)}${sign(lon)}${lon.toFixed(4)}/`;
}

/**
 * A coordinate as the characters written into the tag.
 *
 * Fixed at seven decimals — about a centimetre — so that the same position always
 * produces the same string. The plan compares strings, and a value that formatted
 * differently on two runs would look like a change that needs writing on every Persist.
 */
export function formatCoord(value: number): string {
  return String(Number(value.toFixed(7)));
}

/** The signed coordinates a file's tags say, for the review list's human-readable rows. */
export function coordsFromTags(
  kind: MediaKind,
  values: OriginalTagValues,
): { lat: number; lon: number } | null {
  if (kind === 'video') {
    const raw = values['QuickTime:GPSCoordinates'];
    const m = raw == null ? null : /^([+-]?\d+(?:\.\d+)?)\s*([+-]\d+(?:\.\d+)?)/.exec(raw.trim());
    if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
    const lat = values['XMP:GPSLatitude'];
    const lon = values['XMP:GPSLongitude'];
    return lat == null || lon == null ? null : { lat: Number(lat), lon: Number(lon) };
  }
  const lat = values['EXIF:GPSLatitude'];
  const lon = values['EXIF:GPSLongitude'];
  if (lat == null || lon == null) return null;
  const south = values['EXIF:GPSLatitudeRef'] === 'S';
  const west = values['EXIF:GPSLongitudeRef'] === 'W';
  return { lat: Math.abs(Number(lat)) * (south ? -1 : 1), lon: Math.abs(Number(lon)) * (west ? -1 : 1) };
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
