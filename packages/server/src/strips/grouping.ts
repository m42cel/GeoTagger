import type { DeviceRecord, FileId, FileRecord, GroupingMode } from '@geotagger/shared';
import { groupByMode } from '@geotagger/shared';

export interface BuiltStrip {
  label: string;
  lane: number;
  ordinal: number;
  fileIds: FileId[];
}

/**
 * Builds the initial strips for a folder (SPEC §4.4): one per group of the mode, in
 * the groups' earliest-first order, so lane order matches the order the trip happened.
 *
 * Each strip gets its own lane, because two devices shooting on the same trip overlap
 * in time and strips within a lane may not (SPEC §3).
 */
export function buildStrips(
  mode: GroupingMode,
  files: FileRecord[],
  devices: DeviceRecord[],
): BuiltStrip[] {
  return groupByMode(mode, files, devices).map((g, i) => ({ label: g.label, lane: i, ordinal: 0, fileIds: g.fileIds }));
}
