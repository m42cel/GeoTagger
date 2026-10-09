import type { DeviceRecord, FileRecord, GroupingMode } from '@geotagger/shared';
import { countOf } from './plural.js';
import { previewGroups } from './grouping-preview.js';

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
  onChoose: (mode: GroupingMode) => void;
}) {
  const bySubfolder = previewGroups('subfolder', files, devices);
  const byDevice = previewGroups('device', files, devices);

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
          <h2>{bySubfolder.length} subfolder{bySubfolder.length === 1 ? '' : 's'} found</h2>
          <ul>
            {bySubfolder.map(({ key, label, count }) => (
              <li key={key}>
                {label}
                <span className="muted"> · {countOf(count, 'file')}</span>
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
            {byDevice.map(({ key, label, count }) => (
              <li key={key}>
                {label}
                <span className="muted"> · {countOf(count, 'file')}</span>
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
