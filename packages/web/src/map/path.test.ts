import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, PositionSource, TimelineFile } from '@geotagger/shared';
import { pathVertices } from './path.js';

let nextId = 0;

function item(
  effectiveMs: number | null,
  source: PositionSource,
  lat: number,
  lon: number,
  pending: [number, number] | null = null,
): { position: ComputedPosition; timelineFile: TimelineFile | null } {
  return {
    position: {
      fileId: `f${nextId++}` as FileId,
      base: { lat, lon, uncertaintyM: null, source },
      pending: pending && { lat: pending[0], lon: pending[1] },
    },
    timelineFile: { effectiveMs } as TimelineFile,
  };
}

const points = (items: Parameters<typeof pathVertices>[0]): [number, number][] =>
  pathVertices(items).map((v) => [v.lat, v.lon]);

describe('pathVertices', () => {
  it('runs through anchors only, in effective-time order, skipping interpolated files between them', () => {
    expect(
      points([
        item(3000, 'camera-gps', 3, 3),
        item(1000, 'camera-gps', 1, 1),
        item(2000, 'estimate', 2, 2),
        item(2500, 'confirmed', 2.5, 2.5),
      ]),
    ).toEqual([
      [1, 1],
      [2.5, 2.5],
      [3, 3],
    ]);
  });

  it('extends to the farthest extrapolated file on each side', () => {
    expect(
      points([
        item(0, 'estimate', 0, 0),
        item(500, 'estimate', 0.5, 0.5),
        item(1000, 'camera-gps', 1, 1),
        item(2000, 'camera-gps', 2, 2),
        item(2500, 'estimate', 2.5, 2.5),
        item(3000, 'estimate', 3, 3),
      ]),
    ).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('ends a tail at the farthest file, not the outermost in time, when the cap folds files back onto the anchor', () => {
    expect(
      points([
        item(1000, 'camera-gps', 1, 1),
        item(2000, 'camera-gps', 2, 2),
        item(2500, 'estimate', 2.5, 2.5),
        item(9000, 'estimate', 2, 2),
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [2.5, 2.5],
    ]);
  });

  it('runs through a re-dragged file’s old anchor, never through a drag', () => {
    expect(
      points([
        item(1000, 'camera-gps', 1, 1),
        item(1500, 'estimate', 1.5, 1.5, [9, 9]),
        item(2000, 'confirmed', 2, 2, [8, 8]),
        item(3000, 'camera-gps', 3, 3),
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('leaves out files with no effective time and is empty without anchors', () => {
    expect(points([item(null, 'camera-gps', 5, 5), item(1000, 'camera-gps', 1, 1)])).toEqual([[1, 1]]);
    expect(points([item(1000, 'estimate', 1, 1), item(2000, 'estimate', 2, 2, [3, 3])])).toEqual([]);
  });

  it('names the file each corner belongs to', () => {
    const anchor = item(1000, 'camera-gps', 1, 1);
    const redragged = item(2000, 'confirmed', 2, 2, [8, 8]);
    expect(pathVertices([anchor, redragged]).map((v) => v.fileId)).toEqual([anchor.position.fileId, redragged.position.fileId]);
  });
});
