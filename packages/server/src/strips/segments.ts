import type { ClockCorrection, FileId } from '@geotagger/shared';

/**
 * Cutting, merging and setting a true time (SPEC §4.3).
 *
 * All three are arithmetic on a strip's correction, kept separate from the store so the
 * promise that matters — nothing jumps at the moment of cutting — can be tested
 * directly rather than inferred from a database round trip.
 */

export interface SegmentMember {
  fileId: FileId;
  /** Where it currently sits on the absolute timeline; null when it is undated. */
  effectiveMs: number | null;
}

export interface SegmentPlan {
  fileIds: FileId[];
  correction: ClockCorrection;
}

/**
 * Splits a strip at a point on the axis.
 *
 * Membership divides by *effective* time, because that is what the user is looking at
 * when they place the cut. Both segments keep the parent's whole correction — offset,
 * drift and its origin — which is what makes a cut invisible until one of the two is
 * dragged: each file is still evaluated on the same line it was on before.
 *
 * Returns null when everything would land on one side — a cut outside the strip is a
 * no-op, not an empty segment.
 */
export function planCut(
  parent: ClockCorrection,
  members: readonly SegmentMember[],
  atEffectiveMs: number,
): { left: SegmentPlan; right: SegmentPlan } | null {
  const left: FileId[] = [];
  const right: FileId[] = [];
  for (const m of members) {
    // An undated file has no place on the axis, so it stays with the earlier segment
    // rather than being dropped.
    if (m.effectiveMs === null || m.effectiveMs < atEffectiveMs) left.push(m.fileId);
    else right.push(m.fileId);
  }
  if (left.length === 0 || right.length === 0) return null;
  return {
    left: { fileIds: left, correction: correctionOf(parent) },
    right: { fileIds: right, correction: correctionOf(parent) },
  };
}

/**
 * Merges two segments back together (SPEC §4.3). The result takes the left segment's
 * correction: the two were dragged apart independently, and the earlier one is the one
 * the user was looking at when they started.
 */
export function planMerge(left: SegmentPlan, right: Pick<SegmentPlan, 'fileIds'>): SegmentPlan {
  return {
    fileIds: [...left.fileIds, ...right.fileIds],
    correction: correctionOf(left.correction),
  };
}

/** Just the correction of something that carries one, so a strip record is not copied whole. */
export function correctionOf(c: ClockCorrection): ClockCorrection {
  return { offsetSeconds: c.offsetSeconds, drift: c.drift, driftOriginMs: c.driftOriginMs };
}

/**
 * The offset a strip needs so that one of its files lands on a known true time
 * (SPEC §4.3, "set true time").
 *
 * The whole strip shifts by the same amount, which is what makes this work in both
 * directions: an anchor found in the middle of a bad batch corrects the files before
 * it as well as after it. Adding to the offset shifts a stretched strip whole too, so
 * this holds with drift as well.
 */
export function planTrueTime(
  strip: { offsetSeconds: number },
  fileEffectiveMs: number,
  targetEffectiveMs: number,
): number {
  return strip.offsetSeconds + Math.round((targetEffectiveMs - fileEffectiveMs) / 1000);
}
