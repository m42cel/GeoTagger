import type { PositionSource } from './positions.js';

/**
 * Writing to files (SPEC §9).
 *
 * A file with both a timestamp and a position change is written exactly once, both
 * payloads in a single ExifTool command (§9.1). Each half — time, position — resolves
 * independently: it is either left alone or written. The first write of a half also
 * stamps that half's `geotagger:Original*` tags, which are never touched again (§9.3).
 */

export type PersistHalfKind = 'none' | 'write';

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
   * True when this write is the time half's first ever — the only time the half's
   * `geotagger:Original*` tags get stamped (SPEC §9.3). Kept separate from
   * `timeKind === 'write'`: adding the UTC offset alone is a first write too, while a
   * second or later write touches the ordinary tags but leaves the preserved original
   * alone.
   */
  stampsOriginalTime: boolean;
  oldLat: number | null;
  oldLon: number | null;
  /** The position that will be written, or null when nothing changes there. */
  newLat: number | null;
  newLon: number | null;
  /** Always `manual` or `confirmed` when set — the only two provenances ever persisted. */
  positionSource: PositionSource | null;
  positionUncertaintyM: number | null;
  positionKind: PersistHalfKind;
  /** Same idea as `stampsOriginalTime`, for the position half's `Original*` tags. */
  stampsOriginalPosition: boolean;
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
