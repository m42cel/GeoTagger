import type { DeviceRecord, FileRecord, GroupingMode } from '@geotagger/shared';

/**
 * The initial grouping question of SPEC §4.4, asked once per folder before any strip
 * exists. It shows what the scan actually found — the devices EXIF identified and the
 * subfolders on disk — so the choice between them isn't blind.
 */
export function GroupingQuestion({
  files,
  devices,
  onChoose,
}: {
  files: FileRecord[];
  devices: DeviceRecord[];
  onChoose: (mode: Exclude<GroupingMode, 'manual'>) => void;
}) {
  const deviceLabel = new Map(devices.map((d) => [d.id, d.label]));
  const byDevice = countBy(files, (f) => f.deviceId ?? '');
  const bySubfolder = countBy(files, subfolderKey);

  return (
    <div className="question-card">
      <h1>How should these files be grouped into strips?</h1>
      <p className="muted">
        Each device or subfolder becomes its own strip with its own clock correction (SPEC §4.4).
        Strips can be split and merged by hand afterwards, and the mode can be changed later —
        though that rebuilds every strip from scratch.
      </p>

      <div className="grouping-options">
        <section>
          <h2>{bySubfolder.size} subfolder{bySubfolder.size === 1 ? '' : 's'} found</h2>
          <ul>
            {[...bySubfolder.entries()].map(([key, count]) => (
              <li key={key || '(root)'}>
                {key === '' ? 'Folder root' : key}
                <span className="muted"> · {count.toLocaleString()} files</span>
              </li>
            ))}
          </ul>
          <button type="button" className="primary" onClick={() => onChoose('subfolder')}>
            Group by subfolder
          </button>
        </section>

        <section>
          <h2>{devices.length} device{devices.length === 1 ? '' : 's'} found</h2>
          <ul>
            {[...byDevice.entries()].map(([id, count]) => (
              <li key={id || '(none)'}>
                {id ? deviceLabel.get(id) ?? 'Unknown camera' : 'No device info'}
                <span className="muted"> · {count.toLocaleString()} files</span>
              </li>
            ))}
          </ul>
          <button type="button" className="ghost" onClick={() => onChoose('device')}>
            Group by device
          </button>
        </section>
      </div>
    </div>
  );
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The immediate parent directory, relative to the folder root — mirrors the server's grouping key. */
function subfolderKey(file: FileRecord): string {
  const i = file.relPath.lastIndexOf('/');
  return i === -1 ? '' : file.relPath.slice(0, i);
}
