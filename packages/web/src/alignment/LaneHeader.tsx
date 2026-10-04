import { useEffect, useState } from 'react';
import type { StripRecord } from '@geotagger/shared';
import { formatDrift, formatOffset, formatUtcOffset, parseOffsetSeconds, parseUtcOffsetMinutes } from '@geotagger/shared';
import { dateRange } from './SelectionPanel.js';

/**
 * A lane's header: the strip's correction, editable where it is drawn (SPEC §6.2).
 *
 * A lane can hold several segments of a cut strip, each with its own correction, and a
 * lane row has room for one set of controls. So the header shows the selected
 * segment's — or the first one's, while none of the lane's is selected — and the
 * segment numbers switch between them.
 *
 * The offset field is not a convenience: at trip zoom one pixel covers minutes, so
 * typing and keyboard nudging are the only ways to reach the second-level precision the
 * correction actually needs (SPEC §14.4).
 */
export function LaneHeader({
  lane,
  selectedStripId,
  displayUtcOffsetMinutes,
  height,
  onSelect,
  onSetOffset,
  onReset,
  onSetLocked,
  onSetUtcOffset,
}: {
  lane: readonly StripRecord[];
  selectedStripId: number | null;
  displayUtcOffsetMinutes: number;
  height: number;
  onSelect: (stripId: number) => void;
  onSetOffset: (stripId: number, seconds: number) => void;
  onReset: (stripId: number, part: 'offset' | 'drift') => void;
  onSetLocked: (stripId: number, locked: boolean) => void;
  onSetUtcOffset: (stripId: number, minutes: number | null) => void;
}) {
  const strip = lane.find((s) => s.id === selectedStripId) ?? lane[0];
  if (strip === undefined) return <div className="lane-header" style={{ height }} />;

  // One pin turns a shift into a stretch, and two fix the strip (SPEC §4.3): either
  // way the offset can no longer be typed in or reset.
  const pinned = strip.pinnedFileIds.length > 0;
  const pinnedTitle = pinned ? 'A photo of this strip is pinned. Unpin it to shift or reset the strip.' : undefined;
  const range = dateRange(strip.firstEffectiveMs, strip.lastEffectiveMs, displayUtcOffsetMinutes);

  return (
    <div className="lane-header" style={{ height }}>
      <span className="lane-title">
        <span
          className="lane-label"
          title={`${strip.label} · ${strip.fileCount.toLocaleString()} files${range === null ? '' : ` · ${range}`}`}
        >
          {strip.label}
          <em> · {strip.fileCount.toLocaleString()}</em>
        </span>
        {pinned && (
          <span className="state-badge pin" title={pinnedTitle}>
            {strip.pinnedFileIds.length === 1 ? '1 pin' : `${strip.pinnedFileIds.length} pins`}
          </span>
        )}
        <button
          type="button"
          className={`lock-toggle${strip.locked ? ' on' : ''}`}
          title={strip.locked ? 'Locked — click to unlock' : 'Lock: freeze this clock, keep it as a snap target'}
          aria-label={strip.locked ? 'Unlock' : 'Lock'}
          aria-pressed={strip.locked}
          onClick={() => onSetLocked(strip.id, !strip.locked)}
        >
          <LockIcon locked={strip.locked} />
        </button>
      </span>

      {lane.length > 1 && (
        <span className="segment-picker" title="This lane holds segments of a cut strip; pick the one to edit">
          {lane.map((s, i) => (
            <button
              type="button"
              key={s.id}
              className={`chip${s.id === strip.id ? ' on' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              {i + 1}
            </button>
          ))}
        </span>
      )}

      <span className="lane-row-control" title={pinnedTitle}>
        <span className="lane-row-label">Offset</span>
        <OffsetField
          value={strip.offsetSeconds}
          disabled={strip.locked || pinned}
          onCommit={(seconds) => onSetOffset(strip.id, seconds)}
        />
        <button
          type="button"
          className="chip reset-chip"
          disabled={strip.locked || pinned || strip.offsetSeconds === 0}
          title={pinnedTitle ?? 'Reset: back to zero offset, keeping the drift'}
          aria-label="Reset offset"
          onClick={() => onReset(strip.id, 'offset')}
        >
          ↺
        </button>
      </span>

      <span className="lane-row-control">
        <span className="lane-row-label">Drift</span>
        {/* Drawn like the offset field so the two rows line up; it is set by stretching. */}
        <span
          className="offset-field compact readonly"
          title="How fast this camera's clock ran, set by stretching about a pinned photo (SPEC §4.3)"
        >
          {formatDrift(strip.drift)}
        </span>
        <button
          type="button"
          className="chip reset-chip"
          disabled={strip.locked || strip.drift === 0 || strip.pinnedFileIds.length > 1}
          title={
            strip.pinnedFileIds.length > 1
              ? 'Two pinned photos fix this strip; straightening it would move one of them.'
              : strip.pinnedFileIds.length === 1
                ? 'Reset: straighten the strip, keeping the pinned photo where it is'
                : 'Reset: straighten the strip back to a plain offset'
          }
          aria-label="Reset drift"
          onClick={() => onReset(strip.id, 'drift')}
        >
          ↺
        </button>
      </span>

      <span className="lane-row-control">
        <span className="lane-row-label">TZ</span>
        <UtcField
          value={strip.utcOffsetOverrideMinutes}
          disabled={strip.locked}
          onCommit={(minutes) => onSetUtcOffset(strip.id, minutes)}
        />
        <button
          type="button"
          className="chip reset-chip"
          disabled={strip.locked || strip.utcOffsetOverrideMinutes === null}
          title="Reset: back to the offset inherited from GPS-bearing photos (SPEC §4.2)"
          aria-label="Reset time zone"
          onClick={() => onSetUtcOffset(strip.id, null)}
        >
          ↺
        </button>
      </span>
    </div>
  );
}

/**
 * A padlock, closed or open. Open swings the shackle out to the right, clear of the
 * body, and stays grey; closed turns the body yellow — the two read apart at a glance
 * rather than differing by a few pixels.
 */
function LockIcon({ locked }: { locked: boolean }) {
  // Wide enough for the open shackle on both states, so the body sits in the same place
  // and only the shackle and colour change.
  return (
    <svg width="16" height="14" viewBox="0 0 18 16" aria-hidden="true">
      <path
        className="lock-shackle"
        d={locked ? 'M5 7.5V5a3 3 0 0 1 6 0v2.5' : 'M11 7.5V4a3 3 0 0 1 6 0v2'}
        fill="none"
        strokeWidth="1.6"
      />
      <rect className="lock-body" x="3" y="7.5" width="10" height="7.5" rx="1.5" />
    </svg>
  );
}

/**
 * The strip's UTC offset override (SPEC §4.2). Empty — `auto` — means each photo takes
 * the offset inferred for when it was taken, usually from the phone's GPS; a value
 * forces it for the whole strip.
 */
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
      className="offset-field compact"
      value={text}
      disabled={disabled}
      placeholder="auto"
      title="UTC offset for the whole strip, e.g. +02:00. Empty: inferred per photo from GPS-bearing photos."
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
        if (e.key === 'Escape') setText(value === null ? '' : formatUtcOffset(value));
        e.stopPropagation();
      }}
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
      className="offset-field compact"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(formatOffset(value));
        // The lanes beside nudge on arrow keys; inside a text field they belong to the
        // caret.
        e.stopPropagation();
      }}
    />
  );
}
