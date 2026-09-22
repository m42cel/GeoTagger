import type { CaptureTimeSource, FileRecord, UtcOffsetRule, UtcOffsetSource } from '@geotagger/shared';
import { MINUTE_MS, naiveToMs } from '@geotagger/shared';
import { offsetForNaiveReading, zoneForCoordinates, zoneOffsetMinutes } from './zones.js';

/**
 * UTC offset inheritance (SPEC §4.2).
 *
 * Photos store a naive local time and videos store UTC, so nothing can be compared
 * until every file has an offset. It comes from the files that actually know —
 * typically a phone, carrying both real coordinates and a trustworthy clock — whose
 * position gives a timezone and therefore an offset over each period of the trip.
 * Everything else in that period inherits it.
 *
 * It is deliberately *not* derived from a file's own interpolated position: that
 * would be circular for exactly the files that need it most.
 */

/** A rule before it has been stored and given an id. */
export type DraftUtcOffsetRule = Omit<UtcOffsetRule, 'id'>;

/**
 * Sources that state a capture time the camera itself recorded. A time recovered
 * from a filename or an mtime says nothing about the device's clock, so such a file
 * is not allowed to establish the offset for others even if it carries coordinates.
 */
const TRUSTWORTHY_SOURCES: readonly CaptureTimeSource[] = [
  'exif:DateTimeOriginal',
  'exif:CreateDate',
  'quicktime:CreateDate',
  'xmp:DateCreated',
  'exif:GPSDateTime',
];

export function hasTrustworthyClock(file: Pick<FileRecord, 'captureTimeSource'>): boolean {
  return TRUSTWORTHY_SOURCES.includes(file.captureTimeSource);
}

/** The subset of a file this module reads; `FileRecord` satisfies it. */
export type OffsetSourceFile = Pick<
  FileRecord,
  'captureTimeRaw' | 'captureTimeSource' | 'captureUtcOffsetMinutes' | 'origGpsPresent' | 'origLat' | 'origLon'
>;

interface Anchor {
  instantMs: number;
  offsetMinutes: number;
  zone: string;
}

/**
 * Derives the periods of the trip and the offset that held over each.
 *
 * Files are grouped into runs of equal offset in instant order, so a flight across a
 * timezone border produces two rules with the crossing between them, and a trip that
 * stayed put produces exactly one.
 */
export function buildUtcOffsetRules(files: readonly OffsetSourceFile[]): DraftUtcOffsetRule[] {
  const anchors: Anchor[] = [];
  for (const file of files) {
    const anchor = anchorFor(file);
    if (anchor) anchors.push(anchor);
  }
  anchors.sort((a, b) => a.instantMs - b.instantMs);

  const rules: DraftUtcOffsetRule[] = [];
  for (const a of anchors) {
    const last = rules[rules.length - 1];
    if (last && last.offsetMinutes === a.offsetMinutes && last.zone === a.zone) {
      last.toUtc = a.instantMs;
      continue;
    }
    rules.push({ fromUtc: a.instantMs, toUtc: a.instantMs, offsetMinutes: a.offsetMinutes, source: 'gps', zone: a.zone });
  }
  return rules;
}

function anchorFor(file: OffsetSourceFile): Anchor | null {
  if (!file.origGpsPresent || file.origLat === null || file.origLon === null) return null;
  if (!hasTrustworthyClock(file)) return null;
  const naiveMs = naiveToMs(file.captureTimeRaw);
  if (naiveMs === null) return null;

  const zone = zoneForCoordinates(file.origLat, file.origLon);
  if (zone === null) return null;

  // A file that already states its own offset gives the instant outright; one that
  // does not has to be resolved against the zone from its coordinates.
  if (file.captureUtcOffsetMinutes !== null) {
    const instantMs = naiveMs - file.captureUtcOffsetMinutes * MINUTE_MS;
    const offsetMinutes = zoneOffsetMinutes(zone, instantMs);
    return offsetMinutes === null ? null : { instantMs, offsetMinutes, zone };
  }

  const offsetMinutes = offsetForNaiveReading(zone, naiveMs);
  if (offsetMinutes === null) return null;
  return { instantMs: naiveMs - offsetMinutes * MINUTE_MS, offsetMinutes, zone };
}

export interface OffsetOverrides {
  /** Typed in for this one file. */
  file: number | null;
  /** Typed in for the strip it belongs to. */
  strip: number | null;
  /** The one-off answer given when the folder holds no GPS-bearing file at all. */
  folder: number | null;
}

export interface ResolvedUtcOffset {
  minutes: number;
  source: UtcOffsetSource;
}

/**
 * The offset that applies to one file, in the precedence of SPEC §4.2: anything typed
 * in wins, then what the file states about itself, then what the trip's GPS-bearing
 * files established for that period.
 *
 * `correctedNaiveMs` is the file's wall-clock reading with its strip's clock
 * correction already applied — the correction is what makes a wrongly-set camera land
 * in the right period of the trip in the first place.
 */
export function resolveUtcOffset(
  file: Pick<FileRecord, 'captureUtcOffsetMinutes'>,
  correctedNaiveMs: number | null,
  rules: readonly UtcOffsetRule[],
  overrides: OffsetOverrides,
): ResolvedUtcOffset {
  if (overrides.file !== null) return { minutes: overrides.file, source: 'file-override' };
  if (overrides.strip !== null) return { minutes: overrides.strip, source: 'strip' };
  if (file.captureUtcOffsetMinutes !== null) {
    return { minutes: file.captureUtcOffsetMinutes, source: 'file' };
  }
  const inherited = correctedNaiveMs === null ? null : ruleForNaiveReading(rules, correctedNaiveMs);
  if (inherited !== null) return { minutes: inherited.offsetMinutes, source: 'inherited' };
  if (overrides.folder !== null) return { minutes: overrides.folder, source: 'folder' };
  return { minutes: 0, source: 'assumed' };
}

/**
 * Finds the rule covering a local wall-clock reading.
 *
 * The rules are stored as absolute windows, so each is compared in its own local time
 * — `fromUtc + offset` — which is the only way to place a reading that has no offset
 * yet. Outside every window the nearest rule wins: a trip's periods do not tile the
 * timeline, and a photo taken in the gap between two GPS fixes still needs an answer.
 */
export function ruleForNaiveReading(
  rules: readonly UtcOffsetRule[],
  naiveMs: number,
): UtcOffsetRule | null {
  let nearest: UtcOffsetRule | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const rule of rules) {
    const shift = rule.offsetMinutes * MINUTE_MS;
    const from = rule.fromUtc + shift;
    const to = rule.toUtc + shift;
    if (naiveMs >= from && naiveMs <= to) return rule;
    const distance = naiveMs < from ? from - naiveMs : naiveMs - to;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = rule;
    }
  }
  return nearest;
}

/**
 * The offset the axis labels are drawn in: the one most of the folder is in.
 *
 * A trip that crossed a border still reads most naturally in the zone it mostly
 * happened in, and a single display offset keeps the axis monotonic, which one that
 * jumped at the border would not be.
 */
export function dominantOffsetMinutes(offsets: readonly number[], fallback = 0): number {
  if (offsets.length === 0) return fallback;
  const counts = new Map<number, number>();
  for (const o of offsets) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best = fallback;
  let bestCount = -1;
  for (const [offset, count] of counts) {
    if (count > bestCount || (count === bestCount && offset < best)) {
      best = offset;
      bestCount = count;
    }
  }
  return best;
}
