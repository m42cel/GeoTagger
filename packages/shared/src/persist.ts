import type { PositionSource } from './positions.js';

/**
 * Writing to files (SPEC §9).
 *
 * A file with both a timestamp and a position change is written exactly once, both
 * payloads in a single ExifTool command (§9.1). Each half — time, position — resolves
 * independently to `write` (an ordinary correction) or `restore` (the plan-time
 * comparison of §9.4 found the intended value now equals the stored original, so this
 * half writes the original back and clears only its own half of the `geotagger` block).
 */

export type PersistHalfKind = 'none' | 'write' | 'restore';

export interface PersistPlanEntry {
  fileId: number;
  relPath: string;
  /** What the file currently says, for the persist dialog's old→new rows (SPEC §9.1). */
  oldLocalIso: string | null;
  oldUtcOffsetMinutes: number | null;
  /** The corrected wall clock that will be written, naive ISO. */
  newLocalIso: string | null;
  /** The correction in seconds, relative to what the file says now. */
  timeShiftSeconds: number;
  /** The UTC offset that will be written as `OffsetTimeOriginal`. */
  utcOffsetMinutes: number | null;
  timeKind: PersistHalfKind;
  writesUtcOffset: boolean;
  /**
   * True when this write is the time half's first ever — the only time
   * `geotagger:OriginalDateTimeOriginal`/`OriginalOffsetTimeOriginal` get stamped
   * (SPEC §9.3). Kept separate from `timeKind === 'write'`: a second or later write
   * touches the ordinary tags but leaves the preserved original alone.
   */
  stampsOriginalTime: boolean;
  /** What the stored original says, for the raw-EXIF view of the `geotagger` block — null when nothing has been persisted before. */
  originalDateTimeOriginal: string | null;
  originalOffsetTimeOriginal: string | null;
  oldLat: number | null;
  oldLon: number | null;
  /** The position that will be written, or null when nothing changes there. */
  newLat: number | null;
  newLon: number | null;
  /** Always `manual` or `confirmed` when set — the only two provenances ever persisted. */
  positionSource: PositionSource | null;
  positionUncertaintyM: number | null;
  positionKind: PersistHalfKind;
  /** Same idea as `stampsOriginalTime`, for the position half's `OriginalGPS*` tags. */
  stampsOriginalPosition: boolean;
  originalGpsPresent: boolean | null;
  originalGpsLatitude: number | null;
  originalGpsLongitude: number | null;
  /** True when the file changed on disk since it was scanned (SPEC §8.3). */
  stale: boolean;
}

export interface PersistPlan {
  entries: PersistPlanEntry[];
  correctedTimestamps: number;
  utcOffsetsAdded: number;
  staleCount: number;
}

/** What to do about a file that changed on disk between the edit and the write. */
export type StalePolicy = 'skip' | 'overwrite';

export interface PersistRequest {
  /** File ids to write; omitted means every entry in the plan. */
  fileIds?: number[];
  stalePolicy?: StalePolicy;
}

export interface PersistFileResult {
  fileId: number;
  relPath: string;
  ok: boolean;
  skipped: boolean;
  /** Set when the file was skipped or failed. */
  reason: string | null;
}

export interface PersistProgress {
  phase: 'writing' | 'done' | 'failed';
  total: number;
  completed: number;
  currentPath: string | null;
  written: number;
  skipped: number;
  failed: number;
  results: PersistFileResult[];
  error: string | null;
}

/** A file whose GeoTagger changes can be undone, with what it originally said. */
export interface PersistedSnapshot {
  fileId: number;
  relPath: string;
  persistedAt: number;
  wroteTime: boolean;
  wroteGps: boolean;
  originalDateTimeOriginal: string | null;
  originalOffsetTimeOriginal: string | null;
  originalGpsPresent: boolean;
  originalGpsLatitude: number | null;
  originalGpsLongitude: number | null;
}

export interface OplogEntry {
  id: number;
  ts: number;
  fileId: number | null;
  action: string;
  beforeJson: string | null;
  afterJson: string | null;
  ok: boolean;
  error: string | null;
}
