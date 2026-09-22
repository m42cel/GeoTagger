import type { OffsetRamp } from '@geotagger/shared';
import { offsetSecondsAt } from '@geotagger/shared';

/**
 * Cutting, merging and pinning (SPEC §4.3).
 *
 * All three are arithmetic on a strip's offset ramp, kept separate from the store so
 * the promise that matters — nothing jumps at the moment of cutting — can be tested
 * directly rather than inferred from a database round trip.
 */

export interface SegmentMember {
  fileId: number;
  /** The file's own wall-clock reading as epoch ms; null when it is undated. */
  rawCaptureMs: number | null;
  /** Where it currently sits on the absolute timeline; null when it is undated. */
  effectiveMs: number | null;
}

export interface SegmentPlan {
  fileIds: number[];
  offsetStartSeconds: number;
  offsetEndSeconds: number;
  firstCaptureMs: number | null;
  lastCaptureMs: number | null;
}

/**
 * Splits a strip at a point on the axis.
 *
 * Membership divides by *effective* time, because that is what the user is looking at
 * when they place the cut. Each segment then takes the parent's offset at its own
 * ends, which is what "inherits the parent's offset at the cut point" means for a
 * stretched strip: the ramp is divided between them and neither side moves.
 *
 * Returns null when everything would land on one side — a cut outside the strip is a
 * no-op, not an empty segment.
 */
export function planCut(
  parent: OffsetRamp,
  members: readonly SegmentMember[],
  atEffectiveMs: number,
): { left: SegmentPlan; right: SegmentPlan } | null {
  const left: SegmentMember[] = [];
  const right: SegmentMember[] = [];
  for (const m of members) {
    // An undated file has no place on the axis, so it stays with the earlier segment
    // rather than being dropped.
    if (m.effectiveMs === null || m.effectiveMs < atEffectiveMs) left.push(m);
    else right.push(m);
  }
  if (left.length === 0 || right.length === 0) return null;
  return { left: planFor(parent, left), right: planFor(parent, right) };
}

function planFor(parent: OffsetRamp, members: readonly SegmentMember[]): SegmentPlan {
  const first = minRaw(members);
  const last = maxRaw(members);
  return {
    fileIds: members.map((m) => m.fileId),
    offsetStartSeconds: round(offsetSecondsAt(parent, first)),
    offsetEndSeconds: round(offsetSecondsAt(parent, last)),
    firstCaptureMs: first,
    lastCaptureMs: last,
  };
}

/**
 * Merges two segments back together (SPEC §4.3): the result ramps from the left
 * segment's start offset to the right segment's end offset, so whatever drift each
 * carried is preserved across the join.
 */
export function planMerge(
  left: Pick<SegmentPlan, 'fileIds' | 'offsetStartSeconds' | 'firstCaptureMs'>,
  right: Pick<SegmentPlan, 'fileIds' | 'offsetEndSeconds' | 'lastCaptureMs'>,
): SegmentPlan {
  return {
    fileIds: [...left.fileIds, ...right.fileIds],
    offsetStartSeconds: left.offsetStartSeconds,
    offsetEndSeconds: right.offsetEndSeconds,
    firstCaptureMs: left.firstCaptureMs,
    lastCaptureMs: right.lastCaptureMs,
  };
}

/**
 * The offsets a strip needs so that one of its files lands on a known true time
 * (SPEC §4.3, "set true time").
 *
 * The whole strip shifts by the same amount, which is what makes this work in both
 * directions: an anchor found in the middle of a bad batch corrects the files before
 * it as well as after it. Any stretch the strip carries is preserved.
 */
export function planPin(
  ramp: Pick<OffsetRamp, 'offsetStartSeconds' | 'offsetEndSeconds'>,
  fileEffectiveMs: number,
  targetEffectiveMs: number,
): { offsetStartSeconds: number; offsetEndSeconds: number } {
  const shift = Math.round((targetEffectiveMs - fileEffectiveMs) / 1000);
  return {
    offsetStartSeconds: ramp.offsetStartSeconds + shift,
    offsetEndSeconds: ramp.offsetEndSeconds + shift,
  };
}

function minRaw(members: readonly SegmentMember[]): number | null {
  let out: number | null = null;
  for (const m of members) {
    if (m.rawCaptureMs !== null && (out === null || m.rawCaptureMs < out)) out = m.rawCaptureMs;
  }
  return out;
}

function maxRaw(members: readonly SegmentMember[]): number | null {
  let out: number | null = null;
  for (const m of members) {
    if (m.rawCaptureMs !== null && (out === null || m.rawCaptureMs > out)) out = m.rawCaptureMs;
  }
  return out;
}

function round(seconds: number): number {
  return Math.round(seconds);
}
