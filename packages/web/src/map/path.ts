import {
  distanceMeters,
  isAnchor,
  type BasePosition,
  type ComputedPosition,
  type FileId,
  type LatLon,
  type TimelineFile,
} from '@geotagger/shared';

/** A corner of the path line, and the file it belongs to — hidden by a filter, it gets a ghost dot. */
export interface PathVertex extends LatLon {
  fileId: FileId;
  effectiveMs: number;
  /** False only for the extrapolated file at either tail end. */
  anchor: boolean;
}

type TimedItem = { position: ComputedPosition & { base: BasePosition }; timelineFile: TimelineFile & { effectiveMs: number } };

/**
 * The path line's vertices (SPEC §6.3), in effective-time order: every anchor,
 * plus the farthest extrapolated file before the first anchor and after the last.
 * Interpolated and extrapolated files lie on the great circles between and beyond
 * those points (SPEC §5.1, §5.3), so a geodesic line through them alone passes
 * through every estimate without needing it as a vertex.
 *
 * Built from each file's own position (`base`), never a drag in progress: a drag
 * anchors nothing (SPEC §5.5), so the line runs through what is underneath it —
 * the old anchor of a re-dragged file, or the estimate a dragged one still has.
 * Files with no effective time cannot take a place in that order, so they are left
 * out.
 *
 * The tail ends take the farthest file rather than the outermost one in time
 * because, with the extrapolation cap enabled, files beyond it fall back onto the
 * nearest anchor (SPEC §5.3) — the outermost file in time may sit right on it.
 */
export function pathVertices(
  items: readonly { position: ComputedPosition; timelineFile: TimelineFile | null }[],
): PathVertex[] {
  const timed = items
    .filter(
      (i): i is TimedItem =>
        i.position.base !== null &&
        i.timelineFile?.effectiveMs !== null &&
        i.timelineFile?.effectiveMs !== undefined,
    )
    .sort((a, b) => a.timelineFile.effectiveMs - b.timelineFile.effectiveMs);

  const anchors: PathVertex[] = [];
  let firstAnchorIndex = -1;
  let lastAnchorIndex = -1;
  timed.forEach((i, index) => {
    if (!isAnchor(i.position)) return;
    anchors.push(vertexOf(i, true));
    if (firstAnchorIndex === -1) firstAnchorIndex = index;
    lastAnchorIndex = index;
  });
  if (anchors.length === 0) return [];

  const first = anchors[0] as PathVertex;
  const last = anchors[anchors.length - 1] as PathVertex;
  const before = farthest(timed.slice(0, firstAnchorIndex), first);
  const after = farthest(timed.slice(lastAnchorIndex + 1), last);
  return [...(before ? [before] : []), ...anchors, ...(after ? [after] : [])];
}

function vertexOf({ position, timelineFile }: TimedItem, anchor: boolean): PathVertex {
  return { lat: position.base.lat, lon: position.base.lon, fileId: position.fileId, effectiveMs: timelineFile.effectiveMs, anchor };
}

function farthest(items: readonly TimedItem[], from: LatLon): PathVertex | null {
  let best: PathVertex | null = null;
  let bestDistance = 0;
  for (const item of items) {
    const distance = distanceMeters(from, item.position.base);
    if (distance > bestDistance) {
      best = vertexOf(item, false);
      bestDistance = distance;
    }
  }
  return best;
}

/** One stretch of the path line between two neighboring corners. */
export interface PathSegment {
  from: PathVertex;
  to: PathVertex;
  distanceM: number;
  durationMs: number;
  /**
   * SPEC §5.2's `v_implied` between two anchors — a lower bound on the average
   * speed, since it takes the straight great circle. Null for a tail segment
   * (its far end is an estimate, not a measurement) and for two anchors at the
   * same instant.
   */
  speedKmh: number | null;
}

/** The path line cut into its segments (SPEC §6.3), each with the speed it was travelled at. */
export function pathSegments(vertices: readonly PathVertex[]): PathSegment[] {
  const segments: PathSegment[] = [];
  for (let i = 1; i < vertices.length; i++) {
    const from = vertices[i - 1] as PathVertex;
    const to = vertices[i] as PathVertex;
    const distanceM = distanceMeters(from, to);
    const durationMs = to.effectiveMs - from.effectiveMs;
    const speedKmh = from.anchor && to.anchor && durationMs > 0 ? distanceM / 1000 / (durationMs / 3_600_000) : null;
    segments.push({ from, to, distanceM, durationMs, speedKmh });
  }
  return segments;
}

const SLOW_KMH = 3;
const FAST_KMH = 150;
/** For segments without a speed, so "unknown" never reads as "slow". */
const NO_SPEED_COLOR = '#333333';

/**
 * Green at walking pace through yellow to red at train speed (SPEC §6.3), on a log
 * scale so walking, cycling and city driving stay apart instead of all reading as
 * the same green next to a motorway.
 */
export function speedColor(speedKmh: number | null): string {
  if (speedKmh === null) return NO_SPEED_COLOR;
  const f = (Math.log(speedKmh) - Math.log(SLOW_KMH)) / (Math.log(FAST_KMH) - Math.log(SLOW_KMH));
  const clamped = Number.isNaN(f) ? 0 : Math.min(1, Math.max(0, f));
  return `hsl(${Math.round(120 * (1 - clamped))}, 85%, 40%)`;
}

/** The segment's hover text (SPEC §6.3), or null for a tail segment, which has nothing to say. */
export function segmentTooltip(segment: PathSegment): string | null {
  if (!segment.from.anchor || !segment.to.anchor) return null;
  const distance = formatDistance(segment.distanceM);
  if (segment.speedKmh === null) return `${distance} · same time`;
  const speed = segment.speedKmh < 10 ? segment.speedKmh.toFixed(1) : Math.round(segment.speedKmh).toString();
  return `≈ ${speed} km/h · ${distance} in ${formatDuration(segment.durationMs)}`;
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return m < 100_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
