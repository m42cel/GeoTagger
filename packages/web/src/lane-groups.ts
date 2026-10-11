import type { StripRecord } from '@geotagger/shared';

/** One lane as the file grid and the map's filter show it: a group, whatever its segments. */
export interface LaneGroup {
  lane: number;
  /** Its strips' labels, each once — the segments of one cut strip all share theirs. */
  label: string;
  stripIds: number[];
}

/** One group per non-empty lane, top to bottom, its strips in their order along the lane. */
export function laneGroups(strips: readonly StripRecord[]): LaneGroup[] {
  const byLane = new Map<number, StripRecord[]>();
  for (const strip of strips) {
    const list = byLane.get(strip.lane);
    if (list) list.push(strip);
    else byLane.set(strip.lane, [strip]);
  }
  return [...byLane.entries()]
    .sort(([a], [b]) => a - b)
    .map(([lane, members]) => {
      members.sort((a, b) => a.ordinal - b.ordinal);
      return {
        lane,
        label: [...new Set(members.map((s) => s.label))].join(', '),
        stripIds: members.map((s) => s.id),
      };
    });
}
