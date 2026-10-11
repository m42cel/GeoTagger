import { describe, expect, it } from 'vitest';
import type { StripRecord } from '@geotagger/shared';
import { laneGroups } from './lane-groups.js';

const strip = (id: number, lane: number, ordinal: number, label: string) =>
  ({ id, lane, ordinal, label }) as StripRecord;

describe('laneGroups', () => {
  it('makes one group per lane, top to bottom, its strips in lane order', () => {
    const groups = laneGroups([strip(5, 1, 0, 'B'), strip(4, 0, 1, 'A'), strip(3, 0, 0, 'A')]);
    expect(groups).toEqual([
      { lane: 0, label: 'A', stripIds: [3, 4] },
      { lane: 1, label: 'B', stripIds: [5] },
    ]);
  });

  it('names a lane after each distinct label once', () => {
    const groups = laneGroups([strip(1, 0, 0, 'A'), strip(2, 0, 1, 'B'), strip(3, 0, 2, 'A')]);
    expect(groups.map((g) => g.label)).toEqual(['A, B']);
  });
});
