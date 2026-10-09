import type { CaptureTimeSource, FileId, FileRecord, StripsResponse } from '@geotagger/shared';
import { countOf } from './plural.js';
import { DetailPreview } from './map/DetailPanel.js';

/**
 * The scanned files, with the capture time and — per SPEC §4.1 — the source it came
 * from. Showing the source is not a debugging aid: a time that came from the
 * filename or from mtime deserves far less trust than one from DateTimeOriginal, and
 * that is exactly what the user needs to judge before correcting clocks in phase 1.
 *
 * The files are grouped by strip, in the strip list's order. This page calls strips
 * "groups"; the alignment view, where they are lanes on a time axis, keeps "strip".
 */
export function FileGrid({
  files,
  strips,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
}: {
  files: FileRecord[];
  strips: StripsResponse | null;
  /** Strip ids whose group is collapsed; `null` for the unassigned group. */
  collapsed: ReadonlySet<number | null>;
  onToggle: (stripId: number | null) => void;
  selectedId: FileId | null;
  onSelect: (id: FileId) => void;
}) {

  if (files.length === 0) {
    return (
      <div className="panel">
        <h2>Files</h2>
        <p className="muted">No media files found in this folder.</p>
      </div>
    );
  }

  return (
    <div className="file-column">
      <div className="file-scroll">
        <div className="file-scroll-inner">
          {groupFiles(files, strips).map(({ stripId, label, files: members }) => {
            const open = !collapsed.has(stripId);
            return (
              <section key={stripId ?? 'unassigned'} className="panel file-group">
                <button
                  type="button"
                  className="file-group-head"
                  aria-expanded={open}
                  onClick={() => onToggle(stripId)}
                >
                  <span className="strip-label">{label}</span>
                  <span className="muted">{countOf(members.length, 'file')}</span>
                  <Chevron open={open} />
                </button>
                {open && (
                  <ul className="grid">
                    {members.map((file) => (
                      <li key={file.id}>
                        <Tile
                          file={file}
                          selected={selectedId === file.id}
                          onSelect={() => onSelect(file.id)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** `>` while collapsed, `v` while open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="chevron" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface FileGroup {
  /** `null` for files no strip claims, which only happens between two fetches. */
  stripId: number | null;
  label: string;
  files: FileRecord[];
}

/**
 * One group per strip in the strips' own order, each keeping the files' order. Empty
 * strips are dropped, and unassigned files, if any, come last.
 */
export function groupFiles(files: FileRecord[], strips: StripsResponse | null): FileGroup[] {
  const byStrip = new Map<number | null, FileRecord[]>();
  for (const file of files) {
    const stripId = strips?.assignments[file.id] ?? null;
    const list = byStrip.get(stripId);
    if (list) list.push(file);
    else byStrip.set(stripId, [file]);
  }

  const groups: FileGroup[] = [];
  for (const strip of strips?.strips ?? []) {
    const list = byStrip.get(strip.id);
    if (list) groups.push({ stripId: strip.id, label: strip.label, files: list });
    byStrip.delete(strip.id);
  }
  // Assigned to a strip the list doesn't have is as good as unassigned.
  const rest = [...byStrip.values()].flat();
  if (rest.length > 0) groups.push({ stripId: null, label: 'Unassigned', files: rest });
  return groups;
}

function Tile({ file, selected, onSelect }: { file: FileRecord; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`tile${selected ? ' selected' : ''}`}
      onClick={onSelect}
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
  );
}

/** The selected file's details, shown below the group list. */
export function FileDetail({
  file,
  stripId,
  onShowInAlignment,
  onShowOnMap,
}: {
  file: FileRecord;
  stripId: number | null;
  onShowInAlignment: () => void;
  onShowOnMap: () => void;
}) {
  return (
    <div className="panel grid-detail">
      <DetailPreview file={file} />
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
        <dt>Group</dt>
        <dd>{stripId === null ? 'unassigned' : `#${stripId}`}</dd>
      </dl>
      <div className="detail-jumps">
        <button type="button" className="ghost" onClick={onShowInAlignment}>
          Show in alignment view
        </button>
        <button type="button" className="ghost" onClick={onShowOnMap}>
          Show on map
        </button>
      </div>
    </div>
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
