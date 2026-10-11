import { describe, expect, it } from 'vitest';
import type { FileRecord, StripsResponse } from '@geotagger/shared';
import { groupFiles } from './FileGrid.js';

const file = (id: number) => ({ id }) as unknown as FileRecord;
const strip = (id: number, lane: number, label: string, ordinal = 0) =>
  ({ id, lane, ordinal, label }) as StripsResponse['strips'][number];

const ids = (groups: ReturnType<typeof groupFiles>) =>
  groups.map((g) => [g.lane, g.files.map((f) => f.id)]);

describe('groupFiles', () => {
  it('follows the lane order, keeps the file order, and drops empty lanes', () => {
    const strips = {
      strips: [strip(7, 0, 'B'), strip(3, 1, 'A'), strip(9, 2, 'empty')],
      assignments: { 1: 3, 2: 7, 3: 3, 4: 7 },
    } as unknown as StripsResponse;
    expect(ids(groupFiles([1, 2, 3, 4].map(file), strips))).toEqual([
      [0, [2, 4]],
      [1, [1, 3]],
    ]);
  });

  it('keeps the segments of a lane in one group, and a promoted segment in its own', () => {
    const strips = {
      strips: [strip(1, 0, 'A'), strip(2, 0, 'A', 1), strip(3, 1, 'A')],
      assignments: { 1: 1, 2: 2, 3: 3, 4: 1 },
    } as unknown as StripsResponse;
    expect(ids(groupFiles([1, 2, 3, 4].map(file), strips))).toEqual([
      [0, [1, 2, 4]],
      [1, [3]],
    ]);
  });

  it('puts unassigned files, and files of an unknown strip, last', () => {
    const strips = { strips: [strip(3, 0, 'A')], assignments: { 1: 3, 2: 99 } } as unknown as StripsResponse;
    expect(ids(groupFiles([1, 2, 3].map(file), strips))).toEqual([
      [0, [1]],
      [null, [2, 3]],
    ]);
  });

  it('shows everything as unassigned before the strips have loaded', () => {
    expect(ids(groupFiles([1, 2].map(file), null))).toEqual([[null, [1, 2]]]);
  });
});
