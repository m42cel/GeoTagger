import type { PositionSource } from './positions.js';
import type { FileId } from './media.js';

/**
 * Writing to files (SPEC §9).
 *
 * A file is written exactly once per Persist run, every changed tag in a single ExifTool
 * command (§9.1). The plan is a **per-tag diff**: for each tag GeoTagger writes, what the
 * file says now against what it should say. A tag that differs is written, and a tag
 * written for the first time also has its prior value preserved as
 * `geotagger:Original<tag>` (§9.3) — which is why the diff is per tag and not per field:
 * the preserved original belongs to one tag, not to a group of them.
 */

/** The review list's three rows (SPEC §9.1) — a display grouping over the tags. */
export type PersistField = 'timestamp' | 'utcOffset' | 'position';

/** One tag this write changes, which is also the unit the plan diffs. */
export interface PersistTagChange {
  /** Group-prefixed, exactly as ExifTool is given it, e.g. `EXIF:DateTimeOriginal`. */
  tag: string;
  field: PersistField;
  /** What the file says now — null when it does not have the tag. */
  old: string | null;
  /** What will be written. */
  next: string;
  /**
   * True when this is the first time GeoTagger writes this tag, so the write also stamps
   * `geotagger:Original<tag>` (§9.3). Stamped once and never touched again, which is what
   * keeps the preserved value the one that predates GeoTagger.
   */
  stampsOriginal: boolean;
}

/**
 * The same change as the review list shows it without the raw-EXIF toggle: one row per
 * field, in the app's own units rather than the tags' (SPEC §9.1).
 */
export type PersistFieldChange =
  | { field: 'timestamp'; oldLocalIso: string | null; newLocalIso: string }
  | { field: 'utcOffset'; oldMinutes: number | null; newMinutes: number }
  | { field: 'position'; oldLat: number | null; oldLon: number | null; newLat: number; newLon: number };

export interface PersistPlanEntry {
  fileId: FileId;
  relPath: string;
  /** Every tag that will be written, for the raw-EXIF view. Never empty. */
  changes: PersistTagChange[];
  /** The same thing per field, for the human-readable view. */
  fields: PersistFieldChange[];
  /** The correction relative to what the file said, in seconds — written as provenance. */
  timeShiftSeconds: number;
  /** Always `manual` or `confirmed` when set — the only two provenances ever persisted. */
  positionSource: PositionSource | null;
  positionUncertaintyM: number | null;
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
  fileIds?: FileId[];
  stalePolicy?: StalePolicy;
}

export interface PersistFileResult {
  fileId: FileId;
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
  fileId: FileId | null;
  action: string;
  beforeJson: string | null;
  afterJson: string | null;
  ok: boolean;
  error: string | null;
}
