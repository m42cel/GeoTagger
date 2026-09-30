import { describe, expect, it } from 'vitest';
import { markerSize } from './marker-size.js';

describe('markerSize', () => {
  it('keeps square, 4:3 and 3:4 images at their own shape', () => {
    expect(markerSize(3000, 3000, 48)).toEqual([48, 48]);
    expect(markerSize(4032, 3024, 48)).toEqual([48, 36]);
    expect(markerSize(3024, 4032, 48)).toEqual([36, 48]);
  });

  it('keeps ratios between 4:3 and 3:4 as they are', () => {
    expect(markerSize(1200, 1000, 48)).toEqual([48, 40]);
    expect(markerSize(1000, 1200, 48)).toEqual([40, 48]);
  });

  it('clamps wider and taller images to 4:3 and 3:4', () => {
    expect(markerSize(1920, 1080, 48)).toEqual([48, 36]);
    expect(markerSize(12000, 2000, 48)).toEqual([48, 36]);
    expect(markerSize(1080, 1920, 48)).toEqual([36, 48]);
    expect(markerSize(3000, 900, 48)).toEqual([48, 36]);
    expect(markerSize(900, 3000, 48)).toEqual([36, 48]);
  });

  it('falls back to square when the dimensions are unknown', () => {
    expect(markerSize(null, null, 48)).toEqual([48, 48]);
    expect(markerSize(4000, null, 48)).toEqual([48, 48]);
    expect(markerSize(0, 3000, 48)).toEqual([48, 48]);
  });
});
