import type { ComputedPosition, FileRecord, KnownPosition, PositionInput } from '@geotagger/shared';
import { computePositions, DEFAULT_INTERPOLATION_PARAMS } from '@geotagger/shared';
import type { FolderStore } from '../db/store.js';
import type { StripService } from '../strips/service.js';

/**
 * Turns a folder's files into map positions (SPEC §5).
 *
 * A file anchors the rest when it has a settled position: camera GPS, or a drag or
 * confirmation recorded in the edit store (§5.6) — the edit store wins when both
 * exist, since that is the position the user actually chose. Everything else is
 * interpolated or extrapolated from the anchors along the same absolute timeline the
 * alignment view uses, which is why this needs the strip service rather than the
 * store alone.
 */
export class PositionService {
  constructor(private readonly store: FolderStore, private readonly strips: StripService) {}

  compute(files: readonly FileRecord[]): ComputedPosition[] {
    const timeline = this.strips.timeline();
    const settled = this.store.listKnownPositions();

    const inputs: PositionInput[] = files.map((f) => {
      const own = settled.get(f.id);
      const cameraGps = f.origGpsPresent && f.origLat !== null && f.origLon !== null;
      const known: KnownPosition | null = own
        ? { lat: own.lat, lon: own.lon, source: own.source }
        : cameraGps
          ? { lat: f.origLat as number, lon: f.origLon as number, source: 'camera-gps' }
          : null;
      return {
        fileId: f.id,
        effectiveMs: timeline.byId.get(f.id)?.effectiveMs ?? null,
        known,
      };
    });

    return [...computePositions(inputs, DEFAULT_INTERPOLATION_PARAMS).values()];
  }
}
