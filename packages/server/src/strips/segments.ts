/**
 * Cutting, merging and pinning (SPEC §4.3).
 *
 * All three are arithmetic on a strip's offset, kept separate from the store so the
 * promise that matters — nothing jumps at the moment of cutting — can be tested
 * directly rather than inferred from a database round trip.
 */

export interface SegmentMember {
  fileId: number;
  /** Where it currently sits on the absolute timeline; null when it is undated. */
  effectiveMs: number | null;
}

export interface SegmentPlan {
  fileIds: number[];
  offsetSeconds: number;
}

/**
 * Splits a strip at a point on the axis.
 *
 * Membership divides by *effective* time, because that is what the user is looking at
 * when they place the cut. Both segments keep the parent's offset, which is what makes
 * a cut invisible until one of the two is dragged: a correction is one constant across
 * a strip, so there is no ramp to divide.
 *
 * Returns null when everything would land on one side — a cut outside the strip is a
 * no-op, not an empty segment.
 */
export function planCut(
  parent: { offsetSeconds: number },
  members: readonly SegmentMember[],
  atEffectiveMs: number,
): { left: SegmentPlan; right: SegmentPlan } | null {
  const left: number[] = [];
  const right: number[] = [];
  for (const m of members) {
    // An undated file has no place on the axis, so it stays with the earlier segment
    // rather than being dropped.
    if (m.effectiveMs === null || m.effectiveMs < atEffectiveMs) left.push(m.fileId);
    else right.push(m.fileId);
  }
  if (left.length === 0 || right.length === 0) return null;
  return {
    left: { fileIds: left, offsetSeconds: parent.offsetSeconds },
    right: { fileIds: right, offsetSeconds: parent.offsetSeconds },
  };
}

/**
 * Merges two segments back together (SPEC §4.3). The result takes the left segment's
 * offset: the two were dragged apart independently, and the earlier one is the one the
 * user was looking at when they started.
 */
export function planMerge(
  left: Pick<SegmentPlan, 'fileIds' | 'offsetSeconds'>,
  right: Pick<SegmentPlan, 'fileIds'>,
): SegmentPlan {
  return {
    fileIds: [...left.fileIds, ...right.fileIds],
    offsetSeconds: left.offsetSeconds,
  };
}

/**
 * The offset a strip needs so that one of its files lands on a known true time
 * (SPEC §4.3, "set true time").
 *
 * The whole strip shifts by the same amount, which is what makes this work in both
 * directions: an anchor found in the middle of a bad batch corrects the files before
 * it as well as after it.
 */
export function planPin(
  strip: { offsetSeconds: number },
  fileEffectiveMs: number,
  targetEffectiveMs: number,
): number {
  return strip.offsetSeconds + Math.round((targetEffectiveMs - fileEffectiveMs) / 1000);
}
