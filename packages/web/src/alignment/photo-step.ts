import type { FileId } from '@geotagger/shared';
import { lowerBound } from './scale.js';

/**
 * Where ←/→ move the selection inside one strip: the index of `fromId`'s neighbor in
 * time order, so stepping through a stack walks its photos one at a time. With no photo
 * of this strip to step from, it lands on the one nearest `nearMs` instead. Null past
 * either end of the strip.
 */
export function stepPhoto(
  strip: { files: readonly { id: FileId }[]; instants: readonly number[] },
  fromId: FileId | null,
  direction: -1 | 1,
  nearMs: number,
): number | null {
  const at = fromId === null ? -1 : strip.files.findIndex((f) => f.id === fromId);
  if (at !== -1) {
    const next = at + direction;
    return next >= 0 && next < strip.files.length ? next : null;
  }
  if (strip.instants.length === 0) return null;
  const after = lowerBound(strip.instants, nearMs);
  if (after === 0) return 0;
  if (after === strip.instants.length) return after - 1;
  const before = after - 1;
  return nearMs - (strip.instants[before] as number) <= (strip.instants[after] as number) - nearMs ? before : after;
}
