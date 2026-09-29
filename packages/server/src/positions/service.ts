import type { ComputedPosition, FileRecord, KnownPosition, PositionInput } from '@geotagger/shared';
import { computePositions, DEFAULT_INTERPOLATION_PARAMS } from '@geotagger/shared';
import type { FolderStore } from '../db/store.js';
import type { StripService } from '../strips/service.js';
import { coordsFromTags, formatCoord } from '../write/tags.js';
import { writtenTagsOf } from '../write/persist.js';

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

  /**
   * A confirmed position whose on-disk state doesn't match it yet (SPEC §6.3): never
   * persisted at all, or persisted with different coordinates than the current edit.
   * Camera GPS, a pending drag and an unconfirmed estimate are never persisted, so
   * they are never "unpersisted" either — only a settled, `confirmed` position is.
   *
   * Compared through the same coordinate formatting the writer uses, so a position that
   * differs only past the digit a tag can hold does not read as unpersisted for ever.
   */
  unpersistedFileIds(positions: readonly ComputedPosition[]): number[] {
    const persisted = this.store.listPersisted();
    const kindById = new Map(this.store.listFiles().map((f) => [f.id, f.kind]));
    return positions
      .filter((p) => p.source === 'confirmed')
      .filter((p) => {
        const row = persisted.get(p.fileId);
        const kind = kindById.get(p.fileId);
        if (!row || kind === undefined) return true;
        const written = writtenTagsOf(row, kind);
        const onDisk = written === null ? null : coordsFromTags(kind, written);
        if (onDisk === null || p.lat === null || p.lon === null) return true;
        return formatCoord(onDisk.lat) !== formatCoord(p.lat) || formatCoord(onDisk.lon) !== formatCoord(p.lon);
      })
      .map((p) => p.fileId);
  }
}
