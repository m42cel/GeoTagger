import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, PositionSource, TimelineFile } from '@geotagger/shared';
import { pathSegments, pathVertices, segmentTooltip, speedColor, type PathVertex } from './path.js';

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

const HOUR = 3_600_000;

function vertex(effectiveMs: number, lat: number, lon: number, anchor = true): PathVertex {
  return { fileId: `v${nextId++}` as FileId, effectiveMs, lat, lon, anchor };
}

describe('pathVertices', () => {
  it('marks the extrapolated tail ends as the only non-anchors and carries each corner’s time', () => {
    const vertices = pathVertices([
      item(0, 'estimate', 0, 0),
      item(1000, 'camera-gps', 1, 1),
      item(2000, 'confirmed', 2, 2),
      item(3000, 'estimate', 3, 3),
    ]);
    expect(vertices.map((v) => [v.effectiveMs, v.anchor])).toEqual([
      [0, false],
      [1000, true],
      [2000, true],
      [3000, false],
    ]);
  });
});

describe('pathSegments', () => {
  it('gives each segment between anchors its distance over time in km/h', () => {
    // One degree of latitude is ~111.2 km.
    const [segment] = pathSegments([vertex(0, 0, 0), vertex(2 * HOUR, 1, 0)]);
    expect(segment?.speedKmh).toBeCloseTo(55.6, 1);
    expect(segment?.durationMs).toBe(2 * HOUR);
  });

  it('has no speed on a tail segment or between anchors at the same instant', () => {
    const segments = pathSegments([vertex(0, 0, 0, false), vertex(HOUR, 0.1, 0), vertex(HOUR, 0.2, 0), vertex(2 * HOUR, 0.3, 0, false)]);
    expect(segments.map((s) => s.speedKmh)).toEqual([null, null, null]);
  });

  it('is empty for fewer than two corners', () => {
    expect(pathSegments([])).toEqual([]);
    expect(pathSegments([vertex(0, 0, 0)])).toEqual([]);
  });
});

describe('speedColor', () => {
  it('runs from green when slow through yellow to red when fast, clamped at both ends', () => {
    expect(speedColor(0)).toBe('hsl(120, 85%, 40%)');
    expect(speedColor(3)).toBe('hsl(120, 85%, 40%)');
    expect(speedColor(Math.sqrt(3 * 150))).toBe('hsl(60, 85%, 40%)');
    expect(speedColor(150)).toBe('hsl(0, 85%, 40%)');
    expect(speedColor(900)).toBe('hsl(0, 85%, 40%)');
  });

  it('keeps segments without a speed out of the scale', () => {
    expect(speedColor(null)).toBe('#333333');
  });
});

describe('segmentTooltip', () => {
  it('shows speed, distance and time between anchors', () => {
    const [segment] = pathSegments([vertex(0, 0, 0), vertex(2 * HOUR + 5 * 60_000, 1, 0)]);
    expect(segment && segmentTooltip(segment)).toBe('≈ 53 km/h · 111 km in 2 h 05 min');
  });

  it('uses meters, seconds and a decimal for slow, short segments', () => {
    const [segment] = pathSegments([vertex(0, 0, 0), vertex(45_000, 0.0005, 0)]);
    expect(segment && segmentTooltip(segment)).toBe('≈ 4.4 km/h · 56 m in 45 s');
  });

  it('says so for anchors at the same instant and is silent on tail segments', () => {
    const [same, tail] = pathSegments([vertex(0, 0, 0), vertex(0, 0.01, 0), vertex(HOUR, 0.02, 0, false)]);
    expect(same && segmentTooltip(same)).toBe('1.1 km · same time');
    expect(tail && segmentTooltip(tail)).toBeNull();
  });
});
