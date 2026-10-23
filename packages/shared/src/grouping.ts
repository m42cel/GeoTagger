import type { DeviceRecord, FileId, FileRecord } from './media.js';
import type { GroupingMode } from './strips.js';
import { naiveToMs } from './time.js';

/**
 * One group of a grouping mode (SPEC §4.4): the files of one device or one subfolder.
 *
 * It depends on the files alone, so it is what a mode offers — not a strip. Strips
 * start out as one per group but are then cut, merged and hand-picked, and lanes are
 * just the rows those strips are drawn in.
 */
export interface ModeGroup {
  /** The device id or the subfolder path; `''` for no device and for the folder root. */
  key: string;
  label: string;
  /** In capture order, undated files last. */
  fileIds: FileId[];
}

export const UNKNOWN_DEVICE_LABEL = 'Unknown device';
export const ROOT_FOLDER_LABEL = 'Folder root';

/** The groups `mode` makes of `files`, earliest first so the order follows the trip. */
export function groupByMode(
  mode: GroupingMode,
  files: readonly FileRecord[],
  devices: readonly DeviceRecord[],
): ModeGroup[] {
  const groups = new Map<string, FileRecord[]>();
  for (const file of files) {
    const key = mode === 'device' ? (file.deviceId ?? '') : subfolderKey(file);
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }

  const labels = new Map(devices.map((d) => [d.id, d.label]));
  const built = [...groups.entries()].map(([key, groupFiles]) => {
    groupFiles.sort(compareByCaptureThenPath);
    return {
      key,
      label: mode === 'device' ? (labels.get(key) ?? UNKNOWN_DEVICE_LABEL) : key || ROOT_FOLDER_LABEL,
      fileIds: groupFiles.map((f) => f.id),
      firstCapture: firstCaptureMs(groupFiles),
    };
  });

  built.sort((a, b) => {
    if (a.firstCapture === b.firstCapture) return a.label.localeCompare(b.label);
    if (a.firstCapture === null) return 1;
    if (b.firstCapture === null) return -1;
    return a.firstCapture - b.firstCapture;
  });

  return built.map(({ key, label, fileIds }) => ({ key, label, fileIds }));
}

/** The immediate parent directory, relative to the folder root. */
function subfolderKey(file: FileRecord): string {
  const i = file.relPath.lastIndexOf('/');
  return i === -1 ? '' : file.relPath.slice(0, i);
}

/**
 * Capture order, with undated files last and path as the tiebreaker so the result is
 * stable across rescans.
 */
function compareByCaptureThenPath(a: FileRecord, b: FileRecord): number {
  const ta = naiveToMs(a.captureTimeRaw);
  const tb = naiveToMs(b.captureTimeRaw);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.relPath.localeCompare(b.relPath);
}

function firstCaptureMs(files: readonly FileRecord[]): number | null {
  for (const f of files) {
    const ms = naiveToMs(f.captureTimeRaw);
    if (ms !== null) return ms;
  }
  return null;
}
