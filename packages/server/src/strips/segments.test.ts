import { describe, it, expect } from 'vitest';
import { naiveToMs, shiftSecondsAt, type ClockCorrection } from '@geotagger/shared';
import { planCut, planMerge, planTrueTime, type SegmentMember } from './segments.js';

const at = (iso: string) => naiveToMs(iso) as number;

/** Five files an hour apart, under a strip carrying one constant correction. */
function members(offsetSeconds: number): { strip: ClockCorrection; list: SegmentMember[] } {
  const raws = [
    at('2024-07-12T10:00:00'),
    at('2024-07-12T11:00:00'),
    at('2024-07-12T12:00:00'),
    at('2024-07-12T13:00:00'),
    at('2024-07-12T14:00:00'),
  ];
  return {
    strip: { offsetSeconds, drift: 0, driftOriginMs: null },
    list: raws.map((raw, i) => ({ fileId: `f${i + 1}`, effectiveMs: raw + offsetSeconds * 1000 })),
  };
}

describe('planCut', () => {
  it('splits membership by effective time', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T13:30:00'));
    expect(cut).not.toBeNull();
    // The strip is an hour fast, so its files sit at 11:00 through 15:00 on the axis.
    expect(cut?.left.fileIds).toEqual(['f1', 'f2', 'f3']);
    expect(cut?.right.fileIds).toEqual(['f4', 'f5']);
  });

  it('gives both halves the offset unchanged, so nothing jumps', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T13:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    expect(cut.left.correction.offsetSeconds).toBe(3600);
    expect(cut.right.correction.offsetSeconds).toBe(3600);
  });

  it('gives both halves the drift and its origin too, so a stretched strip does not jump either', () => {
    const stretched: ClockCorrection = { offsetSeconds: 30, drift: 1e-4, driftOriginMs: at('2024-07-12T12:00:00') };
    const { list } = members(0);
    const cut = planCut(stretched, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    const late = at('2024-07-12T14:00:00');
    expect(shiftSecondsAt(cut.right.correction, late)).toBe(shiftSecondsAt(stretched, late));
    expect(cut.left.correction).toEqual(stretched);
  });

  it('refuses a cut that would leave one side empty', () => {
    const { strip, list } = members(0);
    expect(planCut(strip, list, at('2024-07-12T09:00:00'))).toBeNull();
    expect(planCut(strip, list, at('2024-07-12T20:00:00'))).toBeNull();
  });

  it('keeps an undated file with the earlier segment rather than dropping it', () => {
    const { strip, list } = members(0);
    const withUndated = [...list, { fileId: 'f99', effectiveMs: null }];
    const cut = planCut(strip, withUndated, at('2024-07-12T12:30:00'));
    expect(cut?.left.fileIds).toContain('f99');
  });
});

describe('planMerge', () => {
  it('takes the left segment’s offset for the whole result', () => {
    const merged = planMerge(
      { fileIds: ['f1', 'f2', 'f3'], correction: { offsetSeconds: 100, drift: 0, driftOriginMs: null } },
      { fileIds: ['f4', 'f5'] },
    );
    expect(merged.fileIds).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(merged.correction.offsetSeconds).toBe(100);
  });

  it('round-trips a cut back to where it started', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    const merged = planMerge(cut.left, cut.right);
    expect(merged.fileIds).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(merged.correction.offsetSeconds).toBe(3600);
  });
});

describe('planTrueTime', () => {
  it('shifts the whole strip so the file lands on its true time', () => {
    expect(planTrueTime({ offsetSeconds: 0 }, at('2024-07-12T12:00:00'), at('2024-07-12T14:32:10'))).toBe(9130);
  });

  it('corrects the files before that one as well as after it', () => {
    const { strip, list } = members(0);
    const middle = list[2] as SegmentMember;
    const offset = planTrueTime(strip, middle.effectiveMs as number, at('2024-07-12T13:00:00'));
    const first = list[0] as SegmentMember;
    expect((first.effectiveMs as number) + offset * 1000).toBe(at('2024-07-12T11:00:00'));
  });
});
