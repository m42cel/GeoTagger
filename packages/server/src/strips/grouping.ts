import type { DeviceRecord, FileRecord, GroupingMode } from '@geotagger/shared';
import { naiveToMs } from '../metadata/capture-time.js';

export interface BuiltStrip {
  label: string;
  lane: number;
  ordinal: number;
  fileIds: number[];
}

/**
 * Builds the initial strips for a folder (SPEC §4.4).
 *
 * A strip is a contiguous set of files sharing one clock correction, so grouping
 * produces one strip per device or per subfolder, holding that group's files in
 * capture order. Each strip gets its own lane, because two devices shooting on the
 * same trip overlap in time and strips within a lane may not (SPEC §3).
 *
 * `manual` yields nothing on its own — the user builds those strips by selecting
 * files — so it is handled by the caller rather than here.
 */
export function buildStrips(
  mode: Exclude<GroupingMode, 'manual'>,
  files: FileRecord[],
  devices: DeviceRecord[],
): BuiltStrip[] {
  const groups = new Map<string, FileRecord[]>();
  for (const file of files) {
    const key = mode === 'device' ? deviceKey(file) : subfolderKey(file);
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }

  const labels = new Map(devices.map((d) => [d.id, d.label]));
  const built = [...groups.entries()].map(([key, groupFiles]) => {
    groupFiles.sort(compareByCaptureThenPath);
    return {
      key,
      label: mode === 'device' ? (labels.get(key) ?? UNKNOWN_DEVICE_LABEL) : subfolderLabel(key),
      fileIds: groupFiles.map((f) => f.id),
      firstCapture: firstCaptureMs(groupFiles),
    };
  });

  // Earliest strip first, so lane order matches the order the trip actually happened.
  built.sort((a, b) => {
    if (a.firstCapture === b.firstCapture) return a.label.localeCompare(b.label);
    if (a.firstCapture === null) return 1;
    if (b.firstCapture === null) return -1;
    return a.firstCapture - b.firstCapture;
  });

  return built.map((s, i) => ({ label: s.label, lane: i, ordinal: 0, fileIds: s.fileIds }));
}

export const UNKNOWN_DEVICE_LABEL = 'Unknown camera';
export const ROOT_FOLDER_LABEL = 'Folder root';

function deviceKey(file: FileRecord): string {
  return file.deviceId ?? '';
}

/** The immediate parent directory, relative to the folder root. */
function subfolderKey(file: FileRecord): string {
  const i = file.relPath.lastIndexOf('/');
  return i === -1 ? '' : file.relPath.slice(0, i);
}

function subfolderLabel(key: string): string {
  return key === '' ? ROOT_FOLDER_LABEL : key;
}

/**
 * Capture order, with undated files last and path as the tiebreaker so the result is
 * stable across rescans.
 */
export function compareByCaptureThenPath(a: FileRecord, b: FileRecord): number {
  const ta = naiveToMs(a.captureTimeRaw ?? '');
  const tb = naiveToMs(b.captureTimeRaw ?? '');
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.relPath.localeCompare(b.relPath);
}

function firstCaptureMs(files: FileRecord[]): number | null {
  for (const f of files) {
    const ms = naiveToMs(f.captureTimeRaw ?? '');
    if (ms !== null) return ms;
  }
  return null;
}
