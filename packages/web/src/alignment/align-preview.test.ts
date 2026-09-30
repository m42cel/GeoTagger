import { describe, expect, it } from 'vitest';
import { alignBottomToTop, alignDisabledReason, alignTopToBottom, type AlignPreviewSlot } from './align-preview.js';

function slot(stripId: number, effectiveMs: number, offsetSeconds: number, locked = false): AlignPreviewSlot {
  return { stripId, effectiveMs, offsetSeconds, locked };
}

describe('alignTopToBottom', () => {
  it('shifts the top strip so its photo lands on the bottom photo', () => {
    const top = slot(1, 1_000_000, 30);
    const bottom = slot(2, 1_062_000, -10);

    expect(alignTopToBottom(top, bottom)).toEqual({ stripId: 1, offsetSeconds: 92, alignedMs: 1_062_000 });
  });

  it('rounds sub-second differences to the nearest whole second', () => {
    const top = slot(1, 1_000_400, 0);
    const bottom = slot(2, 1_002_000, 0);

    // (1_002_000 - 1_000_400) / 1000 = 1.6s → rounds to 2.
    expect(alignTopToBottom(top, bottom)?.offsetSeconds).toBe(2);
  });

  it('is disabled when either pane is empty', () => {
    expect(alignTopToBottom(null, slot(2, 0, 0))).toBeNull();
    expect(alignTopToBottom(slot(1, 0, 0), null)).toBeNull();
  });

  it('is disabled when the strip being moved is locked', () => {
    expect(alignTopToBottom(slot(1, 0, 0, true), slot(2, 1000, 0))).toBeNull();
  });

  it('is still enabled when the other strip is locked', () => {
    expect(alignTopToBottom(slot(1, 0, 0), slot(2, 1000, 0, true))).not.toBeNull();
  });
});

describe('alignBottomToTop', () => {
  it('shifts the bottom strip so its photo lands on the top photo', () => {
    const top = slot(1, 1_062_000, -10);
    const bottom = slot(2, 1_000_000, 30);

    expect(alignBottomToTop(top, bottom)).toEqual({ stripId: 2, offsetSeconds: 92, alignedMs: 1_062_000 });
  });

  it('is disabled when the bottom strip is locked, regardless of the top', () => {
    expect(alignBottomToTop(slot(1, 0, 0), slot(2, 1000, 0, true))).toBeNull();
    expect(alignBottomToTop(slot(1, 0, 0, true), slot(2, 1000, 0))).not.toBeNull();
  });
});

describe('alignDisabledReason', () => {
  it('explains a missing or undated picture', () => {
    expect(alignDisabledReason(null, slot(2, 0, 0), 'top')).toBe('Both preview panes need a picture with a known time.');
    expect(alignDisabledReason(slot(1, 0, 0), null, 'bottom')).toBe('Both preview panes need a picture with a known time.');
  });

  it('names the locked strip that is being moved', () => {
    expect(alignDisabledReason(slot(1, 0, 0, true), slot(2, 0, 0), 'top')).toBe('The top strip is locked.');
    expect(alignDisabledReason(slot(1, 0, 0), slot(2, 0, 0, true), 'bottom')).toBe('The bottom strip is locked.');
  });

  it('is null once both pictures are present and the moving strip is unlocked', () => {
    expect(alignDisabledReason(slot(1, 0, 0), slot(2, 0, 0, true), 'top')).toBeNull();
  });
});
