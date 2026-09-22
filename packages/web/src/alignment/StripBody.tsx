import { useMemo } from 'react';
import type { FileRecord, StripRecord, TimelineFile } from '@geotagger/shared';
import { offsetSecondsAt } from '@geotagger/shared';
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
const LANE_ROW_PX = 116;
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

/** A candidate ramp being dragged, before it has been committed to the server. */
export interface PreviewRamp {
  offsetStartSeconds: number;
  offsetEndSeconds: number;
}

export function StripBody({
  strip,
  stripFiles,
  scale,
  preview,
  fileById,
  selectedFileIds,
  onSelectFile,
  onPinFile,
}: {
  strip: StripRecord;
  stripFiles: StripFiles | undefined;
  scale: TimeScale;
  /** Non-null only while a stretch is in progress; a body drag moves the whole element. */
  preview: PreviewRamp | null;
  fileById: Map<number, FileRecord>;
  selectedFileIds: ReadonlySet<number>;
  onSelectFile: (fileId: number, additive: boolean) => void;
  onPinFile: (fileId: number) => void;
}) {
  const positions = useMemo(() => {
    if (!stripFiles) return [];
    if (preview === null) return stripFiles.instants;
    // A stretch changes each file's correction by a different amount, so the whole
    // strip is repositioned rather than translated.
    const ramp = { ...preview, firstCaptureMs: strip.firstCaptureMs, lastCaptureMs: strip.lastCaptureMs };
    return stripFiles.files.map((f) => {
      const base = (f.effectiveMs as number) - f.offsetSeconds * 1000;
      return base + offsetSecondsAt(ramp, f.rawCaptureMs) * 1000;
    });
  }, [stripFiles, preview, strip.firstCaptureMs, strip.lastCaptureMs]);

  if (!stripFiles || positions.length === 0) {
    return <div className="strip-body empty" style={{ height: LANE_ROW_PX }} />;
  }

  // Positions stay ascending under any ramp the UI can produce, so the visible slice
  // is found by binary search rather than by scanning the whole strip.
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
      onSelectFile={onSelectFile}
      onPinFile={onPinFile}
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
  onSelectFile,
  onPinFile,
}: {
  positions: readonly number[];
  files: readonly TimelineFile[];
  from: number;
  to: number;
  scale: TimeScale;
  fileById: Map<number, FileRecord>;
  selectedFileIds: ReadonlySet<number>;
  onSelectFile: (fileId: number, additive: boolean) => void;
  onPinFile: (fileId: number) => void;
}) {
  const clusters: { fileId: number; x: number; count: number; selected: boolean }[] = [];
  for (let i = from; i < to; i += 1) {
    const x = xOf(scale, positions[i] as number);
    const file = files[i] as TimelineFile;
    const last = clusters[clusters.length - 1];
    if (last && x - last.x < THUMB_PX) {
      last.count += 1;
      // A selected file always represents its own stack, so selection stays visible
      // as the axis is zoomed out.
      if (selectedFileIds.has(file.id)) {
        last.fileId = file.id;
        last.selected = true;
      }
      continue;
    }
    clusters.push({ fileId: file.id, x, count: 1, selected: selectedFileIds.has(file.id) });
  }

  return (
    <div className="strip-body" style={{ height: LANE_ROW_PX }}>
      {clusters.map((c) => {
        const record = fileById.get(c.fileId);
        return (
          <button
            type="button"
            key={c.fileId}
            className={`shot${c.selected ? ' selected' : ''}`}
            style={{ left: c.x - THUMB_PX / 2, top: THUMB_TOP_PX, width: THUMB_PX, height: THUMB_PX }}
            title={record?.filename ?? ''}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => onSelectFile(c.fileId, e.ctrlKey || e.metaKey || e.shiftKey)}
            onContextMenu={(e) => {
              // Right-click offers "set true time" (SPEC §4.3).
              e.preventDefault();
              onSelectFile(c.fileId, false);
              onPinFile(c.fileId);
            }}
          >
            <img src={`/api/files/${c.fileId}/thumb`} alt="" loading="lazy" draggable={false} />
            {c.count > 1 && <span className="stack-count">{c.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
