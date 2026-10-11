import { describe, expect, it } from 'vitest';
import type { FileRecord, StripsResponse } from '@geotagger/shared';
import { groupFiles } from './FileGrid.js';

const file = (id: number) => ({ id }) as unknown as FileRecord;
const strip = (id: number, label: string) => ({ id, label }) as StripsResponse['strips'][number];

const ids = (groups: ReturnType<typeof groupFiles>) =>
  groups.map((g) => [g.stripId, g.files.map((f) => f.id)]);

describe('groupFiles', () => {
  it('follows the strip order, keeps the file order, and drops empty strips', () => {
    const strips = {
      strips: [strip(7, 'B'), strip(3, 'A'), strip(9, 'empty')],
      assignments: { 1: 3, 2: 7, 3: 3, 4: 7 },
    } as unknown as StripsResponse;
    expect(ids(groupFiles([1, 2, 3, 4].map(file), strips))).toEqual([
      [7, [2, 4]],
      [3, [1, 3]],
    ]);
  });

  it('puts unassigned files, and files of an unknown strip, last', () => {
    const strips = { strips: [strip(3, 'A')], assignments: { 1: 3, 2: 99 } } as unknown as StripsResponse;
    expect(ids(groupFiles([1, 2, 3].map(file), strips))).toEqual([
      [3, [1]],
      [null, [2, 3]],
    ]);
  });

  it('shows everything as unassigned before the strips have loaded', () => {
    expect(ids(groupFiles([1, 2].map(file), null))).toEqual([[null, [1, 2]]]);
  });
});
