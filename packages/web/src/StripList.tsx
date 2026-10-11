import type { DeviceRecord, FileRecord, GroupingMode, StripsResponse } from '@geotagger/shared';
import { groupByMode } from '@geotagger/shared';
import { countOf } from './plural.js';
import { useDialog } from './Dialog.js';

const MODES: { mode: GroupingMode; label: string; hint: string }[] = [
  { mode: 'subfolder', label: 'By subfolder', hint: 'Useful when already sorted by camera or person' },
  { mode: 'device', label: 'By device', hint: 'Make, model and serial from EXIF' },
];

/**
 * The groups of both grouping modes side by side (SPEC §4.4): the devices or subfolders
 * the files fall into, never the strips. Those start out one per group of the chosen
 * mode, but cuts, merges and hand-picked strips are clock correction, which lives in the
 * alignment view.
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
        message: 'Every strip is rebuilt from scratch, discarding cuts and clock offsets. Undo brings them back.',
        confirmLabel: 'Rebuild strips',
      }))
    ) {
      return;
    }
    onRegroup(mode);
  };

  return (
    <div className="panel">
      {dialog}
      <h2>Groups · {groupByMode(strips.groupingMode, files, devices).length}</h2>

      <div className="mode-split">
        {MODES.map(({ mode, label, hint }) => {
          const active = strips.groupingMode === mode;
          return (
            <section key={mode} className={`mode-column${active ? ' active' : ''}`}>
              <button
                type="button"
                className={`mode${active ? ' active' : ''}`}
                title={hint}
                disabled={active}
                onClick={() => void switchTo(mode)}
              >
                {label}
              </button>
              <ul className="strips">
                {groupByMode(mode, files, devices).map((group) => (
                  <li key={group.key}>
                    <span className="strip-label">{group.label}</span>
                    <span className="muted">{countOf(group.fileIds.length, 'file')}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
