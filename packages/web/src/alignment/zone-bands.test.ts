import { describe, expect, it } from 'vitest';
import type { UtcOffsetRule } from '@geotagger/shared';
import { bandLabel, bandShortLabel, zoneBands } from './zone-bands.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 6, 12, 6, 0, 0);

function rule(id: number, fromHours: number, toHours: number, offsetMinutes: number, zone: string | null): UtcOffsetRule {
  return { id, fromUtc: T0 + fromHours * HOUR, toUtc: T0 + toHours * HOUR, offsetMinutes, source: 'gps', zone };
}

const view = { fromMs: T0 - 5 * HOUR, toMs: T0 + 100 * HOUR };

describe('zoneBands', () => {
  it('draws one period as an observed band reaching the view edges unobserved', () => {
    const bands = zoneBands([rule(1, 0, 48, 120, 'Europe/Berlin')], view, null);

    expect(bands.map((b) => b.observed)).toEqual([false, true, false]);
    expect(bands.every((b) => b.offsetMinutes === 120)).toBe(true);
    expect(bands[1]).toMatchObject({ fromMs: T0, toMs: T0 + 48 * HOUR, zone: 'Europe/Berlin' });
    // Nearest-rule-wins is what makes the edges legitimate, so they carry the period.
    expect(bands[0]?.fromMs).toBe(view.fromMs);
    expect(bands[2]?.toMs).toBe(view.toMs);
  });

  it('keeps the gap between two periods as a crossing of its own', () => {
    const bands = zoneBands(
      [rule(1, 0, 20, 120, 'Europe/Berlin'), rule(2, 30, 60, 540, 'Asia/Tokyo')],
      view,
      null,
    );

    const crossing = bands.find((b) => b.crossing !== null);
    expect(crossing).toMatchObject({
      fromMs: T0 + 20 * HOUR,
      toMs: T0 + 30 * HOUR,
      observed: false,
      offsetMinutes: null,
      zone: null,
    });
    expect(bandLabel(crossing!)).toBe('+02:00 → +09:00');
    expect(bandShortLabel(crossing!)).toBe('→');
  });

  it('does not call a zone change a crossing when the clock does not change', () => {
    // Paris to Madrid: different zone, same offset. Nothing to correct, nothing to warn about.
    const bands = zoneBands(
      [rule(1, 0, 20, 120, 'Europe/Paris'), rule(2, 30, 60, 120, 'Europe/Madrid')],
      view,
      null,
    );

    const gap = bands[2];
    expect(gap).toMatchObject({ observed: false, offsetMinutes: 120, zone: null, crossing: null });
    expect(bandLabel(gap!)).toBe('+02:00');
  });

  it('shows the folder answer as a single unobserved band when no rule exists', () => {
    expect(zoneBands([], view, 60)).toEqual([
      { fromMs: view.fromMs, toMs: view.toMs, observed: false, offsetMinutes: 60, zone: null, crossing: null },
    ]);
  });

  it('draws nothing when nothing is known', () => {
    expect(zoneBands([], view, null)).toEqual([]);
  });

  it('keeps a period established by a single fix', () => {
    const bands = zoneBands([rule(1, 10, 10, 120, 'Europe/Berlin')], view, null);
    const observed = bands.filter((b) => b.observed);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.fromMs).toBe(observed[0]?.toMs);
  });

  it('labels a period by its city, and falls back to the offset alone', () => {
    const bands = zoneBands([rule(1, 0, 20, -300, 'America/New_York')], view, null);
    expect(bandLabel(bands[1]!)).toBe('-05:00 New York');
    expect(bandShortLabel(bands[1]!)).toBe('-05:00');
  });
});
