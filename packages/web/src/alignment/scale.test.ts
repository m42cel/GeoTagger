import { describe, expect, it } from 'vitest';
import { axisTicks, type TimeScale } from './scale.js';

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
