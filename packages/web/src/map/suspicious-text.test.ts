import { describe, expect, it } from 'vitest';
import type { FileId } from '@geotagger/shared';
import { suspiciousText } from './suspicious-text.js';

describe('suspiciousText', () => {
  it('gives the speeds there and back and how far apart the neighbors are', () => {
    expect(
      suspiciousText({ fileId: 'a' as FileId, fromPreviousKmh: 3012.4, toNextKmh: 2994, neighborsApartM: 120 }),
    ).toBe('Camera GPS looks wrong: ≈ 3012 km/h from the previous photo and ≈ 2994 km/h to the next, which are 120 m apart.');
  });

  it('says same time where there is no speed', () => {
    expect(suspiciousText({ fileId: 'a' as FileId, fromPreviousKmh: null, toNextKmh: 480, neighborsApartM: 1500 })).toBe(
      'Camera GPS looks wrong: at the same time as the previous photo and ≈ 480 km/h to the next, which are 1.5 km apart.',
    );
  });
});
