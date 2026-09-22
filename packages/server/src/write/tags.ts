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
}

export interface TimePayload {
  /** The corrected instant, epoch ms. */
  effectiveMs: number;
  utcOffsetMinutes: number;
  /** The correction relative to what the file says, in seconds. */
  timeShiftSeconds: number;
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

/**
 * Builds one ExifTool write.
 *
 * Everything for a file goes in a single call — the timestamp, the offset, and the
 * preservation block — because SPEC §9.1 requires one write per file, and because
 * each extra pass over a file on a NAS costs more than the write itself.
 *
 * `original` is written only on the first write: the values GeoTagger preserves must
 * be the ones that predate it, never the ones it put there last time.
 */
export function buildTimeWrite(
  file: Pick<FileRecord, 'kind'>,
  payload: TimePayload,
  original: OriginalSnapshot | null,
  appVersion: string,
): BuiltWrite {
  const localIso = localIsoForFile(file.kind, payload);
  const exifDate = toExifDate(localIso);
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
    const offset = formatUtcOffset(payload.utcOffsetMinutes);
    tags['EXIF:OffsetTimeOriginal'] = offset;
    tags['EXIF:OffsetTimeDigitized'] = offset;
  }

  if (original) {
    // Written in ExifTool's own date format, because the point of this block is that
    // it can be read outside GeoTagger — by exiftool itself, or by a person.
    tags[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`] =
      original.dateTimeOriginal === null ? '' : toExifDate(original.dateTimeOriginal);
    tags[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`] = original.offsetTimeOriginal ?? '';
    tags[`${GEOTAGGER_GROUP}:OriginalGPSPresent`] = original.gpsPresent ? 'True' : 'False';
    if (original.gpsLatitude !== null) {
      tags[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`] = String(original.gpsLatitude);
    }
    if (original.gpsLongitude !== null) {
      tags[`${GEOTAGGER_GROUP}:OriginalGPSLongitude`] = String(original.gpsLongitude);
    }
  }
  tags[`${GEOTAGGER_GROUP}:TimeShiftSeconds`] = String(Math.round(payload.timeShiftSeconds));
  tags[`${GEOTAGGER_GROUP}:ModifiedAt`] = toExifDate(msToNaive(Date.now()));
  tags[`${GEOTAGGER_GROUP}:AppVersion`] = appVersion;

  return { tags, writtenLocalIso: localIso, wroteTime: true, wroteUtcOffset };
}

/**
 * Builds the write that undoes GeoTagger's time changes (SPEC §9.4).
 *
 * A file that had no date before gets the tags removed rather than zeroed, so it ends
 * up as it started: an empty tag is not the same as an absent one to anything that
 * reads it later.
 */
export function buildTimeRevert(
  file: Pick<FileRecord, 'kind'>,
  original: OriginalSnapshot,
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

  // The whole preservation block goes, so a reverted file carries no trace of having
  // been edited — which is what makes revert honest.
  tags[`${GEOTAGGER_GROUP}:all`] = null;

  return { tags, restoredLocalIso: original.dateTimeOriginal };
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
