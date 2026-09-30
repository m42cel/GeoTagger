import { describe, expect, it } from 'vitest';
import { generateFileId } from './uuid.js';

describe('generateFileId', () => {
  it('is monotonic even across many ids generated in the same millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => generateFileId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the UUIDv7 version and variant bits', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateFileId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
