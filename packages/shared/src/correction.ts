import { DAY_MS } from './time.js';

/**
 * A strip's clock correction (SPEC §4.3): an offset, plus a drift for a clock that ran
 * at the wrong rate.
 *
 * ```
 * shift(f) = offset + drift · (t_f − drift_origin)
 * ```
 *
 * `t_f` is the file's raw wall-clock reading, so the line is laid along the camera's
 * own clock. It lives in the shared package for the same reason `effectiveMs` does: the
 * browser evaluates it on every pointer move while a strip is being stretched.
 */
export interface ClockCorrection {
  offsetSeconds: number;
  /** Seconds gained per second of raw time; 0 for a plain offset. */
  drift: number;
  /** The raw instant, epoch ms, at which the drift term is zero; null while drift is 0. */
  driftOriginMs: number | null;
}

/**
 * The largest drift a stretch may reach, either way — about 72 minutes a day. Far beyond
 * any real clock, but a stretch further than that is a handle grabbed a pixel from its
 * pin.
 */
export const MAX_DRIFT = 0.05;

/** How far the correction moves a file whose raw reading is `rawMs`, in seconds. */
export function shiftSecondsAt(correction: ClockCorrection, rawMs: number): number {
  if (correction.drift === 0 || correction.driftOriginMs === null) return correction.offsetSeconds;
  return correction.offsetSeconds + (correction.drift * (rawMs - correction.driftOriginMs)) / 1000;
}

/**
 * The same correction with its drift origin moved to `originMs`.
 *
 * Nothing moves: the offset absorbs the difference. Putting the origin on the pinned
 * file is what lets a stretch change only `drift` and leave that file exactly in place.
 */
export function rebaseCorrection(correction: ClockCorrection, originMs: number): ClockCorrection {
  return {
    offsetSeconds: shiftSecondsAt(correction, originMs),
    drift: correction.drift,
    driftOriginMs: originMs,
  };
}

/**
 * Stretches a correction about a pivot so the file at `fileRawMs` moves by
 * `deltaSeconds` and the file at `pivotRawMs` does not move at all (SPEC §4.3).
 *
 * Returns null when the two are the same instant on the camera's clock, which no
 * stretch can separate.
 */
export function stretchAbout(
  correction: ClockCorrection,
  pivotRawMs: number,
  fileRawMs: number,
  deltaSeconds: number,
): ClockCorrection | null {
  if (fileRawMs === pivotRawMs) return null;
  const base = rebaseCorrection(correction, pivotRawMs);
  const target = shiftSecondsAt(correction, fileRawMs) + deltaSeconds;
  return {
    offsetSeconds: base.offsetSeconds,
    drift: ((target - base.offsetSeconds) * 1000) / (fileRawMs - pivotRawMs),
    driftOriginMs: pivotRawMs,
  };
}

/** True when a drift is within what a stretch may reach. */
export function driftAllowed(drift: number): boolean {
  return Number.isFinite(drift) && Math.abs(drift) <= MAX_DRIFT;
}

/**
 * A drift as the alignment view writes it, in whichever unit reads naturally:
 * `+14 s/day`, `-2.5 s/day`, `+6.5 min/day`, `+1.2 h/day`, `0`.
 */
export function formatDrift(drift: number): string {
  const perDay = (drift * DAY_MS) / 1000;
  const abs = Math.abs(perDay);
  const [value, unit] = abs >= 3600 ? [perDay / 3600, 'h'] : abs >= 60 ? [perDay / 60, 'min'] : [perDay, 's'];
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : ''}${rounded} ${unit}/day`;
}
