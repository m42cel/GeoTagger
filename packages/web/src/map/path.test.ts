import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, PositionSource, TimelineFile } from '@geotagger/shared';
import { pathVertices } from './path.js';

function item(
  effectiveMs: number | null,
  source: PositionSource,
  lat: number,
  lon: number,
  anchor: [number, number] | null = null,
): { position: ComputedPosition; timelineFile: TimelineFile | null } {
  return {
    position: {
      fileId: 'f' as FileId,
      lat,
      lon,
      uncertaintyM: null,
      source,
      anchorLat: anchor?.[0] ?? null,
      anchorLon: anchor?.[1] ?? null,
    },
    timelineFile: { effectiveMs } as TimelineFile,
  };
}

describe('pathVertices', () => {
  it('runs through anchors only, in effective-time order, skipping interpolated files between them', () => {
    expect(
      pathVertices([
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
      pathVertices([
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
      pathVertices([
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

  it('runs through a re-dragged file’s old anchor, and leaves out a drag with no anchor underneath', () => {
    expect(
      pathVertices([
        item(1000, 'camera-gps', 1, 1),
        item(1500, 'manual', 9, 9),
        item(2000, 'manual', 8, 8, [2, 2]),
        item(3000, 'camera-gps', 3, 3),
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('leaves out files with no effective time and is empty without anchors', () => {
    expect(pathVertices([item(null, 'camera-gps', 5, 5), item(1000, 'camera-gps', 1, 1)])).toEqual([[1, 1]]);
    expect(pathVertices([item(1000, 'estimate', 1, 1), item(2000, 'manual', 2, 2)])).toEqual([]);
  });
});
