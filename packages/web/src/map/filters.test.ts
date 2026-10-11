import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, PositionSource } from '@geotagger/shared';
import { isShown, type MapFilters } from './filters.js';

function item(
  id: string,
  source: PositionSource,
  dragged = false,
): { file: { id: FileId }; position: ComputedPosition } {
  return {
    file: { id: id as FileId },
    position: {
      fileId: id as FileId,
      base: { lat: 1, lon: 1, uncertaintyM: null, source },
      pending: dragged ? { lat: 2, lon: 2 } : null,
    },
  };
}

const all: MapFilters = { hiddenStripIds: new Set(), showKnown: true, showInterpolated: true };
const assignments = { a: 1, b: 2 } as Record<FileId, number>;

describe('isShown', () => {
  it('shows everything with no filter applied', () => {
    for (const source of ['camera-gps', 'confirmed', 'estimate'] as const) {
      expect(isShown(item('a', source), assignments, all)).toBe(true);
      expect(isShown(item('a', source, true), assignments, all)).toBe(true);
    }
  });

  it('intersects groups with status', () => {
    const filters: MapFilters = { hiddenStripIds: new Set([2]), showKnown: true, showInterpolated: false };
    expect(isShown(item('a', 'camera-gps'), assignments, filters)).toBe(true);
    expect(isShown(item('a', 'confirmed'), assignments, filters)).toBe(true);
    expect(isShown(item('a', 'estimate'), assignments, filters)).toBe(false);
    expect(isShown(item('b', 'camera-gps'), assignments, filters)).toBe(false);
  });

  it('keeps a pending drag through the status filter but not through its hidden group', () => {
    const noStatus: MapFilters = { ...all, showKnown: false, showInterpolated: false };
    expect(isShown(item('a', 'estimate', true), assignments, noStatus)).toBe(true);
    expect(isShown(item('a', 'confirmed', true), assignments, noStatus)).toBe(true);
    expect(isShown(item('a', 'estimate', true), assignments, { ...all, hiddenStripIds: new Set([1]) })).toBe(false);
  });

  it('does not hide a file no strip claims by group', () => {
    expect(isShown(item('z', 'estimate'), assignments, { ...all, hiddenStripIds: new Set([1, 2]) })).toBe(true);
  });
});
