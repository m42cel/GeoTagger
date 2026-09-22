import type { CaptureTime, CaptureTimeSource } from '@geotagger/shared';

/**
 * One date candidate, reduced to the only two things that matter: the wall-clock
 * reading and whether the zone is known.
 *
 * `localIso` is naive — "2024-07-12T14:32:10", no zone suffix — because that is all a
 * photo carries. `utcOffsetMinutes` is non-null only when the source genuinely knows
 * the zone (QuickTime and GPS times are UTC; EXIF offset tags state it outright).
 * Everything else leaves it null for the inheritance pass of SPEC §4.2 to fill in.
 */
export interface DateCandidate {
  localIso: string;
  utcOffsetMinutes: number | null;
}

/** Candidates keyed by the source they came from, as read off a file. */
export type DateCandidates = Partial<Record<Exclude<CaptureTimeSource, 'filename' | 'none'>, DateCandidate>>;

/**
 * Resolves a file's capture time by SPEC §4.1: the first source that yields a valid
 * value wins, and the winning source is recorded so the UI can show it.
 *
 * The filename pass sits at position 6 — ahead of `FileModifyDate` — because copying
 * files through cloud services or network shares frequently destroys mtime while the
 * filename survives.
 */
export function resolveCaptureTime(candidates: DateCandidates, filename: string): CaptureTime {
  const ordered: Exclude<CaptureTimeSource, 'filename' | 'none'>[] = [
    'exif:DateTimeOriginal',
    'exif:CreateDate',
    'quicktime:CreateDate',
    'xmp:DateCreated',
    'exif:GPSDateTime',
  ];

  for (const source of ordered) {
    const c = candidates[source];
    if (c && isPlausible(c.localIso)) {
      return { localIso: c.localIso, utcOffsetMinutes: c.utcOffsetMinutes, source };
    }
  }

  const fromName = parseTimestampFromFilename(filename);
  if (fromName) {
    return { localIso: fromName, utcOffsetMinutes: null, source: 'filename' };
  }

  const mtime = candidates['file:ModifyDate'];
  if (mtime && isPlausible(mtime.localIso)) {
    return {
      localIso: mtime.localIso,
      utcOffsetMinutes: mtime.utcOffsetMinutes,
      source: 'file:ModifyDate',
    };
  }

  return { localIso: '', utcOffsetMinutes: null, source: 'none' };
}

const EARLIEST_PLAUSIBLE_YEAR = 1970;

/**
 * Rejects the values cameras and libraries emit for "unset": the epoch, 1904 (the
 * QuickTime epoch), all-zero EXIF dates, and anything in the future.
 */
export function isPlausible(localIso: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(localIso);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < EARLIEST_PLAUSIBLE_YEAR) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return false;
  // A year beyond next year means a clock reset forward or a parse gone wrong.
  if (year > now.getUTCFullYear() + 1) return false;
  return true;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Patterns cameras and phones put in filenames (SPEC §4.1 item 6).
 *
 * Each must capture year, month, day, hour, minute, second in that order. Anything
 * that yields an implausible date is discarded rather than trusted, so a file called
 * `DSC_00012024.JPG` cannot masquerade as a timestamp.
 */
const FILENAME_PATTERNS: RegExp[] = [
  // IMG_20240712_143210, VID_20240712_143210, PXL_20240712_143210.MP,
  // Screenshot_20240712-143210, 20240712_143210, 20240712T143210
  /(?<![0-9])(\d{4})(\d{2})(\d{2})[ _\-T]?(\d{2})(\d{2})(\d{2})(?![0-9])/,
  // 2024-07-12 14.32.10, 2024-07-12_14-32-10, 2024_07_12T14:32:10
  /(?<![0-9])(\d{4})[-_.](\d{2})[-_.](\d{2})[ _T]+(\d{2})[-_.:](\d{2})[-_.:](\d{2})(?![0-9])/,
];

/**
 * Extracts a capture time from a filename, or null when none of the patterns match
 * or the match is not a plausible date.
 */
export function parseTimestampFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, '');
  for (const pattern of FILENAME_PATTERNS) {
    const m = pattern.exec(stem);
    if (!m) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    if (isPlausible(iso)) return iso;
  }
  return null;
}

/** Naive local ISO string to epoch ms, read as if UTC. Ordering and differences only. */
export function naiveToMs(localIso: string): number | null {
  if (!localIso) return null;
  const ms = Date.parse(`${localIso}Z`);
  return Number.isFinite(ms) ? ms : null;
}
