import { describe, expect, it } from 'vitest';
import { distanceMeters } from './geo.js';
import {
  computePositions,
  DEFAULT_INTERPOLATION_PARAMS,
  type InterpolationParams,
  type PositionInput,
} from './positions.js';

const A = { lat: 0, lon: 0 };
const C = { lat: 1, lon: 0 }; // 1° of pure latitude north of A
const HOUR_MS = 3_600_000;

function kmhToMs(kmh: number): number {
  return (kmh * 1000) / 3600;
}

describe('computePositions — between two anchors (SPEC §5.1, §5.2)', () => {
  const files: PositionInput[] = [
    { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
    { fileId: 2, effectiveMs: HOUR_MS, known: { ...C, source: 'camera-gps' } },
    { fileId: 3, effectiveMs: HOUR_MS / 2, known: null }, // midpoint in time
    { fileId: 4, effectiveMs: 60_000, known: null }, // one minute after A
  ];

  it('places a file at the fraction of the great circle its time implies', () => {
    const result = computePositions(files);
    const mid = result.get(3)!;
    expect(mid.lat).toBeCloseTo(0.5, 3);
    expect(mid.lon).toBeCloseTo(0, 6);
    expect(mid.source).toBe('estimate');
  });

  it('gives the midpoint a wide reachability circle, bounded by the corridor between anchors', () => {
    const d = distanceMeters(A, C);
    const vRef = kmhToMs(DEFAULT_INTERPOLATION_PARAMS.vCapKmh); // v_implied's 2x exceeds the 200 km/h cap here
    const slack = vRef * 3600 - d;
    const result = computePositions(files);
    expect(result.get(3)!.uncertaintyM).toBeCloseTo(Math.min(vRef * 1800, slack / 2), 0);
  });

  it('gives a file one minute after A a tight circle even though C is far away', () => {
    const result = computePositions(files);
    const oneMinuteAfter = result.get(4)!.uncertaintyM!;
    const midpoint = result.get(3)!.uncertaintyM!;
    // The whole point of the reachability bound (SPEC §5.2): a photo shortly after an
    // anchor is tightly placed near it, not smeared across the full corridor to C.
    expect(oneMinuteAfter).toBeLessThan(midpoint / 10);
    const vRef = kmhToMs(DEFAULT_INTERPOLATION_PARAMS.vCapKmh);
    expect(oneMinuteAfter).toBeCloseTo(vRef * 60, 0);
  });

  it('never drops the radius below r_min', () => {
    const closeFiles: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: 1000, known: { ...A, source: 'camera-gps' } }, // same spot, 1s later
      { fileId: 3, effectiveMs: 500, known: null },
    ];
    const result = computePositions(closeFiles);
    expect(result.get(3)!.uncertaintyM).toBe(DEFAULT_INTERPOLATION_PARAMS.rMinM);
  });

  it('does not throw when the bracketing anchors share the same instant', () => {
    const tiedFiles: PositionInput[] = [
      { fileId: 1, effectiveMs: 1000, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: 1000, known: { ...C, source: 'camera-gps' } },
      { fileId: 3, effectiveMs: 1000, known: null },
    ];
    const result = computePositions(tiedFiles);
    const est = result.get(3)!;
    expect(est.lat).toBe(A.lat);
    expect(est.uncertaintyM).toBe(DEFAULT_INTERPOLATION_PARAMS.rMinM);
  });
});

describe('computePositions — extrapolation (SPEC §5.3)', () => {
  const files: PositionInput[] = [
    { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
    { fileId: 2, effectiveMs: HOUR_MS, known: { ...C, source: 'camera-gps' } },
    { fileId: 3, effectiveMs: -HOUR_MS / 2, known: null }, // before the first anchor
    { fileId: 4, effectiveMs: HOUR_MS * 1.5, known: null }, // after the last anchor
  ];

  it('continues the implied bearing backward before the first anchor', () => {
    const result = computePositions(files);
    const before = result.get(3)!;
    // A to C runs due north; continuing the same line backward from A lands south of it.
    expect(before.lat).toBeLessThan(A.lat);
    expect(before.lon).toBeCloseTo(0, 6);
    expect(before.source).toBe('estimate');
  });

  it('continues the implied bearing forward after the last anchor', () => {
    const result = computePositions(files);
    const after = result.get(4)!;
    expect(after.lat).toBeGreaterThan(C.lat);
    expect(after.lon).toBeCloseTo(0, 6);
  });

  it('grows uncertainty unboundedly with distance from the nearest anchor when no cap is set', () => {
    const farFuture: PositionInput[] = [...files, { fileId: 5, effectiveMs: HOUR_MS * 10, known: null }];
    const result = computePositions(farFuture);
    expect(result.get(5)!.uncertaintyM!).toBeGreaterThan(result.get(4)!.uncertaintyM!);
  });

  it('falls back to the nearest anchor with a very large circle beyond the extrapolation cap', () => {
    const params: InterpolationParams = { ...DEFAULT_INTERPOLATION_PARAMS, extrapolationMaxMinutes: 10 };
    const result = computePositions(files, params);
    const after = result.get(4)!; // 30 minutes past the last anchor, beyond the 10-minute cap
    expect(after.lat).toBe(C.lat);
    expect(after.lon).toBe(C.lon);
    expect(after.uncertaintyM).toBeGreaterThan(10_000);
  });
});

describe('computePositions — degenerate cases (SPEC §5.4, resolved with the user)', () => {
  it('sends every other file to the tray when there are zero anchors', () => {
    const files: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: null },
      { fileId: 2, effectiveMs: HOUR_MS, known: null },
    ];
    const result = computePositions(files);
    expect(result.get(1)!.source).toBe('none');
    expect(result.get(2)!.source).toBe('none');
  });

  it('treats a single anchor the same as no anchors for everyone else', () => {
    // Decided with the user: a lone anchor cannot imply a velocity (SPEC §5.2's
    // v_ref needs two points), so nothing else gets an honest estimate from it —
    // the anchor itself still keeps its own known position.
    const files: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: HOUR_MS, known: null },
    ];
    const result = computePositions(files);
    expect(result.get(1)!).toMatchObject({ lat: A.lat, lon: A.lon, uncertaintyM: null, source: 'camera-gps' });
    expect(result.get(2)!.source).toBe('none');
  });

  it('sends an undated file to the tray even when anchors exist elsewhere', () => {
    // Decided with the user: no capture time means no `t` to place it at, so it is
    // no better off than the zero-anchor case.
    const files: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: HOUR_MS, known: { ...C, source: 'camera-gps' } },
      { fileId: 3, effectiveMs: null, known: null },
    ];
    const result = computePositions(files);
    expect(result.get(3)!).toMatchObject({ lat: null, lon: null, source: 'none' });
  });

  it('spreads files sharing an effective timestamp onto the same point, not jittered apart', () => {
    const files: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: HOUR_MS, known: { ...C, source: 'camera-gps' } },
      { fileId: 3, effectiveMs: HOUR_MS / 4, known: null },
      { fileId: 4, effectiveMs: HOUR_MS / 4, known: null },
    ];
    const result = computePositions(files);
    const { fileId: _a, ...posA } = result.get(3)!;
    const { fileId: _b, ...posB } = result.get(4)!;
    expect(posA).toEqual(posB);
  });
});

describe('computePositions — known positions pass through unchanged (SPEC §5.6)', () => {
  it('keeps camera GPS, manual and confirmed positions as-is, with no uncertainty circle', () => {
    const files: PositionInput[] = [
      { fileId: 1, effectiveMs: 0, known: { ...A, source: 'camera-gps' } },
      { fileId: 2, effectiveMs: HOUR_MS, known: { ...C, source: 'manual' } },
      { fileId: 3, effectiveMs: HOUR_MS / 2, known: { lat: 5, lon: 5, source: 'confirmed' } },
    ];
    const result = computePositions(files);
    for (const f of files) {
      const pos = result.get(f.fileId)!;
      expect(pos.lat).toBe(f.known!.lat);
      expect(pos.lon).toBe(f.known!.lon);
      expect(pos.uncertaintyM).toBeNull();
      expect(pos.source).toBe(f.known!.source);
    }
  });
});
