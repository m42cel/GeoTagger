import { distanceMeters, type LatLon } from './geo.js';
import type { FileId } from './media.js';
import { DEFAULT_INTERPOLATION_PARAMS, type InterpolationParams, type PositionInput } from './positions.js';

/**
 * Camera GPS that is likely wrong (SPEC §6.3's *suspicious* status): a single fix the
 * track has to leave and come straight back to, faster than anyone travels on the
 * ground.
 *
 * Speed alone would flag every flight and train ride; the out-and-back shape is what
 * sets a bad fix apart. So a camera-GPS anchor is suspicious when reaching it from the
 * previous anchor and leaving it for the next both take at least `vCapKmh` — §5.2's
 * fastest plausible ground speed — *and* more than twice the speed of going straight
 * from the previous anchor to the next. Two neighboring bad fixes back each other up
 * and go unnoticed; only single ones are caught.
 */
export interface SuspiciousGps {
  fileId: FileId;
  /** Implied speed from the previous anchor; null when both are at the same instant. */
  fromPreviousKmh: number | null;
  /** Implied speed to the next anchor; null when both are at the same instant. */
  toNextKmh: number | null;
  /** How far apart the previous and next anchors are. */
  neighborsApartM: number;
}

/**
 * Below this, two positions count as the same place: GPS jitter in a burst taken
 * within the same second would otherwise imply any speed at all.
 */
const SAME_PLACE_M = 250;

interface Anchor {
  fileId: FileId;
  t: number;
  pos: LatLon;
  cameraGps: boolean;
}

/**
 * Every camera-GPS anchor that looks wrong. Its neighbors are the previous and next
 * anchors in effective-time order, camera GPS or confirmed; the first and last
 * anchors have only one and are never flagged. A confirmed position is never flagged
 * either — the user vouched for it.
 */
export function findSuspiciousGps(
  files: readonly PositionInput[],
  params: InterpolationParams = DEFAULT_INTERPOLATION_PARAMS,
): SuspiciousGps[] {
  const anchors: Anchor[] = files
    .filter((f) => f.known !== null && f.effectiveMs !== null)
    .map((f) => ({
      fileId: f.fileId,
      t: f.effectiveMs as number,
      pos: f.known as LatLon,
      cameraGps: f.known?.source === 'camera-gps',
    }))
    .sort((a, b) => a.t - b.t);

  const out: SuspiciousGps[] = [];
  for (let i = 1; i < anchors.length - 1; i++) {
    const b = anchors[i] as Anchor;
    if (!b.cameraGps) continue;
    const a = anchors[i - 1] as Anchor;
    const c = anchors[i + 1] as Anchor;

    const fromPrevious = speedKmh(a, b);
    const toNext = speedKmh(b, c);
    const across = speedKmh(a, c);
    const outAndBack =
      fromPrevious >= params.vCapKmh &&
      toNext >= params.vCapKmh &&
      fromPrevious > 2 * across &&
      toNext > 2 * across;
    if (!outAndBack) continue;

    out.push({
      fileId: b.fileId,
      fromPreviousKmh: Number.isFinite(fromPrevious) ? fromPrevious : null,
      toNextKmh: Number.isFinite(toNext) ? toNext : null,
      neighborsApartM: distanceMeters(a.pos, c.pos),
    });
  }
  return out;
}

/** SPEC §5.2's `v_implied` in km/h: zero for the same place, infinite for elsewhere at the same instant. */
function speedKmh(from: Anchor, to: Anchor): number {
  const d = distanceMeters(from.pos, to.pos);
  if (d < SAME_PLACE_M) return 0;
  const ms = to.t - from.t;
  return ms > 0 ? d / 1000 / (ms / 3_600_000) : Infinity;
}
