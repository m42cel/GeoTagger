import { describe, expect, it } from 'vitest';
import { findSuspiciousGps } from './plausibility.js';
import type { KnownPositionSource, PositionInput } from './positions.js';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Roughly 1 km of latitude. */
const KM = 1 / 111.2;

function at(fileId: string, ms: number, latKm: number, source: KnownPositionSource = 'camera-gps'): PositionInput {
  return { fileId, effectiveMs: ms, known: { lat: latKm * KM, lon: 0, source }, pending: null };
}

const ids = (files: PositionInput[]) => findSuspiciousGps(files).map((s) => s.fileId);

describe('findSuspiciousGps', () => {
  it('flags a single fix far off a series of close photos', () => {
    const files = [at('a', 0, 0), at('b', MIN_MS, 50), at('c', 2 * MIN_MS, 0.1), at('d', 3 * MIN_MS, 0.2)];
    const [suspicious] = findSuspiciousGps(files);
    expect(ids(files)).toEqual(['b']);
    expect(suspicious?.fromPreviousKmh).toBeCloseTo(3000, -1);
    expect(suspicious?.toNextKmh).toBeCloseTo(2994, -1);
    expect(suspicious?.neighborsApartM).toBeCloseTo(100, -1);
  });

  it('leaves the bad fix’s neighbors alone', () => {
    const files = [at('z', -MIN_MS, 0), at('a', 0, 0), at('b', MIN_MS, 50), at('c', 2 * MIN_MS, 0), at('d', 3 * MIN_MS, 0)];
    expect(ids(files)).toEqual(['b']);
  });

  it('does not flag a stop at the airport on the way to a flight', () => {
    const files = [at('home', 0, 0), at('airport', HOUR_MS, 40), at('destination', 4 * HOUR_MS, 1000)];
    expect(ids(files)).toEqual([]);
  });

  it('does not flag photos out of a plane window along the way', () => {
    const files = [at('a', 0, 0), at('b', HOUR_MS, 800), at('c', 2 * HOUR_MS, 1600)];
    expect(ids(files)).toEqual([]);
  });

  it('does not flag a day trip at driving speed with no photos on the road', () => {
    const files = [at('home', 0, 0), at('trip', 3 * HOUR_MS, 300), at('back', 6 * HOUR_MS, 0)];
    expect(ids(files)).toEqual([]);
  });

  it('ignores GPS jitter within a burst taken in the same second', () => {
    const files = [at('a', 0, 0), at('b', 0, 0.05), at('c', 0, 0)];
    expect(ids(files)).toEqual([]);
  });

  it('flags a fix elsewhere at the same instant, with no speed to show', () => {
    const files = [at('a', 0, 0), at('b', 0, 20), at('c', 0, 0)];
    expect(findSuspiciousGps(files)).toEqual([
      { fileId: 'b', fromPreviousKmh: null, toNextKmh: null, neighborsApartM: 0 },
    ]);
  });

  it('never flags the first or last anchor, which have only one neighbor', () => {
    const files = [at('a', 0, 50), at('b', MIN_MS, 0), at('c', 2 * MIN_MS, 0), at('d', 3 * MIN_MS, 50)];
    expect(ids(files)).toEqual([]);
  });

  it('never flags a confirmed position, but judges against it', () => {
    expect(ids([at('a', 0, 0), at('b', MIN_MS, 50, 'confirmed'), at('c', 2 * MIN_MS, 0)])).toEqual([]);
    expect(ids([at('a', 0, 0, 'confirmed'), at('b', MIN_MS, 50), at('c', 2 * MIN_MS, 0, 'confirmed')])).toEqual(['b']);
  });

  it('only judges against anchors, skipping estimates and undated files', () => {
    const files: PositionInput[] = [
      at('a', 0, 0),
      { fileId: 'estimate', effectiveMs: MIN_MS / 2, known: null, pending: null },
      at('b', MIN_MS, 50),
      { fileId: 'undated', effectiveMs: null, known: { lat: 0, lon: 0, source: 'camera-gps' }, pending: null },
      at('c', 2 * MIN_MS, 0),
    ];
    expect(ids(files)).toEqual(['b']);
  });

  it('keeps judging camera GPS while a drag is pending on top of it', () => {
    const files = [at('a', 0, 0), { ...at('b', MIN_MS, 50), pending: { lat: 0, lon: 0 } }, at('c', 2 * MIN_MS, 0)];
    expect(ids(files)).toEqual(['b']);
  });
});
