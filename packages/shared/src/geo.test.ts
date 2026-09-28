import { describe, expect, it } from 'vitest';
import { destinationPoint, distanceMeters, greatCirclePoint, initialBearing } from './geo.js';

// A pure latitude separation has no east/west component, so the haversine formula
// reduces to exactly `R * angle`, giving an exact reference value to check against.
const EARTH_RADIUS_M = 6_371_000;
const ONE_DEGREE_LAT_M = EARTH_RADIUS_M * (Math.PI / 180);

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters({ lat: 47, lon: 11 }, { lat: 47, lon: 11 })).toBe(0);
  });

  it('matches R × angle for a pure latitude separation', () => {
    const d = distanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(d).toBeCloseTo(ONE_DEGREE_LAT_M, 0);
  });

  it('is symmetric', () => {
    const a = { lat: 48.2, lon: 16.4 };
    const b = { lat: 41.9, lon: 12.5 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });
});

describe('initialBearing', () => {
  it('is 0° due north', () => {
    expect(initialBearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 3);
  });

  it('is 90° due east on the equator', () => {
    expect(initialBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 3);
  });

  it('is 180° due south', () => {
    expect(initialBearing({ lat: 1, lon: 0 }, { lat: 0, lon: 0 })).toBeCloseTo(180, 3);
  });
});

describe('destinationPoint', () => {
  it('reaches the known point when heading north by the distance between them', () => {
    const start = { lat: 47, lon: 11 };
    const end = { lat: 48, lon: 11 };
    const d = distanceMeters(start, end);
    const reached = destinationPoint(start, 0, d);
    expect(reached.lat).toBeCloseTo(end.lat, 3);
    expect(reached.lon).toBeCloseTo(end.lon, 3);
  });

  it('round-trips: distance and bearing there, then back, lands close to start', () => {
    const start = { lat: 10, lon: 20 };
    const end = { lat: -5, lon: 40 };
    const d = distanceMeters(start, end);
    const bearingThere = initialBearing(start, end);
    const there = destinationPoint(start, bearingThere, d);
    expect(there.lat).toBeCloseTo(end.lat, 2);
    expect(there.lon).toBeCloseTo(end.lon, 2);
  });
});

describe('greatCirclePoint', () => {
  const a = { lat: 0, lon: 0 };
  const c = { lat: 0, lon: 10 };

  it('is a at f=0 and c at f=1', () => {
    expect(greatCirclePoint(a, c, 0)).toEqual(a);
    const atC = greatCirclePoint(a, c, 1);
    expect(atC.lat).toBeCloseTo(c.lat, 3);
    expect(atC.lon).toBeCloseTo(c.lon, 3);
  });

  it('sits at the midpoint at f=0.5, on the equator between two equatorial points', () => {
    const mid = greatCirclePoint(a, c, 0.5);
    expect(mid.lat).toBeCloseTo(0, 3);
    expect(mid.lon).toBeCloseTo(5, 3);
  });

  it('returns a when a and c coincide', () => {
    expect(greatCirclePoint(a, a, 0.5)).toEqual(a);
  });
});
