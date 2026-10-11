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
}

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
      (i): i is { position: ComputedPosition & { base: BasePosition }; timelineFile: TimelineFile } =>
        i.position.base !== null &&
        i.timelineFile?.effectiveMs !== null &&
        i.timelineFile?.effectiveMs !== undefined,
    )
    .sort((a, b) => (a.timelineFile.effectiveMs as number) - (b.timelineFile.effectiveMs as number));

  const anchors: PathVertex[] = [];
  let firstAnchorIndex = -1;
  let lastAnchorIndex = -1;
  timed.forEach((i, index) => {
    if (!isAnchor(i.position)) return;
    anchors.push(vertexOf(i.position));
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

function vertexOf(position: ComputedPosition & { base: BasePosition }): PathVertex {
  return { lat: position.base.lat, lon: position.base.lon, fileId: position.fileId };
}

function farthest(items: readonly { position: ComputedPosition & { base: BasePosition } }[], from: LatLon): PathVertex | null {
  let best: PathVertex | null = null;
  let bestDistance = 0;
  for (const { position } of items) {
    const distance = distanceMeters(from, position.base);
    if (distance > bestDistance) {
      best = vertexOf(position);
      bestDistance = distance;
    }
  }
  return best;
}
