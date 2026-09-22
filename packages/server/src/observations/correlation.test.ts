import { describe, it, expect } from 'vitest';
import { correlate } from './correlation.js';

const BASE = Date.UTC(2024, 6, 12, 9, 0, 0);

/**
 * A day's shooting: bursts at a few moments, which is what a real trip looks like and
 * what the correlation has to find. Deterministic, so a failure means a real change.
 */
function shootingDay(seed = 1): number[] {
  const out: number[] = [];
  let rng = seed;
  const next = (): number => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng / 2147483648;
  };
  for (const hour of [0, 1.5, 3, 5.5, 7, 9]) {
    const burst = BASE + hour * 3_600_000;
    for (let i = 0; i < 6; i += 1) out.push(Math.round(burst + next() * 600_000));
  }
  return out.sort((a, b) => a - b);
}

/** The same moments seen by a second camera: a little jitter, a few misses. */
function secondCamera(times: readonly number[], shiftMs: number): number[] {
  return times
    .filter((_, i) => i % 4 !== 0)
    .map((t, i) => t + shiftMs + ((i % 3) - 1) * 20_000)
    .sort((a, b) => a - b);
}

describe('correlate', () => {
  it('recovers an injected offset from two views of the same day', () => {
    const reference = shootingDay();
    const moving = secondCamera(reference, -2 * 3_600_000);
    const result = correlate(moving, reference);
    expect(result.offsetSeconds).not.toBeNull();
    expect(Math.abs((result.offsetSeconds as number) - 7200)).toBeLessThanOrEqual(120);
    expect(result.confidence).toBeGreaterThan(0.25);
  });

  it('recovers an offset in the other direction too', () => {
    const reference = shootingDay(7);
    const moving = secondCamera(reference, 45 * 60_000);
    const result = correlate(moving, reference);
    expect(Math.abs((result.offsetSeconds as number) + 2700)).toBeLessThanOrEqual(120);
  });

  it('finds nothing at all when the shift is outside the searched window', () => {
    const reference = shootingDay();
    const moving = secondCamera(reference, 72 * 3_600_000);
    const result = correlate(moving, reference);
    expect(result.offsetSeconds).toBeNull();
  });

  it('reports too few shots rather than a number', () => {
    const result = correlate([BASE, BASE + 1000], [BASE, BASE + 1000]);
    expect(result.offsetSeconds).toBeNull();
    expect(result.note).toMatch(/too few/i);
  });

  it('reports low confidence on a very regular pattern', () => {
    // A shot every ten minutes on both cameras: every ten-minute shift fits equally
    // well, which is exactly the failure mode the spec says to state rather than hide.
    const regular = Array.from({ length: 60 }, (_, i) => BASE + i * 600_000);
    const result = correlate(regular.map((t) => t - 1_800_000), regular);
    expect(result.confidence).toBeLessThan(0.25);
    expect(result.offsetSeconds).toBeNull();
    expect(result.note).toMatch(/no clear match/i);
  });

  it('says so when the two devices were never in use together', () => {
    const a = shootingDay();
    const b = a.map((t) => t + 30 * 86_400_000);
    const result = correlate(a, b);
    expect(result.offsetSeconds).toBeNull();
    expect(result.support).toBe(0);
  });
});
