import { describe, it, expect } from 'vitest';
import {
  driftSecondsPerHour,
  effectiveMs,
  formatOffset,
  formatUtcOffset,
  msToNaive,
  naiveToMs,
  offsetSecondsAt,
  parseOffsetSeconds,
  parseUtcOffsetMinutes,
  rampIsDefined,
  HOUR_MS,
} from './time.js';

const t0 = naiveToMs('2024-07-12T10:00:00') as number;
const t1 = naiveToMs('2024-07-12T20:00:00') as number;

describe('naiveToMs', () => {
  it('reads a wall clock as if it were UTC', () => {
    expect(naiveToMs('1970-01-01T00:00:01')).toBe(1000);
  });

  it('round-trips through msToNaive', () => {
    expect(msToNaive(naiveToMs('2024-07-12T14:32:10') as number)).toBe('2024-07-12T14:32:10');
  });

  it('rejects nothing and nonsense alike', () => {
    expect(naiveToMs(null)).toBeNull();
    expect(naiveToMs('')).toBeNull();
    expect(naiveToMs('not a date')).toBeNull();
  });
});

describe('offsetSecondsAt', () => {
  const constant = { offsetStartSeconds: 3732, offsetEndSeconds: 3732, firstCaptureMs: t0, lastCaptureMs: t1 };
  const stretched = { offsetStartSeconds: 3720, offsetEndSeconds: 4264, firstCaptureMs: t0, lastCaptureMs: t1 };

  it('applies a constant offset to every file', () => {
    expect(offsetSecondsAt(constant, t0)).toBe(3732);
    expect(offsetSecondsAt(constant, (t0 + t1) / 2)).toBe(3732);
    expect(offsetSecondsAt(constant, t1)).toBe(3732);
  });

  it('ramps linearly across a stretched strip', () => {
    expect(offsetSecondsAt(stretched, t0)).toBe(3720);
    expect(offsetSecondsAt(stretched, (t0 + t1) / 2)).toBe(3992);
    expect(offsetSecondsAt(stretched, t1)).toBe(4264);
  });

  it('clamps outside the strip rather than extrapolating the ramp', () => {
    expect(offsetSecondsAt(stretched, t0 - HOUR_MS)).toBe(3720);
    expect(offsetSecondsAt(stretched, t1 + HOUR_MS)).toBe(4264);
  });

  it('falls back to the start offset where a ramp is undefined', () => {
    const single = { offsetStartSeconds: 60, offsetEndSeconds: 120, firstCaptureMs: t0, lastCaptureMs: t0 };
    expect(rampIsDefined(single)).toBe(false);
    expect(offsetSecondsAt(single, t0)).toBe(60);
    expect(offsetSecondsAt({ ...single, firstCaptureMs: null, lastCaptureMs: null }, null)).toBe(60);
  });

  it('reports drift per hour', () => {
    expect(driftSecondsPerHour(stretched)).toBeCloseTo(54.4, 5);
    expect(driftSecondsPerHour(constant)).toBe(0);
  });
});

describe('effectiveMs', () => {
  it('subtracts the UTC offset and adds the correction', () => {
    // 14:00 local at +02:00 is 12:00 UTC; a +1h correction makes it 13:00 UTC.
    const raw = naiveToMs('2024-07-12T14:00:00') as number;
    expect(effectiveMs(raw, 3600, 120)).toBe(naiveToMs('2024-07-12T13:00:00'));
  });

  it('leaves a UTC-stamped video alone when nothing is corrected', () => {
    const raw = naiveToMs('2024-07-12T12:00:00') as number;
    expect(effectiveMs(raw, 0, 0)).toBe(raw);
  });
});

describe('formatOffset / parseOffsetSeconds', () => {
  it('formats the readout of SPEC §4.3', () => {
    expect(formatOffset(3732)).toBe('+1h 02m 12s');
    expect(formatOffset(-2700)).toBe('-45m 00s');
    expect(formatOffset(-7)).toBe('-7s');
    expect(formatOffset(0)).toBe('0');
  });

  it('reads back what it writes', () => {
    for (const seconds of [0, 1, -1, 59, 3732, -7200, 86399]) {
      expect(parseOffsetSeconds(formatOffset(seconds))).toBe(seconds);
    }
  });

  it('accepts the other forms a user types', () => {
    expect(parseOffsetSeconds('1:02:12')).toBe(3732);
    expect(parseOffsetSeconds('-90m')).toBe(-5400);
    expect(parseOffsetSeconds('2h')).toBe(7200);
    expect(parseOffsetSeconds('45')).toBe(45);
    expect(parseOffsetSeconds('  +02:00 ')).toBe(120);
  });

  it('returns null rather than zero for input it cannot read', () => {
    expect(parseOffsetSeconds('')).toBeNull();
    expect(parseOffsetSeconds('soon')).toBeNull();
  });
});

describe('UTC offsets', () => {
  it('formats the EXIF form', () => {
    expect(formatUtcOffset(120)).toBe('+02:00');
    expect(formatUtcOffset(-330)).toBe('-05:30');
    expect(formatUtcOffset(0)).toBe('+00:00');
  });

  it('parses what a user might type', () => {
    expect(parseUtcOffsetMinutes('+02:00')).toBe(120);
    expect(parseUtcOffsetMinutes('-0530')).toBe(-330);
    expect(parseUtcOffsetMinutes('Z')).toBe(0);
    expect(parseUtcOffsetMinutes('+2')).toBe(120);
    expect(parseUtcOffsetMinutes('nope')).toBeNull();
  });
});
