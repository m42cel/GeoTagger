import { describe, expect, it } from 'vitest';
import type { ComputedPosition, FileId, FileRecord, PositionSource, TimelineFile } from '@geotagger/shared';
import { resetTarget } from './reset-target.js';

function file(id: string, gps = false): FileRecord {
  return { id: id as FileId, origGpsPresent: gps, origLat: gps ? 1 : null, origLon: gps ? 1 : null } as FileRecord;
}

function item(id: string, source: PositionSource, effectiveMs: number | null = 1000) {
  const position: ComputedPosition = {
    fileId: id as FileId,
    base: { lat: 1, lon: 1, uncertaintyM: null, source },
    pending: null,
  };
  return { file: { id: id as FileId }, position, timelineFile: { effectiveMs } as TimelineFile };
}

const timed = { effectiveMs: 1000 } as TimelineFile;

describe('resetTarget', () => {
  it('falls back to camera GPS whenever the file has it', () => {
    expect(resetTarget(file('a', true), timed, [item('a', 'confirmed')])).toBe('camera-gps');
  });

  it('falls back to an estimate with two other dated anchors', () => {
    const items = [item('a', 'confirmed'), item('b', 'camera-gps'), item('c', 'confirmed'), item('d', 'estimate')];
    expect(resetTarget(file('a'), timed, items)).toBe('estimate');
  });

  it('falls back to nothing when the file itself is one of only two anchors', () => {
    expect(resetTarget(file('a'), timed, [item('a', 'confirmed'), item('b', 'camera-gps')])).toBe('none');
  });

  it('does not count undated anchors, and gives an undated file nothing', () => {
    const items = [item('a', 'confirmed'), item('b', 'camera-gps'), item('c', 'camera-gps', null)];
    expect(resetTarget(file('a'), timed, items)).toBe('none');
    expect(resetTarget(file('a'), { effectiveMs: null } as TimelineFile, [...items, item('d', 'camera-gps')])).toBe('none');
  });
});
