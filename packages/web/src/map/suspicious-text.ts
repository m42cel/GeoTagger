import type { SuspiciousGps } from '@geotagger/shared';
import { formatDistance, formatSpeed } from './path.js';

/** The detail panel's warning (SPEC §6.3): the speeds there and back, against how close the neighbors are. */
export function suspiciousText(suspicious: SuspiciousGps): string {
  const from = suspicious.fromPreviousKmh === null ? 'at the same time as' : `${formatSpeed(suspicious.fromPreviousKmh)} from`;
  const to = suspicious.toNextKmh === null ? 'at the same time as' : `${formatSpeed(suspicious.toNextKmh)} to`;
  return (
    `Camera GPS looks wrong: ${from} the previous photo and ${to} the next, ` +
    `which are ${formatDistance(suspicious.neighborsApartM)} apart.`
  );
}
