import { describe, it, expect } from 'vitest';
import { computeSnap, computeStretchSnap, nudgeSeconds, sampleInstants, snapToleranceMs } from './snap.js';
import { naiveToMs } from './time.js';

const at = (iso: string) => naiveToMs(iso) as number;

describe('computeSnap', () => {
  const targets = [at('2024-07-12T12:00:00'), at('2024-07-12T12:05:00'), at('2024-07-12T13:00:00')];

  it('pulls a strip onto a neighbouring lane’s photo', () => {
    // The dragged strip's files are passed already shifted by the candidate offset,
    // so this one sits five seconds past a photo in the lane above.
    const snap = computeSnap({
      candidateOffsetSeconds: 325,
      movingMs: [at('2024-07-12T12:00:05')],
      targetMs: targets,
      toleranceMs: 30_000,
      enabled: true,
    });
    expect(snap.kind).toBe('photo');
    expect(snap.offsetSeconds).toBe(320);
  });

  it('snaps to a whole hour, which is what a timezone error looks like', () => {
    const snap = computeSnap({
      candidateOffsetSeconds: 3598,
      movingMs: [],
      targetMs: [],
      toleranceMs: 60_000,
      enabled: true,
    });
    expect(snap.kind).toBe('hour');
    expect(snap.offsetSeconds).toBe(3600);
  });

  it('snaps to a whole minute', () => {
    const snap = computeSnap({
      candidateOffsetSeconds: 1803,
      movingMs: [],
      targetMs: [],
      toleranceMs: 10_000,
      enabled: true,
    });
    expect(snap.kind).toBe('minute');
    expect(snap.offsetSeconds).toBe(1800);
  });

  it('does nothing at all when the modifier disables it', () => {
    const snap = computeSnap({
      candidateOffsetSeconds: 3598,
      movingMs: [at('2024-07-12T12:00:07')],
      targetMs: targets,
      toleranceMs: 60_000,
      enabled: false,
    });
    expect(snap).toEqual({ offsetSeconds: 3598, kind: 'none', adjustmentSeconds: 0 });
  });

  it('leaves an offset alone when nothing is within tolerance', () => {
    const snap = computeSnap({
      candidateOffsetSeconds: 1830,
      movingMs: [at('2024-07-12T12:30:00')],
      targetMs: targets,
      toleranceMs: 5_000,
      enabled: true,
    });
    expect(snap.kind).toBe('none');
    expect(snap.offsetSeconds).toBe(1830);
  });

  it('does not let the hour snap run away with a coarse zoom', () => {
    // One pixel covers ten minutes at trip zoom; an unclamped hour snap would make
    // every drag jump to the hour and the strip would be unplaceable.
    const snap = computeSnap({
      candidateOffsetSeconds: 2430,
      movingMs: [],
      targetMs: [],
      toleranceMs: 30 * 60_000,
      enabled: true,
    });
    expect(snap.kind).toBe('none');
  });

  it('prefers the smaller correction when both a photo and an hour are close', () => {
    const moving = [at('2024-07-12T12:00:20')];
    const snap = computeSnap({
      candidateOffsetSeconds: 3610,
      movingMs: moving,
      targetMs: [at('2024-07-12T12:00:15')],
      toleranceMs: 30_000,
      enabled: true,
    });
    expect(snap.kind).toBe('photo');
    expect(snap.offsetSeconds).toBe(3605);
  });
});

describe('nudgeSeconds', () => {
  it('matches the keyboard steps of SPEC §4.3', () => {
    expect(nudgeSeconds({})).toBe(1);
    expect(nudgeSeconds({ shift: true })).toBe(60);
    expect(nudgeSeconds({ ctrlOrMeta: true })).toBe(3600);
    expect(nudgeSeconds({ shift: true, ctrlOrMeta: true })).toBe(3600);
  });
});

describe('sampleInstants', () => {
  it('keeps a short list whole', () => {
    expect(sampleInstants([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('thins a long one evenly and keeps it sorted', () => {
    const input = Array.from({ length: 1000 }, (_, i) => i);
    const out = sampleInstants(input, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(0);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });
});

describe('snapToleranceMs', () => {
  it('scales with the zoom but never reaches zero', () => {
    expect(snapToleranceMs(1000, 6)).toBe(6000);
    expect(snapToleranceMs(0)).toBeGreaterThan(0);
  });
});

describe('computeStretchSnap', () => {
  // Pinned at 10:00, the handle at 16:00; a photo in another lane sits at 14:00:20.
  const pivot = at('2024-07-12T10:00:00');
  const handle = at('2024-07-12T16:00:00');
  const target = at('2024-07-12T14:00:20');
  const input = {
    candidateDrift: 0,
    pivotRawMs: pivot,
    handleRawMs: handle,
    targetMs: [target],
    toleranceMs: 60_000,
    enabled: true,
  };

  it('lands a stretched file exactly on a photo of another lane', () => {
    const raw = at('2024-07-12T14:00:00');
    const snap = computeStretchSnap({ ...input, moving: [{ rawMs: raw, ms: raw }] });
    expect(snap.snapped).toBe(true);
    // 20 s over the 4 h from the pin.
    expect(snap.drift * (raw - pivot)).toBeCloseTo(20_000, 6);
  });

  it('judges the pull at the handle, so a file beside the pin cannot yank the far end', () => {
    // Twenty seconds off, but only a minute from the pin: landing it would move the
    // handle by two hours.
    const raw = at('2024-07-12T10:01:00');
    const snap = computeStretchSnap({ ...input, targetMs: [at('2024-07-12T10:01:20')], moving: [{ rawMs: raw, ms: raw }] });
    expect(snap.snapped).toBe(false);
  });

  it('does nothing when disabled', () => {
    const raw = at('2024-07-12T14:00:00');
    expect(computeStretchSnap({ ...input, enabled: false, moving: [{ rawMs: raw, ms: raw }] }).snapped).toBe(false);
  });
});
