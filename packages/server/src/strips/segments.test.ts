import { describe, it, expect } from 'vitest';
import { naiveToMs } from '@geotagger/shared';
import { planCut, planMerge, planPin, type SegmentMember } from './segments.js';

const at = (iso: string) => naiveToMs(iso) as number;

/** Five files an hour apart, under a strip carrying one constant correction. */
function members(offsetSeconds: number): { strip: { offsetSeconds: number }; list: SegmentMember[] } {
  const raws = [
    at('2024-07-12T10:00:00'),
    at('2024-07-12T11:00:00'),
    at('2024-07-12T12:00:00'),
    at('2024-07-12T13:00:00'),
    at('2024-07-12T14:00:00'),
  ];
  return {
    strip: { offsetSeconds },
    list: raws.map((raw, i) => ({ fileId: i + 1, effectiveMs: raw + offsetSeconds * 1000 })),
  };
}

describe('planCut', () => {
  it('splits membership by effective time', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T13:30:00'));
    expect(cut).not.toBeNull();
    // The strip is an hour fast, so its files sit at 11:00 through 15:00 on the axis.
    expect(cut?.left.fileIds).toEqual([1, 2, 3]);
    expect(cut?.right.fileIds).toEqual([4, 5]);
  });

  it('gives both halves the offset unchanged, so nothing jumps', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T13:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    expect(cut.left.offsetSeconds).toBe(3600);
    expect(cut.right.offsetSeconds).toBe(3600);
  });

  it('refuses a cut that would leave one side empty', () => {
    const { strip, list } = members(0);
    expect(planCut(strip, list, at('2024-07-12T09:00:00'))).toBeNull();
    expect(planCut(strip, list, at('2024-07-12T20:00:00'))).toBeNull();
  });

  it('keeps an undated file with the earlier segment rather than dropping it', () => {
    const { strip, list } = members(0);
    const withUndated = [...list, { fileId: 99, effectiveMs: null }];
    const cut = planCut(strip, withUndated, at('2024-07-12T12:30:00'));
    expect(cut?.left.fileIds).toContain(99);
  });
});

describe('planMerge', () => {
  it('takes the left segment’s offset for the whole result', () => {
    const merged = planMerge({ fileIds: [1, 2, 3], offsetSeconds: 100 }, { fileIds: [4, 5] });
    expect(merged.fileIds).toEqual([1, 2, 3, 4, 5]);
    expect(merged.offsetSeconds).toBe(100);
  });

  it('round-trips a cut back to where it started', () => {
    const { strip, list } = members(3600);
    const cut = planCut(strip, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    const merged = planMerge(cut.left, cut.right);
    expect(merged.fileIds).toEqual([1, 2, 3, 4, 5]);
    expect(merged.offsetSeconds).toBe(3600);
  });
});

describe('planPin', () => {
  it('shifts the whole strip so the pinned file lands on its true time', () => {
    expect(planPin({ offsetSeconds: 0 }, at('2024-07-12T12:00:00'), at('2024-07-12T14:32:10'))).toBe(9130);
  });

  it('corrects the files before the pinned one as well as after it', () => {
    const { strip, list } = members(0);
    const middle = list[2] as SegmentMember;
    const pinned = planPin(strip, middle.effectiveMs as number, at('2024-07-12T13:00:00'));
    const first = list[0] as SegmentMember;
    expect((first.effectiveMs as number) + pinned * 1000).toBe(at('2024-07-12T11:00:00'));
  });
});
