/**
 * Wheel-gesture handling for the alignment view's canvas (SPEC §6.2).
 *
 * A trackpad swipe arrives as dozens of wheel events, each with its own small
 * deltaX/deltaY. Picking pan vs. zoom per event, from whichever axis leads on that
 * one event, makes a diagonal swipe flicker between the two and treats a few degrees
 * of drift as a deliberate vertical swipe. Deciding the axis once, at the first event
 * of a gesture, and holding it until the events pause, keeps a swipe committed to
 * whatever it started as.
 */

export type WheelAxis = 'horizontal' | 'vertical';

export interface WheelGestureState {
  axis: WheelAxis;
  lastEventMs: number;
}

/** Wheel events belong to the same gesture while they keep arriving this close together. */
const GESTURE_PAUSE_MS = 150;

/**
 * Picks the axis for one wheel event: continues the current gesture's axis while
 * events keep arriving within GESTURE_PAUSE_MS of each other, or starts a fresh
 * gesture keyed to this event's own dominant axis once they've paused.
 */
export function nextWheelAxis(
  prev: WheelGestureState | null,
  deltaX: number,
  deltaY: number,
  nowMs: number,
): WheelGestureState {
  if (prev !== null && nowMs - prev.lastEventMs < GESTURE_PAUSE_MS) {
    return { axis: prev.axis, lastEventMs: nowMs };
  }
  return { axis: Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical', lastEventMs: nowMs };
}

/** Pixels a line/page delta is assumed to cover, for browsers that don't report deltaMode 0. */
const LINE_PX = 16;
const PAGE_PX = 800;

/**
 * Normalises a wheel event's delta to pixels regardless of `deltaMode` — most
 * browsers already report pixels for trackpad/mouse wheels, but some fall back to
 * counting lines or pages, and mixing those units with the rest of the math below
 * would make the same physical swipe pan or zoom by a wildly different amount.
 */
export function normaliseWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * LINE_PX; // DOM_DELTA_LINE
  if (deltaMode === 2) return delta * PAGE_PX; // DOM_DELTA_PAGE
  return delta; // DOM_DELTA_PIXEL
}

/**
 * Tuned so one mouse-wheel notch (deltaY ≈ 100px in pixel mode) lands on the same
 * ×1.15 step the view used before zoom became proportional, so a mouse wheel still
 * feels the same; a trackpad's much smaller per-event deltas now scale down with it
 * instead of each firing a full step.
 */
const ZOOM_K = Math.log(1.15) / 100;

/** The zoom factor for a vertical wheel delta (already normalised to pixels). */
export function wheelZoomFactor(deltaYPx: number): number {
  return Math.exp(deltaYPx * ZOOM_K);
}
