import { describe, expect, it } from 'vitest';
import { axisTicks, xOf, zoomToSeparate, type TimeScale } from './scale.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 6, 12, 14, 0, 0);

/** 14:00–24:00 UTC at an hour per 100 px, so ticks fall hourly. */
const scale: TimeScale = { startMs: T0, msPerPx: HOUR / 100, widthPx: 1000 };

describe('axisTicks', () => {
  it('labels every tick in one offset when nothing changes', () => {
    const ticks = axisTicks(scale, [{ fromMs: -Infinity, toMs: Infinity, offsetMinutes: -360 }]);
    expect(ticks.map((t) => t.label).slice(0, 3)).toEqual(['08:00', '09:00', '10:00']);
  });

  it('labels each side of an offset change in its own offset', () => {
    const seam = T0 + 5.5 * HOUR;
    const ticks = axisTicks(scale, [
      { fromMs: -Infinity, toMs: seam, offsetMinutes: -360 },
      { fromMs: seam, toMs: Infinity, offsetMinutes: -420 },
    ]);

    // Going west an hour repeats: 13:00 at −06:00, then 13:00 again at −07:00.
    expect(ticks.map((t) => t.label)).toEqual([
      '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '13:00', '14:00', '15:00', '16:00', '17:00',
    ]);
    // A photo taken at 15:00 −07:00 is 22:00 UTC, and the 15:00 tick sits right there.
    expect(ticks.find((t) => t.label === '15:00')?.ms).toBe(Date.UTC(2024, 6, 12, 22, 0, 0));
  });

  it('drops a tick that would crowd the one before it across a jump', () => {
    // Nepal to India: +05:45 → +05:30. Local hours fall at :15 UTC, then at :30.
    const seam = T0 + 5.3 * HOUR;
    const ticks = axisTicks(scale, [
      { fromMs: -Infinity, toMs: seam, offsetMinutes: 345 },
      { fromMs: seam, toMs: Infinity, offsetMinutes: 330 },
    ]);

    // 01:00 +05:45 is 19:15 UTC; 01:00 +05:30 at 19:30 would crowd it and is dropped.
    expect(ticks.map((t) => t.ms)).toContain(Date.UTC(2024, 6, 12, 19, 15, 0));
    expect(ticks.map((t) => t.ms)).not.toContain(Date.UTC(2024, 6, 12, 19, 30, 0));
    expect(ticks.map((t) => t.ms)).toContain(Date.UTC(2024, 6, 12, 20, 30, 0));
  });
});

describe('zoomToSeparate', () => {
  const THUMB = 100;
  const MIN = 60_000;
  // Gaps of 1, 3 and 1 minutes: the widest is between the second and third photo.
  const stack = [T0, T0 + MIN, T0 + 4 * MIN, T0 + 5 * MIN];

  it('zooms until the widest gap is just over a thumbnail', () => {
    const out = zoomToSeparate(scale, stack, T0, THUMB);
    const gapPx = xOf(out, T0 + 4 * MIN) - xOf(out, T0 + MIN);
    expect(gapPx).toBeGreaterThanOrEqual(THUMB);
    expect(gapPx).toBeLessThan(THUMB * 1.1);
  });

  it('centres on the widest gap when the clicked photo stays in view', () => {
    const out = zoomToSeparate(scale, stack, T0 + MIN, THUMB);
    expect(xOf(out, T0 + 2.5 * MIN)).toBeCloseTo(scale.widthPx / 2);
  });

  it('shifts the view to keep a clicked photo far from the gap in view', () => {
    // An hour of shots a minute apart, then one two minutes on: the gap is an hour away.
    const wide = [...Array.from({ length: 61 }, (_, i) => T0 + i * MIN), T0 + 62 * MIN];
    const out = zoomToSeparate(scale, wide, T0, THUMB);
    expect(xOf(out, T0)).toBeCloseTo(THUMB / 2);
  });

  it('stops at the deepest zoom for photos taken in the same instant', () => {
    const out = zoomToSeparate(scale, [T0, T0], T0, THUMB);
    expect(out.msPerPx * out.widthPx).toBe(1000);
  });
});
