import { describe, expect, it } from 'vitest';
import { formatDrift, rebaseCorrection, shiftSecondsAt, stretchAbout, type ClockCorrection } from './correction.js';
import { HOUR_MS } from './time.js';

const plain: ClockCorrection = { offsetSeconds: 120, drift: 0, driftOriginMs: null };

describe('shiftSecondsAt', () => {
  it('is the plain offset while there is no drift', () => {
    expect(shiftSecondsAt(plain, 0)).toBe(120);
    expect(shiftSecondsAt(plain, 50 * HOUR_MS)).toBe(120);
  });

  it('adds the drift in proportion to the distance from its origin', () => {
    const c: ClockCorrection = { offsetSeconds: 10, drift: 1 / 3600, driftOriginMs: 10 * HOUR_MS };
    expect(shiftSecondsAt(c, 10 * HOUR_MS)).toBe(10);
    expect(shiftSecondsAt(c, 13 * HOUR_MS)).toBeCloseTo(13, 9);
    expect(shiftSecondsAt(c, 8 * HOUR_MS)).toBeCloseTo(8, 9);
  });
});

describe('rebaseCorrection', () => {
  it('moves the origin without moving any file', () => {
    const c: ClockCorrection = { offsetSeconds: 10, drift: 2e-4, driftOriginMs: 10 * HOUR_MS };
    const moved = rebaseCorrection(c, 17 * HOUR_MS);
    for (const h of [0, 10, 17, 30]) {
      expect(shiftSecondsAt(moved, h * HOUR_MS)).toBeCloseTo(shiftSecondsAt(c, h * HOUR_MS), 9);
    }
  });
});

describe('stretchAbout', () => {
  it('holds the pivot exactly and moves the file by exactly the amount asked', () => {
    const c: ClockCorrection = { offsetSeconds: 7, drift: 1e-5, driftOriginMs: 0 };
    const stretched = stretchAbout(c, 10 * HOUR_MS, 16 * HOUR_MS, 60) as ClockCorrection;
    expect(shiftSecondsAt(stretched, 10 * HOUR_MS)).toBeCloseTo(shiftSecondsAt(c, 10 * HOUR_MS), 9);
    expect(shiftSecondsAt(stretched, 16 * HOUR_MS)).toBeCloseTo(shiftSecondsAt(c, 16 * HOUR_MS) + 60, 9);
    expect(stretched.driftOriginMs).toBe(10 * HOUR_MS);
  });

  it('cannot separate two files taken at the same instant', () => {
    expect(stretchAbout(plain, HOUR_MS, HOUR_MS, 5)).toBeNull();
  });
});

describe('formatDrift', () => {
  it('writes the drift as seconds a day', () => {
    expect(formatDrift(0)).toBe('0 s/day');
    expect(formatDrift(14 / 86_400)).toBe('+14 s/day');
    expect(formatDrift(-2.5 / 86_400)).toBe('-2.5 s/day');
  });

  it('moves up to minutes and hours as the drift grows', () => {
    expect(formatDrift(390 / 86_400)).toBe('+6.5 min/day');
    expect(formatDrift(-864 / 86_400)).toBe('-14 min/day');
    expect(formatDrift(0.05)).toBe('+1.2 h/day');
  });
});
