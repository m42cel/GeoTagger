/** How the initial strips are formed (SPEC §4.4). */
export type GroupingMode = 'device' | 'subfolder' | 'manual';

/**
 * A contiguous set of files sharing one clock correction (SPEC §3).
 *
 * Strips live in lanes. Within a lane they must stay ordered and must not overlap in
 * effective time, which is what makes a lane readable as one device's day; two strips
 * that do overlap are separated by promoting one of them to a lane of its own (§4.3).
 */
export interface StripRecord {
  id: number;
  lane: number;
  ordinal: number;
  label: string;
  groupingSource: GroupingMode;
  /**
   * The strip this one was cut from, or null for an uncut strip.
   *
   * It is the *origin* rather than the immediate parent: cutting a segment again
   * keeps pointing at the original, so `originId` below identifies every segment that
   * came from the same strip, which is what merging is allowed between.
   */
  parentStripId: number | null;
  /** Clock correction in seconds, applied to every file in the strip alike. */
  offsetSeconds: number;
  locked: boolean;
  /** A UTC offset typed in for this strip, overriding what §4.2 would infer. */
  utcOffsetOverrideMinutes: number | null;
  createdAt: number;
  fileCount: number;
  /** Bounds over the strip's uncorrected capture times, epoch ms; null when it holds no dated file. */
  firstCaptureMs: number | null;
  lastCaptureMs: number | null;
  /** Bounds on the absolute timeline, with corrections and UTC offsets applied. */
  firstEffectiveMs: number | null;
  lastEffectiveMs: number | null;
}

/** Every segment cut from the same original strip shares this id. */
export function originId(strip: Pick<StripRecord, 'id' | 'parentStripId'>): number {
  return strip.parentStripId ?? strip.id;
}

/** Where a file's resolved UTC offset came from (SPEC §4.2). */
export type UtcOffsetSource =
  | 'file'        // the file states it: QuickTime UTC, GPSDateTime, or an EXIF offset tag
  | 'inherited'   // from a GPS-bearing file's timezone over the same period
  | 'strip'       // typed in for the whole strip
  | 'file-override'
  | 'folder'      // the one-off answer given when no GPS-bearing file exists at all
  | 'assumed';    // nothing known; UTC

/** A period of the trip over which one UTC offset holds, derived from GPS-bearing files. */
export interface UtcOffsetRule {
  id: number;
  /** Bounds of the period as absolute instants, epoch ms. */
  fromUtc: number;
  toUtc: number;
  offsetMinutes: number;
  source: 'gps' | 'manual';
  /** The IANA zone the coordinates fell in, when a lookup produced it. */
  zone: string | null;
}

/** One file as the alignment view needs it: raw reading, resolution, and result. */
export interface TimelineFile {
  id: number;
  stripId: number | null;
  /** The file's own wall-clock reading as epoch ms, read as if UTC. Null when undated. */
  rawCaptureMs: number | null;
  utcOffsetMinutes: number;
  utcOffsetSource: UtcOffsetSource;
  /** The clock correction its strip applies to it, in seconds. */
  offsetSeconds: number;
  /** Where it lands on the absolute timeline. Null when undated. */
  effectiveMs: number | null;
}
