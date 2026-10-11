import { destinationPoint, distanceMeters, greatCirclePoint, initialBearing, type LatLon } from './geo.js';
import type { FileId } from './media.js';

/**
 * Position interpolation (SPEC §5): turning a file's effective timestamp and the
 * folder's known positions into an estimate everywhere else.
 *
 * Lives in the shared package for the same reason the timeline arithmetic does
 * (`time.ts`): recomputation runs on every anchor change (§5.5), and confirming a
 * marker needs its neighbours to move live, in the browser, without a round trip.
 */

/** Where a *known* position came from — the only two things that anchor other files (SPEC §5.5). */
export type KnownPositionSource = 'camera-gps' | 'confirmed';

/** Where a file's own position came from: known, or derived from the anchors. */
export type PositionSource = KnownPositionSource | 'estimate';

export interface KnownPosition extends LatLon {
  source: KnownPositionSource;
}

/** One file as the interpolator needs it. */
export interface PositionInput {
  fileId: FileId;
  /** Where it sits on the absolute timeline; null when it has no capture time at all. */
  effectiveMs: number | null;
  /**
   * A settled position that anchors this file *and* every other file (SPEC §5.5):
   * camera GPS or a confirmation. A drag in progress never touches this — see
   * `pending` — so re-dragging an already-settled file keeps this anchor active for
   * everyone else until the drag is confirmed or reverted.
   */
  known: KnownPosition | null;
  /**
   * A drag in progress: overrides this file's own displayed position but anchors
   * nothing (SPEC §5.5, §5.6). Coexists with `known` when a previously-settled file
   * is being re-dragged — the map shows `known` as a ghost, connected to `pending`
   * by a thin line, until the user confirms or reverts.
   */
  pending: LatLon | null;
}

/** A file's own position: known (camera GPS or confirmed) or an estimate (SPEC §5). */
export interface BasePosition extends LatLon {
  source: PositionSource;
  /**
   * Radius in metres for the faint uncertainty circle (SPEC §5.2), or null when
   * none is drawn — only an estimate has one.
   */
  uncertaintyM: number | null;
}

/**
 * Everything the map needs about one file's position. `base` is what the file shows
 * with no drag in progress, or null when nothing is derivable (the tray, SPEC §6.4).
 * `pending` is a drag in progress (SPEC §5.6): while it is set the file shows there,
 * and `base`, when there is one, is drawn as its ghost — an anchor that still places
 * everyone else, or the estimate the track still gives the file.
 */
export interface ComputedPosition {
  fileId: FileId;
  base: BasePosition | null;
  pending: LatLon | null;
}

/** Where a file's marker sits: its drag in progress, or else its own position. */
export function shownPosition(position: ComputedPosition): LatLon | null {
  return position.pending ?? position.base;
}

/**
 * What confirming acts on (SPEC §6.5): a drag in progress, or an estimate. Camera GPS
 * and a confirmed position with no drag on top are already anchors.
 */
export function canConfirm(position: ComputedPosition): boolean {
  return position.pending !== null || position.base?.source === 'estimate';
}

/** Whether a file anchors the others (SPEC §5.5): camera GPS or confirmed, drag in progress or not. */
export function isAnchor(position: ComputedPosition): boolean {
  return position.base?.source === 'camera-gps' || position.base?.source === 'confirmed';
}

/** Tunable interpolation behaviour, mirroring the settings of SPEC §11. */
export interface InterpolationParams {
  vFloorKmh: number;
  vCapKmh: number;
  rMinM: number;
  /** SPEC §5.3's `EXTRAPOLATION_MAX_MINUTES`. Ships disabled: null means unlimited. */
  extrapolationMaxMinutes: number | null;
}

export const DEFAULT_INTERPOLATION_PARAMS: InterpolationParams = {
  vFloorKmh: 5,
  vCapKmh: 200,
  rMinM: 10,
  extrapolationMaxMinutes: null,
};

/**
 * The radius given to a file that falls back to its nearest anchor because it is
 * beyond `extrapolationMaxMinutes` (SPEC §5.3: "a very large circle"). The cap ships
 * disabled, so this only ever fires when a deployment has turned it on.
 */
const BEYOND_CAP_UNCERTAINTY_M = 50_000;

interface Anchor {
  fileId: FileId;
  t: number;
  pos: KnownPosition;
}

/**
 * Computes a position for every file: a `known` position passes through unchanged;
 * everything else is interpolated or extrapolated from the anchors (files with a
 * `known` position and a timestamp), or given up on entirely. A pending drag is
 * carried alongside, never in place of that — the file's own position is still
 * worked out underneath it, so the map can ghost it (SPEC §5.6).
 *
 * A pending drag never joins the anchor set (SPEC §5.5): it settles only its own
 * file, so it never moves a neighbour's estimate. Only `known` — camera GPS or a
 * confirmation — anchors anything, whether or not that same file also has a drag
 * in progress on top of it.
 *
 * Two anchors are the least that can imply a velocity (SPEC §5.2's `v_implied`
 * needs a distance *and* a time gap between two points), so with fewer than that no
 * honest estimate exists for anyone but the anchor itself — the same "no anchors at
 * all" case of §5.4/§6.4, just short by one. A file with no capture time at all is
 * in the same position for a different reason: there is no `t` to place it at, so it
 * goes to the tray alongside them rather than being left off the map.
 */
export function computePositions(
  files: readonly PositionInput[],
  params: InterpolationParams = DEFAULT_INTERPOLATION_PARAMS,
): Map<FileId, ComputedPosition> {
  const out = new Map<FileId, ComputedPosition>();

  const anchors: Anchor[] = files
    .filter((f): f is PositionInput & { known: KnownPosition; effectiveMs: number } =>
      f.known !== null && f.effectiveMs !== null,
    )
    .map((f) => ({ fileId: f.fileId, t: f.effectiveMs, pos: f.known }))
    .sort((a, b) => a.t - b.t);

  for (const f of files) {
    const base: BasePosition | null =
      f.known !== null
        ? { lat: f.known.lat, lon: f.known.lon, source: f.known.source, uncertaintyM: null }
        : anchors.length >= 2 && f.effectiveMs !== null
          ? estimate(f.effectiveMs, anchors, params)
          : null;
    out.set(f.fileId, { fileId: f.fileId, base, pending: f.pending });
  }

  return out;
}

/** Only called with at least two anchors — `computePositions` guarantees that. */
function estimate(t: number, anchors: readonly Anchor[], params: InterpolationParams): BasePosition {
  const first = anchors[0] as Anchor;
  const second = anchors[1] as Anchor;
  const last = anchors[anchors.length - 1] as Anchor;
  const secondLast = anchors[anchors.length - 2] as Anchor;

  if (t <= first.t) return extrapolate(t, second, first, params);
  if (t >= last.t) return extrapolate(t, secondLast, last, params);

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i] as Anchor;
    const c = anchors[i + 1] as Anchor;
    if (t >= a.t && t <= c.t) return interpolateBetween(t, a, c, params);
  }
  // Unreachable: t is between first.t and last.t, so some consecutive pair brackets it.
  return interpolateBetween(t, first, last, params);
}

/** SPEC §5.1 and §5.2: a file whose time falls between two anchors. */
function interpolateBetween(t: number, a: Anchor, c: Anchor, params: InterpolationParams): BasePosition {
  const spanMs = c.t - a.t;
  if (spanMs <= 0) {
    // The bracketing anchors coincide in time (so `t` does too) — there is no
    // interval to place it within or derive a velocity from.
    return { lat: a.pos.lat, lon: a.pos.lon, uncertaintyM: params.rMinM, source: 'estimate' };
  }

  const f = (t - a.t) / spanMs;
  const { lat, lon } = greatCirclePoint(a.pos, c.pos, f);

  const d = distanceMeters(a.pos, c.pos);
  const spanS = spanMs / 1000;
  const vImplied = d / spanS;
  const vRef = clamp(2 * vImplied, kmhToMs(params.vFloorKmh), kmhToMs(params.vCapKmh));
  const slack = vRef * spanS - d;
  const sinceA = (t - a.t) / 1000;
  const untilC = (c.t - t) / 1000;
  const r = Math.max(params.rMinM, Math.min(vRef * Math.min(sinceA, untilC), slack / 2));

  return { lat, lon, uncertaintyM: r, source: 'estimate' };
}

/**
 * SPEC §5.3: a file before the first anchor or after the last. `near` is the anchor
 * being extrapolated from (the first or the last); `far` is its neighbour, which
 * together with `near` implies the bearing and speed to continue at.
 */
function extrapolate(t: number, far: Anchor, near: Anchor, params: InterpolationParams): BasePosition {
  const pairSpanMs = Math.abs(near.t - far.t);
  const d = distanceMeters(far.pos, near.pos);
  const vImplied = pairSpanMs > 0 ? d / (pairSpanMs / 1000) : 0;
  const bearing = initialBearing(far.pos, near.pos);
  const deltaS = Math.abs(t - near.t) / 1000;

  if (params.extrapolationMaxMinutes !== null && deltaS / 60 > params.extrapolationMaxMinutes) {
    return { lat: near.pos.lat, lon: near.pos.lon, uncertaintyM: BEYOND_CAP_UNCERTAINTY_M, source: 'estimate' };
  }

  const { lat, lon } = destinationPoint(near.pos, bearing, vImplied * deltaS);
  const vRef = clamp(2 * vImplied, kmhToMs(params.vFloorKmh), kmhToMs(params.vCapKmh));
  const r = Math.max(params.rMinM, vRef * deltaS);

  return { lat, lon, uncertaintyM: r, source: 'estimate' };
}

function kmhToMs(kmh: number): number {
  return (kmh * 1000) / 3600;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
