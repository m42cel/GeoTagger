import { describe, expect, it } from 'vitest';
import { stepPhoto } from './photo-step.js';

const strip = {
  files: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  instants: [1_000, 2_000, 5_000],
};

describe('stepPhoto', () => {
  it('steps to the neighbour in time order', () => {
    expect(stepPhoto(strip, 'b', 1, 0)).toBe(2);
    expect(stepPhoto(strip, 'b', -1, 0)).toBe(0);
  });

  it('stops at either end of the strip', () => {
    expect(stepPhoto(strip, 'c', 1, 0)).toBeNull();
    expect(stepPhoto(strip, 'a', -1, 0)).toBeNull();
  });

  it('starts at the photo nearest the given instant when none of the strip is selected', () => {
    expect(stepPhoto(strip, null, 1, 3_000)).toBe(1);
    expect(stepPhoto(strip, 'elsewhere', -1, 4_000)).toBe(2);
    expect(stepPhoto(strip, null, 1, 0)).toBe(0);
    expect(stepPhoto(strip, null, 1, 9_000)).toBe(2);
  });

  it('finds nothing in an empty strip', () => {
    expect(stepPhoto({ files: [], instants: [] }, null, 1, 0)).toBeNull();
  });
});
