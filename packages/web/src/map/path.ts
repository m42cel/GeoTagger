import { distanceMeters, type ComputedPosition, type LatLon, type TimelineFile } from '@geotagger/shared';

/**
 * The path line's vertices (SPEC §6.3), in effective-time order: every anchor,
 * plus the farthest extrapolated file before the first anchor and after the last.
 * Interpolated and extrapolated files lie on the great circles between and beyond
 * those points (SPEC §5.1, §5.3), so a geodesic line through them alone passes
 * through every estimate without needing it as a vertex.
 *
 * Files with no effective time cannot take a place in that order, so they are left
 * out. A pending drag with no anchor underneath does not anchor its neighbours
 * (SPEC §5.5) and is left out the same way. A file being *re*-dragged still has its
 * old anchor (`anchorLat`/`Lon`, SPEC §5.6's ghost) doing that work, so the line
 * runs through that point rather than toward where it is being dragged to.
 *
 * The tail ends take the farthest file rather than the outermost one in time
 * because, with the extrapolation cap enabled, files beyond it fall back onto the
 * nearest anchor (SPEC §5.3) — the outermost file in time may sit right on it.
 */
export function pathVertices(
  items: readonly { position: ComputedPosition; timelineFile: TimelineFile | null }[],
): [number, number][] {
  const timed = items
    .filter(
      (i) =>
        i.position.lat !== null &&
        i.position.lon !== null &&
        (i.position.anchorLat !== null || i.position.source !== 'manual') &&
        i.timelineFile?.effectiveMs !== null &&
        i.timelineFile?.effectiveMs !== undefined,
    )
    .sort((a, b) => (a.timelineFile?.effectiveMs as number) - (b.timelineFile?.effectiveMs as number));

  const anchors: LatLon[] = [];
  let firstAnchorIndex = -1;
  let lastAnchorIndex = -1;
  timed.forEach((i, index) => {
    const anchor = anchorOf(i.position);
    if (!anchor) return;
    anchors.push(anchor);
    if (firstAnchorIndex === -1) firstAnchorIndex = index;
    lastAnchorIndex = index;
  });
  if (anchors.length === 0) return [];

  const first = anchors[0] as LatLon;
  const last = anchors[anchors.length - 1] as LatLon;
  const before = farthest(timed.slice(0, firstAnchorIndex), first);
  const after = farthest(timed.slice(lastAnchorIndex + 1), last);
  return [...(before ? [before] : []), ...anchors, ...(after ? [after] : [])].map((p) => [p.lat, p.lon]);
}

function anchorOf(position: ComputedPosition): LatLon | null {
  if (position.anchorLat !== null && position.anchorLon !== null) return { lat: position.anchorLat, lon: position.anchorLon };
  if (position.source === 'camera-gps' || position.source === 'confirmed') {
    return { lat: position.lat as number, lon: position.lon as number };
  }
  return null;
}

function farthest(items: readonly { position: ComputedPosition }[], from: LatLon): LatLon | null {
  let best: LatLon | null = null;
  let bestDistance = 0;
  for (const { position } of items) {
    const point = { lat: position.lat as number, lon: position.lon as number };
    const distance = distanceMeters(from, point);
    if (distance > bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
