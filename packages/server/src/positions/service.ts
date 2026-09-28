import type { ComputedPosition, FileRecord, KnownPosition, PositionInput } from '@geotagger/shared';
import { computePositions, DEFAULT_INTERPOLATION_PARAMS } from '@geotagger/shared';
import type { FolderStore } from '../db/store.js';
import type { StripService } from '../strips/service.js';

/**
 * Turns a folder's files into map positions (SPEC §5).
 *
 * A file's `known` anchor is its confirmed edit-store position, falling back to
 * camera GPS — only those two anchor anything (§5.5). A drag in progress is kept
 * entirely separate as `pending`: it overrides what a file itself displays without
 * ever touching `known`, which is what lets an already-anchored file be re-dragged
 * while the old anchor keeps placing everyone else (§5.6). Everything else is
 * interpolated or extrapolated from the anchors along the same absolute timeline the
 * alignment view uses, which is why this needs the strip service rather than the
 * store alone.
 */
export class PositionService {
  constructor(private readonly store: FolderStore, private readonly strips: StripService) {}

  compute(files: readonly FileRecord[]): ComputedPosition[] {
    const timeline = this.strips.timeline();
    const confirmed = this.store.listConfirmedPositions();
    const pending = this.store.listPendingPositions();

    const inputs: PositionInput[] = files.map((f) => {
      const conf = confirmed.get(f.id);
      const cameraGps = f.origGpsPresent && f.origLat !== null && f.origLon !== null;
      const known: KnownPosition | null = conf
        ? { lat: conf.lat, lon: conf.lon, source: 'confirmed' }
        : cameraGps
          ? { lat: f.origLat as number, lon: f.origLon as number, source: 'camera-gps' }
          : null;
      return {
        fileId: f.id,
        effectiveMs: timeline.byId.get(f.id)?.effectiveMs ?? null,
        known,
        pending: pending.get(f.id) ?? null,
      };
    });

    return [...computePositions(inputs, DEFAULT_INTERPOLATION_PARAMS).values()];
  }
}
