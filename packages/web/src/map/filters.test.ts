import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, PositionSource } from '@geotagger/shared';
import { isShown, type FilterContext, type MapFilters } from './filters.js';

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

const context: FilterContext = {
  unpersistedIds: new Set(['u' as FileId]),
};
const all: MapFilters = { hiddenFileIds: new Set(), status: 'all' };
const hidden = (...ids: string[]) => new Set(ids as FileId[]);

describe('isShown', () => {
  it('shows everything with no filter applied', () => {
    for (const source of ['camera-gps', 'confirmed', 'estimate'] as const) {
      expect(isShown(item('a', source), context, all)).toBe(true);
      expect(isShown(item('a', source, true), context, all)).toBe(true);
    }
  });

  it('splits known from interpolated', () => {
    const known: MapFilters = { ...all, status: 'known' };
    const interpolated: MapFilters = { ...all, status: 'interpolated' };
    expect(isShown(item('a', 'camera-gps'), context, known)).toBe(true);
    expect(isShown(item('a', 'confirmed'), context, known)).toBe(true);
    expect(isShown(item('a', 'estimate'), context, known)).toBe(false);
    expect(isShown(item('a', 'estimate'), context, interpolated)).toBe(true);
    expect(isShown(item('a', 'camera-gps'), context, interpolated)).toBe(false);
  });

  it('intersects groups with status', () => {
    const filters: MapFilters = { hiddenFileIds: hidden('b'), status: 'known' };
    expect(isShown(item('a', 'camera-gps'), context, filters)).toBe(true);
    expect(isShown(item('b', 'camera-gps'), context, filters)).toBe(false);
  });

  it('judges a pending drag by the position underneath it', () => {
    const known: MapFilters = { ...all, status: 'known' };
    const interpolated: MapFilters = { ...all, status: 'interpolated' };
    expect(isShown(item('a', 'camera-gps', true), context, known)).toBe(true);
    expect(isShown(item('a', 'camera-gps', true), context, interpolated)).toBe(false);
    expect(isShown(item('a', 'estimate', true), context, interpolated)).toBe(true);
    expect(isShown(item('a', 'estimate', true), context, known)).toBe(false);
    expect(isShown(item('a', 'estimate', true), context, { ...all, hiddenFileIds: hidden('a') })).toBe(false);
  });

  it('shows a drag with nothing underneath only under all', () => {
    const fromTray = { file: { id: 'a' as FileId }, position: { fileId: 'a' as FileId, base: null, pending: { lat: 2, lon: 2 } } };
    expect(isShown(fromTray, context, all)).toBe(true);
    expect(isShown(fromTray, context, { ...all, status: 'known' })).toBe(false);
    expect(isShown(fromTray, context, { ...all, status: 'interpolated' })).toBe(false);
  });

  it('shows exactly the unpersisted files for unpersisted, drag or not', () => {
    const unpersisted: MapFilters = { ...all, status: 'unpersisted' };
    expect(isShown(item('u', 'confirmed'), context, unpersisted)).toBe(true);
    expect(isShown(item('u', 'confirmed', true), context, unpersisted)).toBe(true);
    expect(isShown(item('a', 'confirmed'), context, unpersisted)).toBe(false);
    expect(isShown(item('a', 'estimate', true), context, unpersisted)).toBe(false);
    expect(isShown(item('u', 'confirmed'), context, { ...unpersisted, hiddenFileIds: hidden('u') })).toBe(false);
  });
});
