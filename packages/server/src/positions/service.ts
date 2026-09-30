import type { ComputedPosition, FileId, FileRecord, KnownPosition, PositionInput } from '@geotagger/shared';
import { computePositions, DEFAULT_INTERPOLATION_PARAMS } from '@geotagger/shared';
import type { FolderStore } from '../db/store.js';
import type { StripService } from '../strips/service.js';
import { coordsFromTags, formatCoord } from '../write/tags.js';
import { writtenTagsOf } from '../write/persist.js';
import { tagValuesOnDisk } from '../write/plan.js';

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
   * Read through the same two steps the persist plan uses — the tags GeoTagger has
   * written over what the scan read — so this answers with what is in the file rather than
   * with what GeoTagger happens to have touched. Reassembling a position from the written
   * tags alone would lose a hemisphere the camera's own ref tag carries, and every photo
   * west of Greenwich would read as unpersisted for ever. Compared through the writer's own
   * coordinate formatting, so a difference past the digit a tag can hold is not a
   * difference either.
   */
  unpersistedFileIds(positions: readonly ComputedPosition[]): FileId[] {
    const persisted = this.store.listPersisted();
    const fileById = new Map(this.store.listFiles().map((f) => [f.id, f]));
    return positions
      .filter((p) => p.source === 'confirmed')
      .filter((p) => {
        const file = fileById.get(p.fileId);
        if (file === undefined || p.lat === null || p.lon === null) return true;
        const row = persisted.get(p.fileId);
        const written = row === undefined ? null : writtenTagsOf(row);
        const onDisk = coordsFromTags(file.kind, tagValuesOnDisk(file, written ?? {}));
        if (onDisk === null) return true;
        return formatCoord(onDisk.lat) !== formatCoord(p.lat) || formatCoord(onDisk.lon) !== formatCoord(p.lon);
      })
      .map((p) => p.fileId);
  }
}
