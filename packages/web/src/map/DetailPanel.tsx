import { useEffect, useState } from 'react';
import type { ComputedPosition, FileRecord, PositionSource, TimelineFile } from '@geotagger/shared';
import { formatInstant, formatUtcOffset } from '@geotagger/shared';

/**
 * Read-only detail for the map's selected thumbnail (SPEC §6.3's side panel), minus
 * the confirm/revert actions — those edit a position, which is phase 3's job. This
 * only shows what SPEC §5 already computed: the large preview, the corrected
 * timestamp, and where the file currently sits.
 */
export function DetailPanel({
  file,
  position,
  timelineFile,
}: {
  file: FileRecord | null;
  position: ComputedPosition | null;
  timelineFile: TimelineFile | null;
}) {
  if (file === null) {
    return <aside className="detail-panel muted">Click a thumbnail to see it here.</aside>;
  }

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
        {position !== null && position.source !== 'none' && (
          <>
            <dt>status</dt>
            <dd className="detail-status">{formatStatus(position)}</dd>
          </>
        )}
      </dl>
    </aside>
  );
}

function DetailPreview({ file }: { file: FileRecord }) {
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
  if (position === null || position.lat === null || position.lon === null) return 'no position';
  const latLon = `${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`;
  return origAlt === null ? latLon : `${latLon}, ${Math.round(origAlt)} m`;
}

const STATUS_LABEL: Record<PositionSource, string> = {
  'camera-gps': 'camera GPS',
  manual: 'manually placed',
  confirmed: 'confirmed',
  estimate: 'interpolated',
  none: 'no position',
};

function formatStatus(position: ComputedPosition): string {
  const label = STATUS_LABEL[position.source];
  return position.uncertaintyM === null ? label : `${label} · ±${Math.round(position.uncertaintyM)} m`;
}
