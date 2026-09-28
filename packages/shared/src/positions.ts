import { destinationPoint, distanceMeters, greatCirclePoint, initialBearing, type LatLon } from './geo.js';

/**
 * Position interpolation (SPEC §5): turning a file's effective timestamp and the
 * folder's known positions into an estimate everywhere else.
 *
 * Lives in the shared package for the same reason the timeline arithmetic does
 * (`time.ts`): recomputation runs on every anchor change (§5.5), and dragging a
 * marker needs its neighbours to move live, in the browser, without a round trip.
 */

/** Where a *known* position came from — never derived (SPEC §5.6). */
export type KnownPositionSource = 'camera-gps' | 'manual' | 'confirmed';

/** Where any position on the map came from, known or derived. */
export type PositionSource = KnownPositionSource | 'estimate' | 'none';

export interface KnownPosition extends LatLon {
  source: KnownPositionSource;
}

/** One file as the interpolator needs it. */
export interface PositionInput {
  fileId: number;
  /** Where it sits on the absolute timeline; null when it has no capture time at all. */
  effectiveMs: number | null;
  /**
   * A position that is already settled and not to be re-derived: camera GPS, a
   * drag, or a confirmation. Anchors everything else (SPEC §5.6); null otherwise.
   */
  known: KnownPosition | null;
}

export interface ComputedPosition {
  fileId: number;
  lat: number | null;
  lon: number | null;
  /**
   * Radius in metres for the faint uncertainty circle (SPEC §5.2), or null when
   * none is drawn — every known position, confirmed or not yet confirmed by drag.
   */
  uncertaintyM: number | null;
  source: PositionSource;
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
  fileId: number;
  t: number;
  pos: KnownPosition;
}

/**
 * Computes a position for every file: known positions pass through unchanged,
 * everything else is interpolated or extrapolated from the anchors (files with a
 * known position and a timestamp), or given up on entirely.
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
): Map<number, ComputedPosition> {
  const out = new Map<number, ComputedPosition>();

  for (const f of files) {
    if (f.known !== null) {
      out.set(f.fileId, {
        fileId: f.fileId,
        lat: f.known.lat,
        lon: f.known.lon,
        uncertaintyM: null,
        source: f.known.source,
      });
    }
  }

  const anchors: Anchor[] = files
    .filter((f): f is PositionInput & { known: KnownPosition; effectiveMs: number } =>
      f.known !== null && f.effectiveMs !== null,
    )
    .map((f) => ({ fileId: f.fileId, t: f.effectiveMs, pos: f.known }))
    .sort((a, b) => a.t - b.t);

  for (const f of files) {
    if (f.known !== null) continue;
    if (anchors.length < 2 || f.effectiveMs === null) {
      out.set(f.fileId, noPosition(f.fileId));
      continue;
    }
    out.set(f.fileId, estimate(f.fileId, f.effectiveMs, anchors, params));
  }

  return out;
}

function noPosition(fileId: number): ComputedPosition {
  return { fileId, lat: null, lon: null, uncertaintyM: null, source: 'none' };
}

/** Only called with at least two anchors — `computePositions` guarantees that. */
function estimate(fileId: number, t: number, anchors: readonly Anchor[], params: InterpolationParams): ComputedPosition {
  const first = anchors[0] as Anchor;
  const second = anchors[1] as Anchor;
  const last = anchors[anchors.length - 1] as Anchor;
  const secondLast = anchors[anchors.length - 2] as Anchor;

  if (t <= first.t) return extrapolate(fileId, t, second, first, params);
  if (t >= last.t) return extrapolate(fileId, t, secondLast, last, params);

  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i] as Anchor;
    const c = anchors[i + 1] as Anchor;
    if (t >= a.t && t <= c.t) return interpolateBetween(fileId, t, a, c, params);
  }
  // Unreachable: t is between first.t and last.t, so some consecutive pair brackets it.
  return interpolateBetween(fileId, t, first, last, params);
}

/** SPEC §5.1 and §5.2: a file whose time falls between two anchors. */
function interpolateBetween(fileId: number, t: number, a: Anchor, c: Anchor, params: InterpolationParams): ComputedPosition {
  const spanMs = c.t - a.t;
  if (spanMs <= 0) {
    // The bracketing anchors coincide in time (so `t` does too) — there is no
    // interval to place it within or derive a velocity from.
    return { fileId, lat: a.pos.lat, lon: a.pos.lon, uncertaintyM: params.rMinM, source: 'estimate' };
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

  return { fileId, lat, lon, uncertaintyM: r, source: 'estimate' };
}

/**
 * SPEC §5.3: a file before the first anchor or after the last. `near` is the anchor
 * being extrapolated from (the first or the last); `far` is its neighbour, which
 * together with `near` implies the bearing and speed to continue at.
 */
function extrapolate(fileId: number, t: number, far: Anchor, near: Anchor, params: InterpolationParams): ComputedPosition {
  const pairSpanMs = Math.abs(near.t - far.t);
  const d = distanceMeters(far.pos, near.pos);
  const vImplied = pairSpanMs > 0 ? d / (pairSpanMs / 1000) : 0;
  const bearing = initialBearing(far.pos, near.pos);
  const deltaS = Math.abs(t - near.t) / 1000;

  if (params.extrapolationMaxMinutes !== null && deltaS / 60 > params.extrapolationMaxMinutes) {
    return { fileId, lat: near.pos.lat, lon: near.pos.lon, uncertaintyM: BEYOND_CAP_UNCERTAINTY_M, source: 'estimate' };
  }

  const { lat, lon } = destinationPoint(near.pos, bearing, vImplied * deltaS);
  const vRef = clamp(2 * vImplied, kmhToMs(params.vFloorKmh), kmhToMs(params.vCapKmh));
  const r = Math.max(params.rMinM, vRef * deltaS);

  return { fileId, lat, lon, uncertaintyM: r, source: 'estimate' };
}

function kmhToMs(kmh: number): number {
  return (kmh * 1000) / 3600;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
