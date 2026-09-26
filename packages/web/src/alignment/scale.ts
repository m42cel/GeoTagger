import { DAY_MS, HOUR_MS, MINUTE_MS } from '@geotagger/shared';

/**
 * The shared time axis of SPEC §4.3.
 *
 * The axis is proportional to real time — thumbnails sit at their actual timestamps,
 * never evenly spaced — because that is what makes dragging mean something: *n* pixels
 * is a definite number of seconds. Everything here is arithmetic on that one promise.
 */

export interface TimeScale {
  /** Instant at the left edge of the viewport. */
  startMs: number;
  /** Milliseconds per pixel; the whole of the zoom. */
  msPerPx: number;
  widthPx: number;
}

export function xOf(scale: TimeScale, ms: number): number {
  return (ms - scale.startMs) / scale.msPerPx;
}

export function msAt(scale: TimeScale, x: number): number {
  return scale.startMs + x * scale.msPerPx;
}

export function endMs(scale: TimeScale): number {
  return scale.startMs + scale.widthPx * scale.msPerPx;
}

/** The named zoom levels of the toolbar: whole trip down to minutes. */
export type ZoomLevel = 'trip' | 'day' | 'hour' | 'minute';

export const ZOOM_SPANS: Record<Exclude<ZoomLevel, 'trip'>, number> = {
  day: DAY_MS,
  hour: HOUR_MS,
  minute: 10 * MINUTE_MS,
};

/** Hard bounds on the zoom: a whole decade, down to a second across the viewport. */
const MIN_SPAN_MS = 1000;
const MAX_SPAN_MS = 10 * 365 * DAY_MS;

export function scaleForSpan(bounds: { fromMs: number; toMs: number }, widthPx: number, padFraction = 0.04): TimeScale {
  const rawSpan = Math.max(bounds.toMs - bounds.fromMs, MIN_SPAN_MS);
  const pad = rawSpan * padFraction;
  const span = rawSpan + pad * 2;
  return { startMs: bounds.fromMs - pad, msPerPx: span / Math.max(widthPx, 1), widthPx };
}

/** Re-centres the current view on a span, keeping the viewport width. */
export function scaleForZoom(scale: TimeScale, level: ZoomLevel, bounds: { fromMs: number; toMs: number }): TimeScale {
  if (level === 'trip') return scaleForSpan(bounds, scale.widthPx);
  const centre = msAt(scale, scale.widthPx / 2);
  const span = ZOOM_SPANS[level];
  return { ...scale, msPerPx: span / Math.max(scale.widthPx, 1), startMs: centre - span / 2 };
}

/**
 * Zooms about a fixed point — the pointer — so the instant under the cursor stays
 * under the cursor. Anything else makes a wheel zoom feel like it is fighting back.
 */
export function zoomAbout(scale: TimeScale, anchorX: number, factor: number): TimeScale {
  const anchorMs = msAt(scale, anchorX);
  const span = clamp(scale.msPerPx * scale.widthPx * factor, MIN_SPAN_MS, MAX_SPAN_MS);
  const msPerPx = span / Math.max(scale.widthPx, 1);
  return { ...scale, msPerPx, startMs: anchorMs - anchorX * msPerPx };
}

export function panBy(scale: TimeScale, deltaPx: number): TimeScale {
  return { ...scale, startMs: scale.startMs + deltaPx * scale.msPerPx };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * How far past the viewport an element is still allowed to reach. A strip or a zone
 * band can span real time far longer than what's on screen, and at a deep enough zoom
 * that span in pixels overshoots what browsers can reliably position or size an
 * element to (they clip or silently refuse to paint past roughly ±16-30M px). Nothing
 * needs to extend further than a healthy margin beyond the visible edge to still look
 * and behave right, so callers clamp into this margin before handing a pixel value to
 * CSS `left`/`width`.
 */
export const RENDER_MARGIN_PX = 50_000;

/** Clamps a pixel position/extent into the renderable margin around the viewport. */
export function clampToViewport(px: number, widthPx: number): number {
  return clamp(px, -RENDER_MARGIN_PX, widthPx + RENDER_MARGIN_PX);
}

export interface AxisTick {
  ms: number;
  label: string;
  major: boolean;
}

/** Tick spacings that read as time rather than as round numbers of milliseconds. */
const TICK_STEPS = [
  1000, 5000, 15_000, 30_000,
  MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
  HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
  DAY_MS, 7 * DAY_MS, 30 * DAY_MS, 365 * DAY_MS,
];

/**
 * Ticks for the current view, labelled in the folder's display offset.
 *
 * The labels read as the local time the trip is remembered in even though the axis
 * itself is absolute UTC, which is the whole reason §4.2 exists.
 */
export function axisTicks(scale: TimeScale, displayUtcOffsetMinutes: number, targetSpacingPx = 90): AxisTick[] {
  const wanted = scale.msPerPx * targetSpacingPx;
  const step = TICK_STEPS.find((s) => s >= wanted) ?? TICK_STEPS[TICK_STEPS.length - 1] as number;
  const shift = displayUtcOffsetMinutes * MINUTE_MS;

  // Ticks are placed on round *local* times, so a day boundary falls at local
  // midnight rather than at whatever hour UTC midnight happens to be there.
  const first = Math.ceil((scale.startMs + shift) / step) * step - shift;
  const out: AxisTick[] = [];
  for (let ms = first; ms <= endMs(scale); ms += step) {
    out.push({ ms, label: tickLabel(ms + shift, step), major: isMajor(ms + shift, step) });
    if (out.length > 200) break;
  }
  return out;
}

function tickLabel(shiftedMs: number, step: number): string {
  const iso = new Date(shiftedMs).toISOString();
  if (step >= DAY_MS) return iso.slice(0, 10);
  if (step >= MINUTE_MS) return iso.slice(11, 16);
  return iso.slice(11, 19);
}

function isMajor(shiftedMs: number, step: number): boolean {
  if (step >= DAY_MS) return new Date(shiftedMs).getUTCDate() === 1;
  return shiftedMs % DAY_MS === 0;
}

/** The first index at or after `ms` in an ascending list — the basis of virtualising. */
export function lowerBound(sorted: readonly number[], ms: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
