import { useEffect, useState } from 'react';
import type { CaptureTimeSource, FileRecord, StripRecord, TimelineFile } from '@geotagger/shared';
import {
  formatInstant,
  formatOffset,
  formatUtcOffset,
  parseOffsetSeconds,
  parseUtcOffsetMinutes,
} from '@geotagger/shared';

/**
 * The detail strip under the lanes (SPEC §6.2).
 *
 * The numeric fields are not a convenience: at trip zoom one pixel covers minutes, so
 * typing and keyboard nudging are the only ways to reach the second-level precision the
 * correction actually needs (SPEC §14.4).
 */
export function SelectionPanel({
  strip,
  fileCountLabel,
  mergeTargetId,
  cutAtMs,
  displayUtcOffsetMinutes,
  selectedFile,
  selectedLine,
  onSetOffset,
  onCut,
  onMerge,
  onReset,
  onSetUtcOffset,
  onPin,
}: {
  strip: StripRecord | null;
  fileCountLabel: string;
  mergeTargetId: number | null;
  /** Where a cut would land: the last place the pointer was over the canvas. */
  cutAtMs: number | null;
  displayUtcOffsetMinutes: number;
  selectedFile: FileRecord | null;
  selectedLine: TimelineFile | null;
  onSetOffset: (seconds: number) => void;
  onCut: (atMs: number) => void;
  onMerge: (rightStripId: number) => void;
  onReset: () => void;
  onSetUtcOffset: (minutes: number | null) => void;
  onPin: () => void;
}) {
  if (strip === null) {
    return (
      <div className="selection-panel muted">
        Select a strip to set its offset exactly, cut it or lock it.
      </div>
    );
  }

  return (
    <div className="selection-panel">
      <div className="selection-head">
        <strong>{strip.label}</strong>
        <span className="muted">{fileCountLabel}</span>
        {strip.locked && <span className="badge locked">locked</span>}
      </div>

      <div className="selection-fields">
        <label>
          offset
          <OffsetField value={strip.offsetSeconds} disabled={strip.locked} onCommit={onSetOffset} />
        </label>
        <label>
          UTC
          <UtcField
            value={strip.utcOffsetOverrideMinutes}
            disabled={strip.locked}
            onCommit={onSetUtcOffset}
          />
        </label>
      </div>

      <div className="selection-actions">
        <button
          type="button"
          className="ghost"
          disabled={strip.locked || cutAtMs === null}
          title={
            cutAtMs === null
              ? 'Point at the axis to place the cut'
              : 'Cuts where the pointer last was — or press c without leaving the strip'
          }
          onClick={() => cutAtMs !== null && onCut(cutAtMs)}
        >
          ✂ cut at cursor <kbd>c</kbd>
        </button>
        <button
          type="button"
          className="ghost"
          disabled={mergeTargetId === null || strip.locked}
          title={mergeTargetId === null ? 'No adjacent segment of this strip to merge with' : undefined}
          onClick={() => mergeTargetId !== null && onMerge(mergeTargetId)}
        >
          merge
        </button>
        <button type="button" className="ghost" disabled={strip.locked} onClick={onReset}>
          reset
        </button>
      </div>

      {selectedFile && selectedLine && (
        <div className="selection-file">
          <FilePreview file={selectedFile} />
          <dl className="file-detail">
            <dt>file</dt>
            <dd>{selectedFile.filename}</dd>
            <dt>reads</dt>
            <dd>
              {selectedFile.captureTimeRaw?.replace('T', ' ') ?? '—'}
              {selectedFile.captureUtcOffsetMinutes !== null &&
                ` ${formatUtcOffset(selectedFile.captureUtcOffsetMinutes)}`}{' '}
              <em className={weakSource(selectedFile.captureTimeSource) ? 'weak' : ''}>
                {SOURCE_LABEL[selectedFile.captureTimeSource]}
                {weakSource(selectedFile.captureTimeSource) && ' — weak source'}
              </em>
            </dd>
            {corrects(selectedFile, selectedLine) && (
              <>
                <dt>corrected</dt>
                <dd>
                  {selectedLine.effectiveMs === null
                    ? '—'
                    : formatInstant(selectedLine.effectiveMs, displayUtcOffsetMinutes, { seconds: true, date: true })}{' '}
                  <em>{formatUtcOffset(selectedLine.utcOffsetMinutes)} · {UTC_SOURCE_LABEL[selectedLine.utcOffsetSource]}</em>
                </dd>
              </>
            )}
            <dd className="pin-action">
              <button type="button" className="ghost" disabled={strip.locked} onClick={onPin}>
                set true time…
              </button>
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
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

/** A text field that keeps what was typed until it parses, so a half-typed offset survives. */
function OffsetField({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (seconds: number) => void;
}) {
  const [text, setText] = useState(() => formatOffset(value));
  useEffect(() => setText(formatOffset(value)), [value]);

  const commit = (): void => {
    const parsed = parseOffsetSeconds(text);
    if (parsed === null || parsed === value) setText(formatOffset(value));
    else onCommit(parsed);
  };

  return (
    <input
      type="text"
      className="offset-field"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(formatOffset(value));
        // The lanes below nudge on arrow keys; inside a text field they belong to the
        // caret.
        e.stopPropagation();
      }}
    />
  );
}

function UtcField({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (minutes: number | null) => void;
}) {
  const [text, setText] = useState(() => (value === null ? '' : formatUtcOffset(value)));
  useEffect(() => setText(value === null ? '' : formatUtcOffset(value)), [value]);

  return (
    <input
      type="text"
      className="offset-field narrow"
      value={text}
      disabled={disabled}
      placeholder="inherited"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() === '') {
          if (value !== null) onCommit(null);
          return;
        }
        const parsed = parseUtcOffsetMinutes(text);
        if (parsed === null) setText(value === null ? '' : formatUtcOffset(value));
        else if (parsed !== value) onCommit(parsed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        e.stopPropagation();
      }}
    />
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

const UTC_SOURCE_LABEL: Record<TimelineFile['utcOffsetSource'], string> = {
  file: 'from the file',
  inherited: 'inherited from GPS',
  strip: 'set on the strip',
  'file-override': 'set on the file',
  folder: 'answered for the folder',
  assumed: 'assumed UTC',
};

/**
 * Whether the correction line says anything the “reads” line did not.
 *
 * A file that states its own offset and sits on an unshifted strip is already fully
 * described by what it reads: repeating the same instant under a “corrected” label
 * invites the user to hunt for a difference that is not there. The line earns its place
 * only when the strip actually moves the clock, or when the offset we would write comes
 * from somewhere other than the file itself — inheritance, a strip or file override,
 * the folder's answer, or the assumed-UTC fallback.
 */
function corrects(file: FileRecord, line: TimelineFile): boolean {
  if (line.offsetSeconds !== 0) return true;
  return file.captureUtcOffsetMinutes === null || line.utcOffsetSource !== 'file';
}

/**
 * A time recovered from a filename or an mtime is flagged, because a wrong timestamp
 * corrupts interpolation invisibly (SPEC §6.2).
 */
function weakSource(source: CaptureTimeSource): boolean {
  return source === 'filename' || source === 'file:ModifyDate' || source === 'none';
}
