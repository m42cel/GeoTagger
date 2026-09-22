import { describe, it, expect } from 'vitest';
import { computeSnap, nudgeSeconds, sampleInstants, snapToleranceMs } from './snap.js';
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
