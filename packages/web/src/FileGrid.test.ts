import { describe, expect, it } from 'vitest';
import type { FileRecord, StripsResponse } from '@geotagger/shared';
import { groupFiles } from './FileGrid.js';

const file = (id: number, relPath: string, captureTimeRaw: string) =>
  ({ id, relPath, captureTimeRaw, deviceId: null }) as unknown as FileRecord;
const strip = (id: number, lane: number, ordinal = 0) => ({ id, lane, ordinal }) as StripsResponse['strips'][number];

const ids = (groups: ReturnType<typeof groupFiles>) => groups.map((g) => [g.key, g.files.map((f) => f.id)]);

describe('groupFiles', () => {
  // Listed out of capture order, the way the grid may get them.
  const files = [
    file(1, 'b/1.jpg', '2026-08-01 12:00:00'),
    file(2, 'a/2.jpg', '2026-08-01 11:00:00'),
    file(3, 'a/3.jpg', '2026-08-01 10:00:00'),
  ];

  it('makes one group per subfolder, keeping the files\' order', () => {
    const strips = {
      groupingMode: 'subfolder',
      strips: [strip(10, 0), strip(20, 1)],
      assignments: { 1: 20, 2: 10, 3: 10 },
    } as unknown as StripsResponse;
    expect(ids(groupFiles(files, strips, []))).toEqual([
      ['a', [2, 3]],
      ['b', [1]],
    ]);
  });

  it('keeps a subfolder one group when its segments sit in different lanes', () => {
    const strips = {
      groupingMode: 'subfolder',
      strips: [strip(10, 0), strip(11, 2), strip(20, 1)],
      assignments: { 1: 20, 2: 11, 3: 10 },
    } as unknown as StripsResponse;
    expect(ids(groupFiles(files, strips, []))).toEqual([
      ['a', [2, 3]],
      ['b', [1]],
    ]);
  });

  it('shows everything as unassigned before the strips have loaded', () => {
    expect(ids(groupFiles(files, null, []))).toEqual([[null, [1, 2, 3]]]);
  });
});
