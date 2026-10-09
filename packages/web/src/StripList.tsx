import type { DeviceRecord, FileRecord, GroupingMode, StripsResponse } from '@geotagger/shared';
import { formatOffset } from '@geotagger/shared';
import { countOf } from './plural.js';
import { useDialog } from './Dialog.js';
import { previewGroups } from './grouping-preview.js';

const MODES: { mode: GroupingMode; label: string; hint: string }[] = [
  { mode: 'subfolder', label: 'By subfolder', hint: 'Useful when already sorted by camera or person' },
  { mode: 'device', label: 'By device', hint: 'Make, model and serial from EXIF' },
];

/**
 * The strips a folder was grouped into (SPEC §4.4), side by side with what the other
 * grouping mode would build instead. Correcting the clocks happens in the alignment
 * view; this is the overview beside the file grid, which calls strips "groups".
 */
export function StripList({
  strips,
  files,
  devices,
  onRegroup,
}: {
  strips: StripsResponse | null;
  files: FileRecord[];
  devices: DeviceRecord[];
  onRegroup: (mode: GroupingMode) => void;
}) {
  const { dialog, confirm } = useDialog();

  if (!strips) return <div className="panel"><h2>Groups</h2><p className="muted">Loading…</p></div>;

  const switchTo = async (mode: GroupingMode): Promise<void> => {
    // Switching mode rebuilds from scratch, discarding cuts and offsets (SPEC §4.4),
    // so the user is warned before it happens.
    if (
      strips.strips.length > 0 &&
      !(await confirm({
        title: 'Switch grouping mode?',
        message: 'Every group is rebuilt from scratch, discarding cuts and clock offsets. Undo brings them back.',
        confirmLabel: 'Rebuild groups',
      }))
    ) {
      return;
    }
    onRegroup(mode);
  };

  return (
    <div className="panel">
      {dialog}
      <h2>Groups · {strips.strips.length}</h2>

      <div className="mode-split">
        {MODES.map(({ mode, label, hint }) =>
          strips.groupingMode === mode ? (
            <section key={mode} className="mode-column active">
              <button type="button" className="mode active" title={hint} disabled>
                {label}
              </button>
              <ul className="strips">
                {strips.strips.map((strip) => (
                  <li key={strip.id}>
                    <span className="strip-label">{strip.label}</span>
                    <span className="muted">
                      {[
                        countOf(strip.fileCount, 'file'),
                        strip.offsetSeconds !== 0 && formatOffset(strip.offsetSeconds),
                        strip.locked && 'locked',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section key={mode} className="mode-column">
              <button type="button" className="mode" title={hint} onClick={() => void switchTo(mode)}>
                {label}
              </button>
              <ul className="strips">
                {previewGroups(mode, files, devices).map((group) => (
                  <li key={group.key}>
                    <span className="strip-label">{group.label}</span>
                    <span className="muted">{countOf(group.count, 'file')}</span>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}
      </div>
    </div>
  );
}
