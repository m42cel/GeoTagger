import { groupByMode } from '@geotagger/shared';
import type { CaptureTimeSource, DeviceRecord, FileId, FileRecord, StripsResponse } from '@geotagger/shared';
import { countOf } from './plural.js';
import { DetailPreview } from './map/DetailPanel.js';

/**
 * The scanned files, with the capture time and — per SPEC §4.1 — the source it came
 * from. Showing the source is not a debugging aid: a time that came from the
 * filename or from mtime deserves far less trust than one from DateTimeOriginal, and
 * that is exactly what the user needs to judge before correcting clocks in phase 1.
 *
 * The files are grouped by the grouping mode's subfolders or devices. Cuts, hand-picked
 * strips and lanes are clock correction and never split a group here.
 */
export function FileGrid({
  files,
  strips,
  devices,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
}: {
  files: FileRecord[];
  strips: StripsResponse | null;
  devices: DeviceRecord[];
  /** Keys of the collapsed groups; `null` for the unassigned group. */
  collapsed: ReadonlySet<string | null>;
  onToggle: (key: string | null) => void;
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
          {groupFiles(files, strips, devices).map(({ key, label, files: members }) => {
            const open = !collapsed.has(key);
            return (
              <section key={key ?? 'unassigned'} className="panel file-group">
                <button
                  type="button"
                  className="file-group-head"
                  aria-expanded={open}
                  onClick={() => onToggle(key)}
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
  /** The grouping mode's key; `null` for the one group shown before the strips load. */
  key: string | null;
  label: string;
  files: FileRecord[];
}

/**
 * One group per subfolder or device of the grouping mode, earliest first, each keeping
 * the files' order. Until the strips have loaded the mode is unknown, so everything is
 * one unassigned group.
 */
export function groupFiles(
  files: FileRecord[],
  strips: StripsResponse | null,
  devices: readonly DeviceRecord[],
): FileGroup[] {
  if (!strips) return files.length === 0 ? [] : [{ key: null, label: 'Unassigned', files }];
  return groupByMode(strips.groupingMode, files, devices).map(({ key, label, fileIds }) => {
    const members = new Set(fileIds);
    return { key, label, files: files.filter((f) => members.has(f.id)) };
  });
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
  group,
  onShowInAlignment,
  onShowOnMap,
}: {
  file: FileRecord;
  /** The label of the file's group; `null` while the strips are loading. */
  group: string | null;
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
        <dd>{group ?? 'unassigned'}</dd>
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

function formatTime(localIso: string | null): string {
  if (!localIso) return '—';
  return localIso.replace('T', ' ');
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
