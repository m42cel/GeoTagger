import { useEffect, useState } from 'react';
import type { ComputedPosition, FileId, FileRecord, PositionSource, TimelineFile } from '@geotagger/shared';
import { canConfirm as confirmable, formatInstant, formatUtcOffset, shownPosition } from '@geotagger/shared';
import { borderClassFor } from './marker-status.js';

/**
 * Detail for the map's selected thumbnail (SPEC §6.3's side panel): the large
 * preview, the corrected timestamp, where the file currently sits, and — for a
 * single selection — the confirm/revert/reset controls of SPEC §6.5.
 *
 * Revert and reset are two different depths of undo: revert cancels only a drag in
 * progress, falling back to whatever is underneath it (camera GPS, a confirmed
 * position, or the estimate); reset discards a confirmed position too, back to camera
 * GPS, a derived estimate or no position at all (SPEC §5.6, §6.5).
 *
 * While the map's multi-selection (SPEC §6.5) is non-empty, this panel shows a grid
 * of small thumbnails instead — the single-file view doesn't make sense for several
 * files at once, and the multi-select confirm/clear actions live in the map's own
 * toolbar, not here. Clicking a thumbnail in the grid exits multi-select and shows
 * that one file normally, exactly as clicking it on the map would.
 */
export function DetailPanel({
  file,
  position,
  timelineFile,
  onConfirm,
  onRevert,
  onReset,
  busy,
  multiSelectedItems,
  onSelectOne,
}: {
  file: FileRecord | null;
  position: ComputedPosition | null;
  timelineFile: TimelineFile | null;
  onConfirm: () => void;
  onRevert: () => void;
  onReset: () => void;
  busy: boolean;
  multiSelectedItems: { file: FileRecord; position: ComputedPosition }[];
  onSelectOne: (fileId: FileId) => void;
}) {
  if (multiSelectedItems.length > 0) {
    return (
      <aside className="detail-panel">
        <div className="detail-multi-header">{multiSelectedItems.length} selected</div>
        <div className="detail-multi-grid">
          {multiSelectedItems.map((item) => (
            <button
              key={item.file.id}
              type="button"
              className={`detail-multi-thumb ${borderClassFor(item.position)}`}
              title={item.file.filename}
              onClick={() => onSelectOne(item.file.id)}
            >
              <img src={`/api/files/${item.file.id}/thumb`} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  if (file === null) {
    return <aside className="detail-panel muted">Click a thumbnail to see it here.</aside>;
  }

  const canConfirm = position !== null && confirmable(position);
  const canRevert = position !== null && position.pending !== null;
  // Camera GPS and an estimate come from the file and the anchors, not the edit store
  // — only a confirmation is there to discard.
  const canReset = position?.base?.source === 'confirmed';

  return (
    <aside className="detail-panel">
      <DetailPreview file={file} />
      <dl className="file-detail">
        <dt>file</dt>
        <dd>{file.filename}</dd>
        <dt>time</dt>
        <dd>{formatCorrectedTime(timelineFile)}</dd>
        <dt>position</dt>
        <dd>{formatPosition(position, file.origAlt)}</dd>
        {position !== null && shownPosition(position) !== null && (
          <>
            <dt>status</dt>
            <dd className="detail-status">{formatStatus(position)}</dd>
          </>
        )}
      </dl>
      {(canConfirm || canRevert || canReset) && (
        <div className="detail-actions">
          <button type="button" className="confirm" disabled={!canConfirm || busy} onClick={onConfirm} title="Confirm">
            ✓
          </button>
          <button type="button" className="ghost" disabled={!canRevert || busy} onClick={onRevert}>
            Revert
          </button>
          <button type="button" className="ghost" disabled={!canReset || busy} onClick={onReset}>
            Reset
          </button>
        </div>
      )}
    </aside>
  );
}

export function DetailPreview({ file }: { file: FileRecord }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.id]);

  if (failed) {
    return <div className="detail-preview empty muted">no preview</div>;
  }
  return (
    <img
      className="detail-preview"
      src={`/api/files/${file.id}/preview`}
      alt={file.filename}
      title={file.relPath}
      onError={() => setFailed(true)}
    />
  );
}

function formatCorrectedTime(timelineFile: TimelineFile | null) {
  if (timelineFile === null || timelineFile.effectiveMs === null) return '—';
  const time = formatInstant(timelineFile.effectiveMs, timelineFile.utcOffsetMinutes, { seconds: true, date: true });
  return (
    <>
      {time} <em>{formatUtcOffset(timelineFile.utcOffsetMinutes)}</em>
    </>
  );
}

function formatPosition(position: ComputedPosition | null, origAlt: number | null): string {
  const shown = position === null ? null : shownPosition(position);
  if (shown === null) return 'no position';
  const latLon = `${shown.lat.toFixed(5)}, ${shown.lon.toFixed(5)}`;
  return origAlt === null ? latLon : `${latLon}, ${Math.round(origAlt)} m`;
}

const STATUS_LABEL: Record<PositionSource, string> = {
  'camera-gps': 'camera GPS',
  confirmed: 'confirmed',
  estimate: 'interpolated',
};

/** Only called for a file that shows somewhere — a drag, or a position of its own. */
function formatStatus(position: ComputedPosition): string {
  if (position.pending !== null) return 'manually placed';
  const base = position.base as NonNullable<ComputedPosition['base']>;
  const label = STATUS_LABEL[base.source];
  return base.uncertaintyM === null ? label : `${label} · ±${Math.round(base.uncertaintyM)} m`;
}
