import { useState } from 'react';
import type { CaptureTimeSource, FileRecord } from '@geotagger/shared';

/**
 * The scanned files, with the capture time and — per SPEC §4.1 — the source it came
 * from. Showing the source is not a debugging aid: a time that came from the
 * filename or from mtime deserves far less trust than one from DateTimeOriginal, and
 * that is exactly what the user needs to judge before correcting clocks in phase 1.
 */
export function FileGrid({
  files,
  assignments,
}: {
  files: FileRecord[];
  assignments: Record<number, number>;
}) {
  const [selected, setSelected] = useState<FileRecord | null>(null);

  if (files.length === 0) {
    return (
      <div className="panel">
        <h2>Files</h2>
        <p className="muted">No media files found in this folder.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Files · {files.length.toLocaleString()}</h2>
      <ul className="grid">
        {files.map((file) => (
          <li key={file.id}>
            <button
              type="button"
              className={`tile${selected?.id === file.id ? ' selected' : ''}`}
              onClick={() => setSelected(file)}
              title={file.relPath}
            >
              <img
                src={`/api/files/${file.id}/thumb`}
                alt=""
                loading="lazy"
                width={160}
                height={160}
                className={file.thumbState === 'failed' ? 'broken' : ''}
              />
              <span className="tile-name">{file.filename}</span>
              <span className="tile-time">
                {formatTime(file.captureTimeRaw)}
                <em className={trustClass(file.captureTimeSource)}>
                  {SOURCE_LABEL[file.captureTimeSource]}
                </em>
              </span>
              {file.origGpsPresent && <span className="badge gps">GPS</span>}
              {file.kind === 'video' && <span className="badge kind">video</span>}
            </button>
          </li>
        ))}
      </ul>

      {selected && <Detail file={selected} stripId={assignments[selected.id] ?? null} />}
    </div>
  );
}

function Detail({ file, stripId }: { file: FileRecord; stripId: number | null }) {
  return (
    <dl className="detail">
      <dt>Path</dt>
      <dd>{file.relPath}</dd>
      <dt>Capture time</dt>
      <dd>
        {formatTime(file.captureTimeRaw)} <em>{SOURCE_LABEL[file.captureTimeSource]}</em>
      </dd>
      <dt>UTC offset</dt>
      <dd>
        {file.captureUtcOffsetMinutes === null
          ? 'unknown — inherited in phase 1'
          : formatOffset(file.captureUtcOffsetMinutes)}
      </dd>
      <dt>Camera GPS</dt>
      <dd>
        {file.origGpsPresent
          ? `${file.origLat?.toFixed(5)}, ${file.origLon?.toFixed(5)}`
          : 'none'}
      </dd>
      <dt>Dimensions</dt>
      <dd>
        {file.width && file.height ? `${file.width} × ${file.height}` : 'unknown'}
        {file.durationMs !== null ? ` · ${(file.durationMs / 1000).toFixed(1)} s` : ''}
      </dd>
      <dt>Strip</dt>
      <dd>{stripId === null ? 'unassigned' : `#${stripId}`}</dd>
    </dl>
  );
}

const SOURCE_LABEL: Record<CaptureTimeSource, string> = {
  'exif:DateTimeOriginal': 'EXIF original',
  'exif:CreateDate': 'EXIF created',
  'quicktime:CreateDate': 'QuickTime UTC',
  'xmp:DateCreated': 'XMP',
  'exif:GPSDateTime': 'GPS satellite',
  filename: 'filename',
  'file:ModifyDate': 'file mtime',
  none: 'no date',
};

/** mtime and "no date" are the weak sources; the UI says so rather than implying equal trust. */
function trustClass(source: CaptureTimeSource): string {
  return source === 'file:ModifyDate' || source === 'none' ? 'weak' : '';
}

export function formatTime(localIso: string | null): string {
  if (!localIso) return '—';
  return localIso.replace('T', ' ');
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
