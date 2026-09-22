import { describe, it, expect } from 'vitest';
import { arrangeLanes, collapseEmptyLanes, laneAccepts, overlaps, type LanePlacement } from './lanes.js';

const strip = (id: number, lane: number, firstMs: number | null, lastMs: number | null): LanePlacement => ({
  id,
  lane,
  ordinal: 0,
  firstMs,
  lastMs,
});

describe('overlaps', () => {
  it('sees intersecting spans', () => {
    expect(overlaps(strip(1, 0, 0, 100), strip(2, 0, 50, 150))).toBe(true);
    expect(overlaps(strip(1, 0, 0, 100), strip(2, 0, 100, 150))).toBe(true);
  });

  it('leaves disjoint spans alone', () => {
    expect(overlaps(strip(1, 0, 0, 100), strip(2, 0, 101, 150))).toBe(false);
  });

  it('never fires for a strip with no dated file', () => {
    expect(overlaps(strip(1, 0, null, null), strip(2, 0, 0, 100))).toBe(false);
  });
});

describe('arrangeLanes', () => {
  it('promotes a dragged segment that landed on its sibling', () => {
    const out = arrangeLanes([strip(1, 0, 0, 100), strip(2, 0, 50, 150), strip(3, 1, 0, 100)], 2);
    const moved = out.find((p) => p.id === 2) as LanePlacement;
    const other = out.find((p) => p.id === 3) as LanePlacement;
    expect(moved.lane).toBe(1);
    // The lane that was below is pushed down rather than shared.
    expect(other.lane).toBe(2);
  });

  it('leaves a segment where it is when it still fits', () => {
    const out = arrangeLanes([strip(1, 0, 0, 100), strip(2, 0, 200, 300)], 2);
    expect(out.every((p) => p.lane === 0)).toBe(true);
  });

  it('orders segments within a lane by effective time', () => {
    const out = arrangeLanes([strip(1, 0, 500, 600), strip(2, 0, 0, 100)], null);
    expect(out.map((p) => p.id)).toEqual([2, 1]);
    expect(out.map((p) => p.ordinal)).toEqual([0, 1]);
  });

  it('collapses a lane left empty', () => {
    const out = arrangeLanes([strip(1, 0, 0, 100), strip(2, 4, 0, 100)], null);
    expect(out.map((p) => p.lane)).toEqual([0, 1]);
  });

  it('does not promote a strip that collides with one in another lane', () => {
    const out = arrangeLanes([strip(1, 0, 0, 100), strip(2, 1, 50, 150)], 2);
    expect(out.find((p) => p.id === 2)?.lane).toBe(1);
  });

  it('does not promote an undated strip, which cannot collide', () => {
    const out = arrangeLanes([strip(1, 0, 0, 100), strip(2, 0, null, null)], 2);
    expect(out.every((p) => p.lane === 0)).toBe(true);
  });
});

describe('collapseEmptyLanes', () => {
  it('keeps the existing lane order while renumbering', () => {
    const out = collapseEmptyLanes([strip(1, 7, 0, 1), strip(2, 2, 0, 1), strip(3, 5, 0, 1)]);
    expect(out.map((p) => [p.id, p.lane])).toEqual([
      [2, 0],
      [3, 1],
      [1, 2],
    ]);
  });
});

describe('laneAccepts', () => {
  const placements = [strip(1, 0, 0, 100), strip(2, 1, 0, 100)];
  it('rejects a drop onto an overlapping strip', () => {
    expect(laneAccepts(placements, strip(3, 2, 50, 150), 0)).toBe(false);
  });
  it('accepts a drop into free space', () => {
    expect(laneAccepts(placements, strip(3, 2, 200, 300), 0)).toBe(true);
  });
});
