import { MINUTE_MS } from './time.js';

/**
 * Magnetic snapping while a strip is dragged (SPEC §4.3).
 *
 * Two quite different things pull: the photos of other lanes, because lining up two
 * devices' shots of the same moment *is* the correction, and whole minutes and hours,
 * because a timezone error is exactly a whole number of hours and a user who means
 * "+2h" should not land on "+1h 59m 58s".
 */
export type SnapKind = 'none' | 'photo' | 'minute' | 'hour';

export interface SnapResult {
  offsetSeconds: number;
  kind: SnapKind;
  /** How far the snap moved the strip from where the pointer put it, in seconds. */
  adjustmentSeconds: number;
}

export interface SnapInput {
  /** The offset the pointer alone would produce, in seconds. */
  candidateOffsetSeconds: number;
  /**
   * Absolute instants of the dragged strip's files at `candidateOffsetSeconds`,
   * ascending. Sample rather than pass thousands: the pull is the same.
   */
  movingMs: readonly number[];
  /** Absolute instants of every file in other lanes, ascending. */
  targetMs: readonly number[];
  /** How close counts as close, in milliseconds — derived from the current zoom. */
  toleranceMs: number;
  /** `Alt` while dragging disables snapping entirely (SPEC §4.3). */
  enabled: boolean;
}

/**
 * Whole-unit snapping is deliberately *not* allowed to use the full pixel tolerance.
 *
 * At trip zoom one pixel covers minutes, so an unclamped hour snap would make every
 * drag jump to the nearest hour and the strip would be impossible to place by hand.
 */
const MAX_MINUTE_SNAP_SECONDS = 20;
const MAX_HOUR_SNAP_SECONDS = 300;

export function computeSnap(input: SnapInput): SnapResult {
  const base: SnapResult = {
    offsetSeconds: input.candidateOffsetSeconds,
    kind: 'none',
    adjustmentSeconds: 0,
  };
  if (!input.enabled || input.toleranceMs <= 0) return base;

  const candidates: SnapResult[] = [];

  const photo = nearestPhotoAdjustmentMs(input.movingMs, input.targetMs, input.toleranceMs);
  if (photo !== null) {
    candidates.push({
      offsetSeconds: input.candidateOffsetSeconds + photo / 1000,
      kind: 'photo',
      adjustmentSeconds: Math.abs(photo) / 1000,
    });
  }

  const toleranceSeconds = input.toleranceMs / 1000;
  addUnitSnap(candidates, input.candidateOffsetSeconds, 3600, Math.min(toleranceSeconds, MAX_HOUR_SNAP_SECONDS), 'hour');
  addUnitSnap(candidates, input.candidateOffsetSeconds, 60, Math.min(toleranceSeconds, MAX_MINUTE_SNAP_SECONDS), 'minute');

  if (candidates.length === 0) return base;

  // Smallest correction wins; on a tie the coarser unit does, because a drag that is
  // equally close to a whole hour and to a neighbouring photo almost always meant the
  // hour.
  const rank: Record<SnapKind, number> = { hour: 0, minute: 1, photo: 2, none: 3 };
  candidates.sort(
    (a, b) => a.adjustmentSeconds - b.adjustmentSeconds || rank[a.kind] - rank[b.kind],
  );
  return candidates[0] as SnapResult;
}

function addUnitSnap(
  out: SnapResult[],
  candidateOffsetSeconds: number,
  unitSeconds: number,
  toleranceSeconds: number,
  kind: SnapKind,
): void {
  if (toleranceSeconds <= 0) return;
  const snapped = Math.round(candidateOffsetSeconds / unitSeconds) * unitSeconds;
  const delta = snapped - candidateOffsetSeconds;
  if (Math.abs(delta) <= toleranceSeconds) {
    out.push({ offsetSeconds: snapped, kind, adjustmentSeconds: Math.abs(delta) });
  }
}

/**
 * The smallest shift that would put one of the dragged strip's files onto one of the
 * target instants, or null when nothing is within tolerance.
 *
 * Both arrays are ascending, so the search walks them together rather than comparing
 * every pair — a lane can hold thousands of files and this runs on every pointer move.
 */
function nearestPhotoAdjustmentMs(
  movingMs: readonly number[],
  targetMs: readonly number[],
  toleranceMs: number,
): number | null {
  if (movingMs.length === 0 || targetMs.length === 0) return null;
  let best: number | null = null;
  let j = 0;
  for (const m of movingMs) {
    while (j + 1 < targetMs.length && Math.abs((targetMs[j + 1] as number) - m) <= Math.abs((targetMs[j] as number) - m)) {
      j += 1;
    }
    const delta = (targetMs[j] as number) - m;
    if (Math.abs(delta) <= toleranceMs && (best === null || Math.abs(delta) < Math.abs(best))) {
      best = delta;
    }
  }
  return best;
}

/**
 * Thins a sorted instant list down to at most `max` entries, evenly across its length.
 *
 * Snapping against every file in a 3,000-file strip would cost more than it is worth:
 * an evenly spread sample pulls in the same places, because the places that matter are
 * bursts of shooting, and a burst survives thinning.
 */
export function sampleInstants(sorted: readonly number[], max: number): number[] {
  if (sorted.length <= max) return [...sorted];
  const step = sorted.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) out.push(sorted[Math.floor(i * step)] as number);
  return out;
}

/** Keyboard nudge steps of SPEC §4.3: plain 1 s, Shift 1 min, Ctrl/Cmd 1 hour. */
export function nudgeSeconds(modifiers: { shift?: boolean; ctrlOrMeta?: boolean }): number {
  if (modifiers.ctrlOrMeta === true) return 3600;
  if (modifiers.shift === true) return 60;
  return 1;
}

/** A sensible snap tolerance for the current zoom: a few pixels, in milliseconds. */
export function snapToleranceMs(msPerPixel: number, pixels = 6): number {
  return Math.max(MINUTE_MS / 60, msPerPixel * pixels);
}

export interface StretchSnapInput {
  /** The drift the pointer alone would produce, stretching about `pivotRawMs`. */
  candidateDrift: number;
  pivotRawMs: number;
  /** Raw reading of the file under the dragged handle — where the tolerance is measured. */
  handleRawMs: number;
  /**
   * The stretched strip's files at `candidateDrift`, ascending by `ms`: raw reading and
   * absolute instant. Sample rather than pass thousands, as for a move.
   */
  moving: readonly { rawMs: number; ms: number }[];
  /** Absolute instants of every file in other lanes, ascending. */
  targetMs: readonly number[];
  toleranceMs: number;
  enabled: boolean;
}

/**
 * Magnetic snapping while a strip is stretched about its pin (SPEC §4.3).
 *
 * A stretch moves each file in proportion to its distance from the pin, so the pull is
 * judged by how far the *handle* would have to move to land a file on a photo of
 * another lane — measuring it at the file instead would let a file a minute from the
 * pin, which barely moves, yank the far end of the strip by hours. Only photos pull:
 * drift is never a whole minute or hour.
 */
export function computeStretchSnap(input: StretchSnapInput): { drift: number; snapped: boolean } {
  const base = { drift: input.candidateDrift, snapped: false };
  const reach = input.handleRawMs - input.pivotRawMs;
  if (!input.enabled || input.toleranceMs <= 0 || reach === 0 || input.targetMs.length === 0) return base;

  let best: { drift: number; handleMoveMs: number } | null = null;
  let j = 0;
  for (const m of input.moving) {
    const lever = m.rawMs - input.pivotRawMs;
    if (lever === 0) continue;
    while (
      j + 1 < input.targetMs.length &&
      Math.abs((input.targetMs[j + 1] as number) - m.ms) <= Math.abs((input.targetMs[j] as number) - m.ms)
    ) {
      j += 1;
    }
    const deltaDrift = ((input.targetMs[j] as number) - m.ms) / lever;
    const handleMoveMs = Math.abs(deltaDrift * reach);
    if (handleMoveMs <= input.toleranceMs && (best === null || handleMoveMs < best.handleMoveMs)) {
      best = { drift: input.candidateDrift + deltaDrift, handleMoveMs };
    }
  }
  return best === null ? base : { drift: best.drift, snapped: true };
}
