/** Media kinds the application handles. RAW is out of scope (SPEC §2). */
export type MediaKind = 'image' | 'video';

/** Extensions in scope, lowercase, without the dot (SPEC §2 "Supported formats"). */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'heic', 'heif', 'png'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'] as const;
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
];

export function kindForExtension(ext: string): MediaKind | null {
  const e = ext.toLowerCase().replace(/^\./, '');
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(e)) return 'image';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(e)) return 'video';
  return null;
}

/**
 * Where a file's capture time came from, in the resolution order of SPEC §4.1.
 * The winning source is stored and displayed per file.
 */
export type CaptureTimeSource =
  | 'exif:DateTimeOriginal'
  | 'exif:CreateDate'
  | 'quicktime:CreateDate'
  | 'xmp:DateCreated'
  | 'exif:GPSDateTime'
  | 'filename'
  | 'file:ModifyDate'
  | 'none';

/** Ordered by precedence; index 0 wins over index 1. */
export const CAPTURE_TIME_SOURCE_ORDER: readonly CaptureTimeSource[] = [
  'exif:DateTimeOriginal',
  'exif:CreateDate',
  'quicktime:CreateDate',
  'xmp:DateCreated',
  'exif:GPSDateTime',
  'filename',
  'file:ModifyDate',
];

/**
 * A resolved capture time.
 *
 * `localIso` is the naive wall-clock reading with no zone ("2024-07-12T14:32:10"),
 * which is all a photo carries. `utcOffsetMinutes` is set only when the source was
 * zone-aware (QuickTime UTC, GPSDateTime, or an explicit EXIF offset tag); otherwise
 * it is null and the offset is resolved later by inheritance (SPEC §4.2).
 */
export interface CaptureTime {
  localIso: string;
  utcOffsetMinutes: number | null;
  source: CaptureTimeSource;
}

export interface DeviceRecord {
  id: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  label: string;
}

export interface FileRecord {
  id: number;
  relPath: string;
  filename: string;
  ext: string;
  kind: MediaKind;
  sizeBytes: number;
  /** File mtime, epoch milliseconds. */
  mtime: number;
  deviceId: string | null;
  /** Display width, after orientation is applied (see `orientation`). */
  width: number | null;
  /** Display height, after orientation is applied. */
  height: number | null;
  durationMs: number | null;
  /**
   * EXIF orientation, 1–8, or null when the file states none.
   *
   * Kept because an embedded preview extracted from the file usually carries no
   * orientation of its own, so rendering a thumbnail from it needs the parent's
   * value to come out the right way up.
   */
  orientation: number | null;
  captureTimeRaw: string | null;
  captureTimeSource: CaptureTimeSource;
  captureUtcOffsetMinutes: number | null;
  /**
   * Satellite UTC from the file's GPS fix, naive ISO, when it carried one.
   *
   * Kept alongside the resolved capture time rather than folded into it: the gap
   * between what the satellite said and what the camera's own clock said is that
   * camera's error at that moment, and only the two side by side show it.
   */
  gpsTimeUtc: string | null;
  origGpsPresent: boolean;
  origLat: number | null;
  origLon: number | null;
  firstSeenAt: number;
  lastScannedAt: number;
  missing: boolean;
  thumbState: ThumbState;
}

export type ThumbState = 'pending' | 'ready' | 'failed';
