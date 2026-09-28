import type { FileRecord, DeviceRecord } from './media.js';
import type { GroupingMode, StripRecord, TimelineFile, UtcOffsetRule } from './strips.js';
import type { ComputedPosition } from './positions.js';

/** One entry in the server-side folder browser (SPEC §6.1). */
export interface FolderEntry {
  name: string;
  /** Path relative to PHOTO_ROOT; '' is the root itself. */
  relPath: string;
  /** Media files in this folder and beneath it, matching the supported extensions. */
  mediaCount: number;
  /** True when counting stopped at its cap, so the figure is a floor: show "500+". */
  mediaCountCapped: boolean;
  hasSubfolders: boolean;
  /** True when a .geotagger/edits.sqlite already exists here. */
  known: boolean;
}

export interface FolderListing {
  relPath: string;
  parentRelPath: string | null;
  entries: FolderEntry[];
}

export interface RecentFolder {
  relPath: string;
  lastOpenedAt: number;
  fileCount: number;
}

export type ScanPhase = 'idle' | 'walking' | 'reading-metadata' | 'thumbnails' | 'done' | 'failed';

/** Reopen summary shown before continuing (SPEC §6.1 step 3). */
export interface ScanSummary {
  known: number;
  added: number;
  changed: number;
  missing: number;
}

export interface ScanStatus {
  phase: ScanPhase;
  /** Files seen by the walker so far. */
  discovered: number;
  /** Files whose metadata has been read in this scan. */
  processed: number;
  /** Files queued for metadata reading in this scan. */
  queued: number;
  thumbsDone: number;
  thumbsQueued: number;
  currentPath: string | null;
  error: string | null;
  summary: ScanSummary | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SessionState {
  relPath: string;
  absPath: string;
  folderId: string;
  fileCount: number;
  groupingMode: GroupingMode;
  /**
   * True until the user has chosen how to group the initial strips (SPEC §4.4) for
   * this folder. No strips exist yet while this is true.
   */
  groupingQuestionPending: boolean;
  /** True until the timestamp question of SPEC §6.1 has been answered for this folder. */
  timestampQuestionPending: boolean;
  scan: ScanStatus;
}

export interface AnswerGroupingQuestionRequest {
  mode: Exclude<GroupingMode, 'manual'>;
}

export interface OpenSessionRequest {
  relPath: string;
}

export interface FilesResponse {
  files: FileRecord[];
  devices: DeviceRecord[];
  /** One computed position per file — camera GPS, an interpolated estimate, or none (SPEC §5, §10.2). */
  positions: ComputedPosition[];
}

export interface StripsResponse {
  groupingMode: GroupingMode;
  strips: StripRecord[];
  /** file id -> strip id, for every file in the folder. */
  assignments: Record<number, number>;
  /** True while there is a strip change to undo (SPEC §4.3, §4.4). */
  canUndo: boolean;
}

/**
 * Everything the alignment view needs in one response: the strips, and where every
 * file lands on the absolute timeline once §4.2 and §4.3 have been applied.
 *
 * It is one request rather than several because the view is useless with a partial
 * answer, and the browser recomputes the §4.3 arithmetic itself while dragging.
 */
export interface TimelineResponse extends StripsResponse {
  files: TimelineFile[];
  utcOffsetRules: UtcOffsetRule[];
  /** The offset the axis labels are drawn in — the folder's most common one. */
  displayUtcOffsetMinutes: number;
  /**
   * True when no file in the folder knows its UTC offset, so §4.2 has nothing to
   * inherit from and the user has to be asked once.
   */
  needsUtcOffsetAnswer: boolean;
  folderUtcOffsetMinutes: number | null;
}

export interface RegroupRequest {
  mode: GroupingMode;
  /** For `manual`: the files to make one strip from. */
  fileIds?: number[];
  label?: string;
}

export interface SetOffsetRequest {
  offsetSeconds: number;
}

export interface CutRequest {
  /** Where to cut, as an absolute instant on the shared axis. */
  atEffectiveMs: number;
}

export interface MergeRequest {
  leftStripId: number;
  rightStripId: number;
}

export interface LaneRequest {
  lane: number;
}

export interface LockRequest {
  locked: boolean;
}

export interface PinTrueTimeRequest {
  fileId: number;
  /** The real wall clock of that one file, naive ISO, in the display offset. */
  trueLocalIso: string;
}

export interface StripUtcOffsetRequest {
  /** Minutes east of UTC, or null to go back to what §4.2 infers. */
  utcOffsetMinutes: number | null;
}

export interface FolderUtcOffsetRequest {
  utcOffsetMinutes: number;
}

export interface ApiError {
  error: string;
  message: string;
}

/** The answer to the startup question of SPEC §6.1 step 4, remembered per folder. */
export interface TimestampQuestionState {
  /** True until the user has answered it once for this folder. */
  pending: boolean;
}
