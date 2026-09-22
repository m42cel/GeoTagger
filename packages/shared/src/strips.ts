/** How the initial strips are formed (SPEC §4.4). */
export type GroupingMode = 'device' | 'subfolder' | 'manual';

/**
 * A contiguous set of files sharing one clock correction (SPEC §3).
 * Phase 0 builds and stores strips; the offsets stay zero until phase 1
 * introduces the alignment view that edits them.
 */
export interface StripRecord {
  id: number;
  lane: number;
  ordinal: number;
  label: string;
  groupingSource: GroupingMode;
  parentStripId: number | null;
  /** Clock correction in seconds at the strip's first file. */
  offsetStartSeconds: number;
  /** Clock correction in seconds at the strip's last file; differs only when stretched. */
  offsetEndSeconds: number;
  locked: boolean;
  createdAt: number;
  fileCount: number;
  /** Bounds over the strip's uncorrected capture times, epoch ms; null when it holds no dated file. */
  firstCaptureMs: number | null;
  lastCaptureMs: number | null;
}
