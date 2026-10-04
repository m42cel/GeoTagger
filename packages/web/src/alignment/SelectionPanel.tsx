import { useEffect, useState } from 'react';
import type { CaptureTimeSource, FileRecord, StripRecord, TimelineFile } from '@geotagger/shared';
import { formatInstant, formatUtcOffset } from '@geotagger/shared';

/**
 * The detail area under the lanes (SPEC §6.2): the selected photo. The selected strip's
 * correction is edited in its lane header.
 */
export function SelectionPanel({
  strip,
  selectedFile,
  selectedLine,
  onSetTrueTime,
}: {
  strip: StripRecord | null;
  selectedFile: FileRecord | null;
  selectedLine: TimelineFile | null;
  onSetTrueTime: (trueLocalIso: string) => void;
}) {
  return (
    <div className="selection-panel">
      <PhotoCard
        strip={strip}
        file={selectedFile}
        line={selectedLine}
        onSetTrueTime={onSetTrueTime}
      />
    </div>
  );
}

/** Everything that applies to the one selected photo, beside a large preview of it. */
function PhotoCard({
  strip,
  file,
  line,
  onSetTrueTime,
}: {
  strip: StripRecord | null;
  file: FileRecord | null;
  line: TimelineFile | null;
  onSetTrueTime: (trueLocalIso: string) => void;
}) {
  if (strip === null || file === null || line === null) {
    return (
      <section className="selection-card">
        <p className="muted">Click a photo to see its time and set its true time. Its thumbnail then carries a pin button.</p>
      </section>
    );
  }

  const pinned = strip.pinnedFileIds.includes(file.id);
  // Why the corrected time can't be typed over, or null when it can (SPEC §4.3).
  const editBlocked = strip.locked
    ? 'The strip is locked.'
    : pinned
      ? 'This photo is pinned. Unpin it to change its time.'
      : strip.pinnedFileIds.length > 1
        ? 'Two pinned photos fix this strip.'
        : null;

  return (
    <section className="selection-card">
      <div className="selection-head">
        <strong className="photo-name" title={file.relPath}>
          {file.filename}
        </strong>
        {pinned && <span className="state-badge pin">pinned</span>}
      </div>
      <div className="photo-card-body">
        <FilePreview file={file} />
        <div className="photo-card-info">
          <dl className="file-detail">
            <dt>reads</dt>
            <dd>
              {file.captureTimeRaw?.replace('T', ' ') ?? '—'}
              {file.captureUtcOffsetMinutes !== null && <em> {formatUtcOffset(file.captureUtcOffsetMinutes)}</em>}{' '}
              <em className={weakSource(file.captureTimeSource) ? 'weak' : ''}>
                {SOURCE_LABEL[file.captureTimeSource]}
                {weakSource(file.captureTimeSource) && ' — weak source'}
              </em>
            </dd>
            <dt>corrected</dt>
            <dd>
              <CorrectedTime
                key={file.id}
                line={line}
                blockedReason={editBlocked}
                stretches={strip.pinnedFileIds.length === 1}
                onCommit={onSetTrueTime}
              />
            </dd>
          </dl>
        </div>
      </div>
    </section>
  );
}

/**
 * The photo's corrected time, typed over to set its true time (SPEC §4.3): the strip
 * shifts so this photo lands there, or stretches about its pinned photo when it has one.
 * The time is the wall clock in the photo's own offset, as a clock in the shot shows it.
 */
function CorrectedTime({
  line,
  blockedReason,
  stretches,
  onCommit,
}: {
  line: TimelineFile;
  blockedReason: string | null;
  stretches: boolean;
  onCommit: (trueLocalIso: string) => void;
}) {
  const shown =
    line.effectiveMs === null ? null : formatInstant(line.effectiveMs, line.utcOffsetMinutes, { seconds: true, date: true });
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(shown ?? '');

  const commit = (): void => {
    setEditing(false);
    const iso = parseLocalTime(text);
    if (iso !== null && iso.replace('T', ' ') !== shown) onCommit(iso);
  };

  if (shown === null) return <>—</>;

  return (
    <span className="corrected-time">
      {editing ? (
        <>
          <input
            type="text"
            className="offset-field corrected-input"
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
              e.stopPropagation();
            }}
          />
          <button
            type="button"
            className="edit-button confirm"
            aria-label="Apply the true time"
            title="Apply (Enter) — Escape cancels"
            // Kept from taking focus, so the field's blur doesn't commit first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            <Icon path="M5 12.5l4.5 4.5L19 7.5" />
          </button>
        </>
      ) : (
        <>
          {shown}
          <button
            type="button"
            className="edit-button"
            disabled={blockedReason !== null}
            aria-label="Set the true time"
            title={
              blockedReason ??
              (stretches
                ? 'Set the true time: the strip stretches about its pinned photo so this one lands there'
                : 'Set the true time: the whole strip shifts so this photo lands there')
            }
            onClick={() => {
              setText(shown);
              setEditing(true);
            }}
          >
            <Icon path="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
          </button>
        </>
      )}
      <em>
        {formatUtcOffset(line.utcOffsetMinutes)} · {UTC_SOURCE_LABEL[line.utcOffsetSource]}
      </em>
    </span>
  );
}

/** A small line icon — a pen in a square, a check mark — drawn in the text colour. */
function Icon({ path }: { path: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** `2024-07-12 15:34:22`, `2024-07-12T15:34` and the like to a naive ISO string, or null. */
export function parseLocalTime(input: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(input.trim());
  if (!m) return null;
  const [, date, h, min, sec] = m as unknown as [string, string, string, string, string | undefined];
  if (Number(h) > 23 || Number(min) > 59 || Number(sec ?? 0) > 59) return null;
  return `${date}T${h.padStart(2, '0')}:${min}:${sec ?? '00'}`;
}

/**
 * The selected file at the 1280 px preview tier (SPEC §10.1).
 *
 * On the axis a photo is a film-strip frame, which is the right size for reading a
 * pattern of activity and too small for recognising the moment itself — and
 * recognising it is how an alignment gets judged. The preview is fetched on demand,
 * so it costs nothing until a file is actually picked.
 */
function FilePreview({ file }: { file: FileRecord }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.id]);

  if (failed) {
    return <div className="file-preview empty muted">no preview</div>;
  }
  return (
    <img
      className="file-preview"
      src={`/api/files/${file.id}/preview`}
      alt={file.filename}
      title={file.relPath}
      onError={() => setFailed(true)}
    />
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `12 Jul`, `12–21 Jul`, `30 Jun – 2 Jul`, or `30 Dec 2024 – 2 Jan 2025` across a year. */
export function dateRange(fromMs: number | null, toMs: number | null, utcOffsetMinutes: number): string | null {
  if (fromMs === null || toMs === null) return null;
  const a = new Date(fromMs + utcOffsetMinutes * 60_000);
  const b = new Date(toMs + utcOffsetMinutes * 60_000);
  const day = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) {
    return `${day(a)} ${a.getUTCFullYear()} – ${day(b)} ${b.getUTCFullYear()}`;
  }
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${day(a)} – ${day(b)}`;
  if (a.getUTCDate() !== b.getUTCDate()) return `${a.getUTCDate()}–${day(b)}`;
  return day(a);
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

const UTC_SOURCE_LABEL: Record<TimelineFile['utcOffsetSource'], string> = {
  file: 'from the file',
  inherited: 'inherited from GPS',
  strip: 'set on the strip',
  'file-override': 'set on the file',
  folder: 'answered for the folder',
  assumed: 'assumed UTC',
};

/**
 * A time recovered from a filename or an mtime is flagged, because a wrong timestamp
 * corrupts interpolation invisibly (SPEC §6.2).
 */
function weakSource(source: CaptureTimeSource): boolean {
  return source === 'filename' || source === 'file:ModifyDate' || source === 'none';
}
