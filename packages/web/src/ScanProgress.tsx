import type { ScanStatus } from '@geotagger/shared';

/**
 * Live scan progress (SPEC §6.1 step 2). Browsing is blocked until the scan settles
 * (`FolderView` gates on `status.phase`), but this still reports fine-grained progress
 * rather than a plain spinner — a first scan of 5,000 files on an ARM NAS is long
 * enough that the user needs to see it moving.
 */
export function ScanProgress({ status }: { status: ScanStatus }) {
  // A finished scan has nothing left to report; the folder's summary line takes over.
  if (status.phase === 'done') return null;
  const idle = status.phase === 'idle' || status.phase === 'failed';
  const { label, value, max } = describe(status);

  return (
    <div className={`scan scan-${status.phase}`}>
      <div className="scan-head">
        <strong>{label}</strong>
        {!idle && <span className="muted">{status.currentPath ?? ''}</span>}
      </div>
      {!idle && (
        <progress value={max > 0 ? value : undefined} max={max > 0 ? max : undefined}>
          {max > 0 ? `${value} / ${max}` : 'working'}
        </progress>
      )}
      {status.error && <p className="error">{status.error}</p>}
    </div>
  );
}

function describe(s: ScanStatus): { label: string; value: number; max: number } {
  switch (s.phase) {
    case 'walking':
      return { label: `Finding files — ${s.discovered.toLocaleString()} so far`, value: 0, max: 0 };
    case 'reading-metadata':
      return {
        label: `Reading metadata — ${s.processed.toLocaleString()} of ${s.queued.toLocaleString()}`,
        value: s.processed,
        max: s.queued,
      };
    case 'thumbnails':
      return {
        label: `Making thumbnails — ${s.thumbsDone.toLocaleString()} of ${s.thumbsQueued.toLocaleString()}`,
        value: s.thumbsDone,
        max: s.thumbsQueued,
      };
    case 'failed':
      return { label: 'Scan failed', value: 0, max: 0 };
    default:
      return { label: 'Idle', value: 0, max: 0 };
  }
}
