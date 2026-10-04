import { Fragment } from 'react';
import type { FileId, FileRecord, TimelineFile } from '@geotagger/shared';
import { lowerBound, msAt, xOf, type TimeScale } from './scale.js';

/**
 * One strip drawn on the shared axis (SPEC §6.2).
 *
 * Always photo content: thumbnails at every zoom, collapsing into counted stacks
 * where they collide, because recognising a shared moment is what aligning by hand
 * asks of the picture.
 *
 * Rendering is virtualised: only files inside the visible window are drawn, so a lane
 * holding thousands of files stays responsive.
 */

/**
 * Height of a lane row. Everything vertical below is derived from it, so a frame
 * fills the strip it sits in rather than floating in its top half.
 */
const LANE_ROW_PX = 136;
/**
 * What a frame has to clear inside the row: `.strip-hit` sits 4 px in and draws a
 * 1 px border, and a selected frame paints a 2 px ring outside itself. Leaving room
 * for both is what keeps a selection from crossing the strip's own border.
 */
const FRAME_INSET_PX = 5;
const SELECT_RING_PX = 2;
const THUMB_TOP_PX = FRAME_INSET_PX + SELECT_RING_PX;
/**
 * Width of a thumbnail on the axis, and the spacing at which they collide. It is the
 * lane's height less that clearance top and bottom: big enough that two photos of the
 * same beach can be told apart, which is what aligning by content asks of them.
 */
const THUMB_PX = LANE_ROW_PX - 2 * THUMB_TOP_PX;

export const STRIP_LANE_ROW_PX = LANE_ROW_PX;
/**
 * A frame is centred on its instant, so it reaches half its width either side of it.
 * The strip's own frame has to be padded by at least that much or its first and last
 * thumbnails hang outside it.
 */
export const STRIP_THUMB_HALF_PX = THUMB_PX / 2;

export interface StripFiles {
  /** The strip's files in effective-time order. */
  files: TimelineFile[];
  /** Their effective instants, ascending — the array the virtualiser searches. */
  instants: number[];
}

export function buildStripFiles(files: readonly TimelineFile[]): Map<number, StripFiles> {
  const out = new Map<number, StripFiles>();
  for (const f of files) {
    if (f.stripId === null || f.effectiveMs === null) continue;
    const bucket = out.get(f.stripId);
    if (bucket) bucket.files.push(f);
    else out.set(f.stripId, { files: [f], instants: [] });
  }
  for (const bucket of out.values()) {
    bucket.files.sort((a, b) => (a.effectiveMs as number) - (b.effectiveMs as number));
    bucket.instants = bucket.files.map((f) => f.effectiveMs as number);
  }
  return out;
}

export function StripBody({
  stripFiles,
  stretchedInstants,
  scale,
  fileById,
  selectedFileIds,
  pinnedFileIds,
  activeFileId,
  onTogglePin,
  onSelectFile,
  onSetTrueTime,
}: {
  stripFiles: StripFiles | undefined;
  /**
   * Where the files are drawn while a stretch is being dragged — same order as
   * `stripFiles.instants` — or undefined to draw them where they are.
   */
  stretchedInstants?: readonly number[];
  scale: TimeScale;
  fileById: Map<FileId, FileRecord>;
  selectedFileIds: ReadonlySet<FileId>;
  pinnedFileIds: readonly FileId[];
  /** The photo the photo card describes; its thumbnail carries the pin button. */
  activeFileId: FileId | null;
  /** Null while the strip is locked, which hides the pin button. */
  onTogglePin: ((fileId: FileId) => void) | null;
  onSelectFile: (fileId: FileId, additive: boolean) => void;
  onSetTrueTime: (fileId: FileId) => void;
}) {
  if (!stripFiles || stripFiles.instants.length === 0) {
    return <div className="strip-body empty" style={{ height: LANE_ROW_PX }} />;
  }

  // A move is one constant across the strip, so the whole element is translated during
  // a body drag and these instants never move under it; a stretch moves each file by a
  // different amount, so it passes the files' new instants in instead. Either way they
  // stay ascending — a stretch never reverses a clock — and the visible slice is found
  // by binary search rather than by scanning the whole strip.
  const positions = stretchedInstants ?? stripFiles.instants;
  const from = Math.max(0, lowerBound(positions, msAt(scale, -THUMB_PX)) - 1);
  const to = Math.min(positions.length, lowerBound(positions, msAt(scale, scale.widthPx + THUMB_PX)) + 1);

  return (
    <Thumbnails
      positions={positions}
      files={stripFiles.files}
      from={from}
      to={to}
      scale={scale}
      fileById={fileById}
      selectedFileIds={selectedFileIds}
      pinnedFileIds={pinnedFileIds}
      activeFileId={activeFileId}
      onTogglePin={onTogglePin}
      onSelectFile={onSelectFile}
      onSetTrueTime={onSetTrueTime}
    />
  );
}

/**
 * Colliding thumbnails collapse into a stack with a count, and separate as the axis
 * is zoomed in (SPEC §6.2).
 */
function Thumbnails({
  positions,
  files,
  from,
  to,
  scale,
  fileById,
  selectedFileIds,
  pinnedFileIds,
  activeFileId,
  onTogglePin,
  onSelectFile,
  onSetTrueTime,
}: {
  positions: readonly number[];
  files: readonly TimelineFile[];
  from: number;
  to: number;
  scale: TimeScale;
  fileById: Map<FileId, FileRecord>;
  selectedFileIds: ReadonlySet<FileId>;
  pinnedFileIds: readonly FileId[];
  activeFileId: FileId | null;
  onTogglePin: ((fileId: FileId) => void) | null;
  onSelectFile: (fileId: FileId, additive: boolean) => void;
  onSetTrueTime: (fileId: FileId) => void;
}) {
  const clusters: { fileId: FileId; x: number; count: number; selected: boolean; pinned: boolean }[] = [];
  for (let i = from; i < to; i += 1) {
    const x = xOf(scale, positions[i] as number);
    const file = files[i] as TimelineFile;
    const pinned = pinnedFileIds.includes(file.id);
    const last = clusters[clusters.length - 1];
    if (last && x - last.x < THUMB_PX) {
      last.count += 1;
      // A pin is a reference point; a stack hiding one still says it holds one.
      if (pinned) last.pinned = true;
      // A selected file always represents its own stack, so selection stays visible
      // as the axis is zoomed out.
      if (selectedFileIds.has(file.id)) {
        last.fileId = file.id;
        last.selected = true;
      }
      continue;
    }
    clusters.push({ fileId: file.id, x, count: 1, selected: selectedFileIds.has(file.id), pinned });
  }

  return (
    <div className="strip-body" style={{ height: LANE_ROW_PX }}>
      {clusters.map((c) => {
        const record = fileById.get(c.fileId);
        const left = c.x - THUMB_PX / 2;
        const pinned = pinnedFileIds.includes(c.fileId);
        return (
          <Fragment key={c.fileId}>
            <button
              type="button"
              className={`shot${c.selected ? ' selected' : ''}`}
              style={{ left, top: THUMB_TOP_PX, width: THUMB_PX, height: THUMB_PX }}
              title={record?.filename ?? ''}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => onSelectFile(c.fileId, e.ctrlKey || e.metaKey || e.shiftKey)}
              onContextMenu={(e) => {
                // Right-click offers "set true time" (SPEC §4.3).
                e.preventDefault();
                onSelectFile(c.fileId, false);
                onSetTrueTime(c.fileId);
              }}
            >
              <img src={`/api/files/${c.fileId}/thumb`} alt="" loading="lazy" draggable={false} />
              {c.pinned && <span className="pin-badge">pinned</span>}
              {c.count > 1 && <span className="stack-count">{c.count}</span>}
            </button>
            {/* A sibling, not a child: a button cannot sit inside the thumbnail's button. */}
            {c.fileId === activeFileId && onTogglePin !== null && (
              <button
                type="button"
                className={`shot-pin keeps-mark${pinned ? ' on' : ''}`}
                style={{ left: left + PIN_INSET_PX, top: THUMB_TOP_PX + THUMB_PX - PIN_BUTTON_PX - PIN_INSET_PX }}
                aria-label={pinned ? 'Unpin' : 'Pin'}
                aria-pressed={pinned}
                title={
                  pinned
                    ? 'Unpin (p): this photo may move with its strip again'
                    : "Pin (p): this photo's time is right. One pin turns the strip's moves into stretches about it; two fix it."
                }
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onTogglePin(c.fileId)}
              >
                <PinIcon />
              </button>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

const PIN_BUTTON_PX = 24;
const PIN_INSET_PX = 4;

/** A pushpin: outlined, and filled once the photo is pinned (by CSS on the button). */
function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        className="pin-head"
        d="M9 3h6l-1 6 3.5 3.5h-11L10 9z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 12.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
