import { describe, expect, it } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import { dateRange, parseLocalTime } from './SelectionPanel.js';

const at = (iso: string) => naiveToMs(iso) as number;

describe('dateRange', () => {
  it('names one day once', () => {
    expect(dateRange(at('2024-07-12T08:00:00'), at('2024-07-12T20:00:00'), 0)).toBe('12 Jul');
  });

  it('shares the month within one', () => {
    expect(dateRange(at('2024-07-12T08:00:00'), at('2024-07-21T20:00:00'), 0)).toBe('12–21 Jul');
  });

  it('names both months across a month boundary, and both years across a year', () => {
    expect(dateRange(at('2024-06-30T08:00:00'), at('2024-07-02T08:00:00'), 0)).toBe('30 Jun – 2 Jul');
    expect(dateRange(at('2024-12-30T08:00:00'), at('2025-01-02T08:00:00'), 0)).toBe('30 Dec 2024 – 2 Jan 2025');
  });

  it('reads the days in the display offset, not in UTC', () => {
    // 23:30 UTC on the 12th is already the 13th at +02:00.
    expect(dateRange(at('2024-07-12T23:30:00'), at('2024-07-13T10:00:00'), 120)).toBe('13 Jul');
  });

  it('has nothing to say about an undated strip', () => {
    expect(dateRange(null, null, 0)).toBeNull();
  });
});

describe('parseLocalTime', () => {
  it('reads the corrected time as the card shows it, and looser forms', () => {
    expect(parseLocalTime('2024-07-12 15:34:22')).toBe('2024-07-12T15:34:22');
    expect(parseLocalTime(' 2024-07-12T15:34 ')).toBe('2024-07-12T15:34:00');
    expect(parseLocalTime('2024-07-12 9:05:00')).toBe('2024-07-12T09:05:00');
  });

  it('refuses what is not a time, so a typo leaves the strip alone', () => {
    expect(parseLocalTime('15:34')).toBeNull();
    expect(parseLocalTime('2024-07-12 25:00:00')).toBeNull();
    expect(parseLocalTime('yesterday')).toBeNull();
  });
});
