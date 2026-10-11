import type { DeviceRecord, FileRecord, GroupingMode } from '@geotagger/shared';

export interface PreviewGroup {
  key: string;
  label: string;
  count: number;
}

/**
 * The groups a mode would build, by file count — what the grouping choices show
 * before anything is rebuilt. Groups come in the order their first file appears.
 */
export function previewGroups(mode: GroupingMode, files: readonly FileRecord[], devices: readonly DeviceRecord[]): PreviewGroup[] {
  const deviceLabel = new Map(devices.map((d) => [d.id, d.label]));
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = mode === 'device' ? (file.deviceId ?? '') : subfolderKey(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({
    key,
    count,
    label:
      mode === 'device'
        ? key
          ? deviceLabel.get(key) ?? 'Unknown device'
          : 'No device info'
        : key || 'Folder root',
  }));
}

/** The immediate parent directory, relative to the folder root — mirrors the server's grouping key. */
function subfolderKey(file: FileRecord): string {
  const i = file.relPath.lastIndexOf('/');
  return i === -1 ? '' : file.relPath.slice(0, i);
}
