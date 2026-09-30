import { describe, expect, it } from 'vitest';
import { generateFileId } from './uuid.js';

describe('generateFileId', () => {
  it('produces unique, UUIDv7-shaped ids', () => {
    const ids = Array.from({ length: 5000 }, () => generateFileId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(0, 50)) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
