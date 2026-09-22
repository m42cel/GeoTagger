import type { FileRecord, DeviceRecord } from './media.js';
import type { GroupingMode, StripRecord } from './strips.js';

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
  scan: ScanStatus;
}

export interface OpenSessionRequest {
  relPath: string;
}

export interface FilesResponse {
  files: FileRecord[];
  devices: DeviceRecord[];
}

export interface StripsResponse {
  groupingMode: GroupingMode;
  strips: StripRecord[];
  /** file id -> strip id, for every file in the folder. */
  assignments: Record<number, number>;
}

export interface RegroupRequest {
  mode: GroupingMode;
}

export interface ApiError {
  error: string;
  message: string;
}
