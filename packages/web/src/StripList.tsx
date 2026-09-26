import type { DeviceRecord, GroupingMode, StripsResponse } from '@geotagger/shared';
import { formatOffset } from '@geotagger/shared';

const MODES: { mode: GroupingMode; label: string; hint: string }[] = [
  { mode: 'subfolder', label: 'By subfolder', hint: 'Useful when already sorted by camera or person' },
  { mode: 'device', label: 'By device', hint: 'Make, model and serial from EXIF' },
  { mode: 'manual', label: 'Manual', hint: 'Pick the files in the alignment view and make a strip from them' },
];

/**
 * The strips a folder was grouped into (SPEC §4.4), as a plain list. Correcting the
 * clocks happens in the alignment view; this is the overview beside the file grid.
 */
export function StripList({
  strips,
  devices,
  onRegroup,
}: {
  strips: StripsResponse | null;
  devices: DeviceRecord[];
  onRegroup: (mode: GroupingMode) => void;
}) {
  if (!strips) return <div className="panel"><h2>Strips</h2><p className="muted">Loading…</p></div>;

  return (
    <div className="panel">
      <h2>Strips · {strips.strips.length}</h2>

      <div className="modes">
        {MODES.map(({ mode, label, hint }) => (
          <button
            key={mode}
            type="button"
            className={`mode${strips.groupingMode === mode ? ' active' : ''}`}
            title={hint}
            // A manual strip is made from a selection, and the selection is made on
            // the time axis — there is nothing to select here.
            disabled={mode === 'manual' && strips.groupingMode !== 'manual'}
            onClick={() => {
              // Switching mode rebuilds from scratch, discarding cuts and offsets
              // (SPEC §4.4), so the user is warned before it happens.
              if (
                strips.strips.length > 0 &&
                !window.confirm(
                  'Switching grouping mode rebuilds every strip from scratch, discarding cuts and clock offsets. Continue?',
                )
              ) {
                return;
              }
              onRegroup(mode);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="strips">
        {strips.strips.map((strip) => (
          <li key={strip.id}>
            <span className="lane">lane {strip.lane}</span>
            <span className="strip-label">{strip.label}</span>
            <span className="muted">
              {strip.fileCount.toLocaleString()} files
              {strip.firstCaptureMs !== null && ` · ${span(strip.firstCaptureMs, strip.lastCaptureMs)}`}
              {strip.offsetSeconds !== 0 ? ` · ${formatOffset(strip.offsetSeconds)}` : ''}
              {strip.locked && ' · locked'}
            </span>
          </li>
        ))}
      </ul>

      {devices.length > 0 && (
        <details className="devices">
          <summary>{devices.length} device{devices.length === 1 ? '' : 's'} identified</summary>
          <ul>
            {devices.map((d) => (
              <li key={d.id}>
                {d.label}
                {d.serial && <span className="muted"> · serial {d.serial}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Capture times are naive wall clocks, so they are formatted as read, without a zone. */
function span(fromMs: number, toMs: number | null): string {
  const from = naive(fromMs);
  if (toMs === null || toMs === fromMs) return from;
  return `${from} → ${naive(toMs)}`;
}

function naive(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
