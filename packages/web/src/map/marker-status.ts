import { isAnchor, type ComputedPosition } from '@geotagger/shared';

/** Green for a known position (camera GPS or confirmed), red for an estimate or a drag not yet confirmed (SPEC §6.5). */
export function borderClassFor(position: ComputedPosition): 'known' | 'unconfirmed' {
  return position.pending === null && isAnchor(position) ? 'known' : 'unconfirmed';
}
