import { describe, it, expect } from 'vitest';
import { naiveToMs, offsetSecondsAt } from '@geotagger/shared';
import { planCut, planMerge, planPin, type SegmentMember } from './segments.js';

const at = (iso: string) => naiveToMs(iso) as number;

/** Five files an hour apart, under a strip that is two hours behind and drifting. */
function members(offsetStart: number, offsetEnd: number): { ramp: ReturnType<typeof ramps>; list: SegmentMember[] } {
  const raws = [
    at('2024-07-12T10:00:00'),
    at('2024-07-12T11:00:00'),
    at('2024-07-12T12:00:00'),
    at('2024-07-12T13:00:00'),
    at('2024-07-12T14:00:00'),
  ];
  const ramp = ramps(offsetStart, offsetEnd, raws[0] as number, raws[4] as number);
  return {
    ramp,
    list: raws.map((raw, i) => ({
      fileId: i + 1,
      rawCaptureMs: raw,
      effectiveMs: raw + offsetSecondsAt(ramp, raw) * 1000,
    })),
  };
}

function ramps(offsetStartSeconds: number, offsetEndSeconds: number, firstCaptureMs: number, lastCaptureMs: number) {
  return { offsetStartSeconds, offsetEndSeconds, firstCaptureMs, lastCaptureMs };
}

describe('planCut', () => {
  it('splits membership by effective time', () => {
    const { ramp, list } = members(3600, 3600);
    const cut = planCut(ramp, list, at('2024-07-12T13:30:00'));
    expect(cut).not.toBeNull();
    // The strip is an hour fast, so its files sit at 11:00 through 15:00 on the axis.
    expect(cut?.left.fileIds).toEqual([1, 2, 3]);
    expect(cut?.right.fileIds).toEqual([4, 5]);
  });

  it('gives both halves the constant offset unchanged, so nothing jumps', () => {
    const { ramp, list } = members(3600, 3600);
    const cut = planCut(ramp, list, at('2024-07-12T13:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    for (const segment of [cut.left, cut.right]) {
      expect(segment.offsetStartSeconds).toBe(3600);
      expect(segment.offsetEndSeconds).toBe(3600);
    }
  });

  it('divides a stretched strip’s ramp between the segments without moving a file', () => {
    const { ramp, list } = members(0, 4000);
    const cut = planCut(ramp, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    for (const member of list) {
      const segment = cut.left.fileIds.includes(member.fileId) ? cut.left : cut.right;
      const after = (member.rawCaptureMs as number) + offsetSecondsAt(segment, member.rawCaptureMs) * 1000;
      expect(after).toBe(member.effectiveMs);
    }
  });

  it('refuses a cut that would leave one side empty', () => {
    const { ramp, list } = members(0, 0);
    expect(planCut(ramp, list, at('2024-07-12T09:00:00'))).toBeNull();
    expect(planCut(ramp, list, at('2024-07-12T20:00:00'))).toBeNull();
  });

  it('keeps an undated file with the earlier segment rather than dropping it', () => {
    const { ramp, list } = members(0, 0);
    const withUndated = [...list, { fileId: 99, rawCaptureMs: null, effectiveMs: null }];
    const cut = planCut(ramp, withUndated, at('2024-07-12T12:30:00'));
    expect(cut?.left.fileIds).toContain(99);
  });
});

describe('planMerge', () => {
  it('ramps from the left segment’s start to the right segment’s end', () => {
    const { ramp, list } = members(0, 4000);
    const cut = planCut(ramp, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    const merged = planMerge(cut.left, cut.right);
    expect(merged.fileIds).toEqual([1, 2, 3, 4, 5]);
    expect(merged.offsetStartSeconds).toBe(0);
    expect(merged.offsetEndSeconds).toBe(4000);
    expect(merged.firstCaptureMs).toBe(at('2024-07-12T10:00:00'));
    expect(merged.lastCaptureMs).toBe(at('2024-07-12T14:00:00'));
  });

  it('round-trips a cut of a constant-offset strip back to where it started', () => {
    const { ramp, list } = members(3600, 3600);
    const cut = planCut(ramp, list, at('2024-07-12T12:30:00')) as NonNullable<ReturnType<typeof planCut>>;
    const merged = planMerge(cut.left, cut.right);
    expect(merged.offsetStartSeconds).toBe(3600);
    expect(merged.offsetEndSeconds).toBe(3600);
  });
});

describe('planPin', () => {
  it('shifts the whole strip so the pinned file lands on its true time', () => {
    const pinned = planPin({ offsetStartSeconds: 0, offsetEndSeconds: 0 }, at('2024-07-12T12:00:00'), at('2024-07-12T14:32:10'));
    expect(pinned.offsetStartSeconds).toBe(9130);
    expect(pinned.offsetEndSeconds).toBe(9130);
  });

  it('corrects the files before the pinned one as well as after it', () => {
    const { ramp, list } = members(0, 0);
    const middle = list[2] as SegmentMember;
    const pinned = planPin(ramp, middle.effectiveMs as number, at('2024-07-12T13:00:00'));
    const first = list[0] as SegmentMember;
    const shiftedFirst = (first.effectiveMs as number) + pinned.offsetStartSeconds * 1000;
    expect(shiftedFirst).toBe(at('2024-07-12T11:00:00'));
  });

  it('preserves a stretch', () => {
    const pinned = planPin({ offsetStartSeconds: 100, offsetEndSeconds: 400 }, 0, 60_000);
    expect(pinned.offsetEndSeconds - pinned.offsetStartSeconds).toBe(300);
  });
});
