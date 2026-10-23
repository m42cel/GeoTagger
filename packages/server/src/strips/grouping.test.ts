import { describe, expect, it } from 'vitest';
import type { FileRecord } from '@geotagger/shared';
import { buildStrips } from './grouping.js';

const file = (id: string, relPath: string, captureTimeRaw: string) =>
  ({ id, relPath, captureTimeRaw, deviceId: null }) as FileRecord;

describe('buildStrips — SPEC §4.4', () => {
  it('makes one strip per group, each in its own lane, earliest first', () => {
    const files = [file('a', 'B/a.jpg', '2024-07-12T11:00:00'), file('b', 'A/b.jpg', '2024-07-12T10:00:00')];
    expect(buildStrips('subfolder', files, [])).toEqual([
      { label: 'A', lane: 0, ordinal: 0, fileIds: ['b'] },
      { label: 'B', lane: 1, ordinal: 0, fileIds: ['a'] },
    ]);
  });
});
