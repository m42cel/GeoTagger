/**
 * Writing to files (SPEC §9).
 *
 * Phase 1 carries only the time payload — position editing does not exist yet — but
 * the shape is the general one, because §9.1 requires a file with both a timestamp and
 * a position change to be written exactly once, with both payloads in a single
 * ExifTool command.
 */

export interface PersistPlanEntry {
  fileId: number;
  relPath: string;
  /** The corrected wall clock that will be written, naive ISO. */
  newLocalIso: string | null;
  /** The correction in seconds, relative to what the file says now. */
  timeShiftSeconds: number;
  /** The UTC offset that will be written as `OffsetTimeOriginal`. */
  utcOffsetMinutes: number | null;
  writesTime: boolean;
  writesUtcOffset: boolean;
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
