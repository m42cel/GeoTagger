/**
 * Lane management (SPEC §4.3).
 *
 * A lane is one horizontal row of the alignment view. Strips inside a lane must stay
 * ordered and must not overlap in effective time — that is what makes a lane readable
 * as one device's timeline. Dragging a cut segment past its sibling breaks that, so
 * the moved segment is promoted to a lane of its own, and lanes left empty collapse.
 */

export interface LanePlacement {
  id: number;
  lane: number;
  ordinal: number;
  /** Bounds on the absolute timeline; null for a strip holding no dated file. */
  firstMs: number | null;
  lastMs: number | null;
}

/** Two strips overlap when their effective spans intersect. Undated strips never do. */
export function overlaps(a: LanePlacement, b: LanePlacement): boolean {
  if (a.firstMs === null || a.lastMs === null || b.firstMs === null || b.lastMs === null) {
    return false;
  }
  return a.firstMs <= b.lastMs && b.firstMs <= a.lastMs;
}

/**
 * Settles the lane layout after a change, and reports the lane the moved strip ended
 * up in.
 *
 * `movedId` is the strip the user just dragged or stretched. It is the one that gets
 * promoted on a collision, because the strips it collided with were where they were
 * first — moving those instead would shuffle the view out from under the gesture.
 */
export function arrangeLanes(
  placements: readonly LanePlacement[],
  movedId: number | null = null,
): LanePlacement[] {
  const working = placements.map((p) => ({ ...p }));
  const moved = movedId === null ? null : working.find((p) => p.id === movedId) ?? null;

  if (moved) {
    const collides = working.some((p) => p.id !== moved.id && p.lane === moved.lane && overlaps(p, moved));
    if (collides) {
      // A new lane immediately below the one it came from: close to where the user
      // dropped it, rather than at the bottom of a tall stack of lanes.
      const newLane = moved.lane + 1;
      for (const p of working) {
        if (p.id !== moved.id && p.lane >= newLane) p.lane += 1;
      }
      moved.lane = newLane;
    }
  }

  return collapseEmptyLanes(orderWithinLanes(working));
}

/** Orders each lane left to right by effective time, undated strips last. */
function orderWithinLanes(placements: LanePlacement[]): LanePlacement[] {
  const byLane = new Map<number, LanePlacement[]>();
  for (const p of placements) {
    const bucket = byLane.get(p.lane);
    if (bucket) bucket.push(p);
    else byLane.set(p.lane, [p]);
  }
  for (const bucket of byLane.values()) {
    bucket.sort((a, b) => {
      if (a.firstMs === b.firstMs) return a.id - b.id;
      if (a.firstMs === null) return 1;
      if (b.firstMs === null) return -1;
      return a.firstMs - b.firstMs;
    });
    bucket.forEach((p, i) => {
      p.ordinal = i;
    });
  }
  return placements;
}

/** Renumbers lanes 0..n-1 in their existing order, so a vacated lane closes up. */
export function collapseEmptyLanes(placements: LanePlacement[]): LanePlacement[] {
  const used = [...new Set(placements.map((p) => p.lane))].sort((a, b) => a - b);
  const remap = new Map(used.map((lane, i) => [lane, i]));
  for (const p of placements) p.lane = remap.get(p.lane) as number;
  return placements.sort((a, b) => a.lane - b.lane || a.ordinal - b.ordinal);
}

/**
 * The lane a strip can be dropped into without colliding, or a new one.
 *
 * Used when a segment is dragged vertically on purpose: the drop is honoured if it
 * fits, and otherwise the strip goes to a lane of its own rather than silently landing
 * on top of something.
 */
export function laneAccepts(
  placements: readonly LanePlacement[],
  strip: LanePlacement,
  lane: number,
): boolean {
  return !placements.some((p) => p.id !== strip.id && p.lane === lane && overlaps(p, strip));
}
