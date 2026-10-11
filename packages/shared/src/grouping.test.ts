import { describe, expect, it } from 'vitest';
import type { DeviceRecord, FileRecord } from './media.js';
import { groupByMode, ROOT_FOLDER_LABEL, UNKNOWN_DEVICE_LABEL } from './grouping.js';

let nextId = 1;
function file(partial: Partial<FileRecord> & { relPath: string }): FileRecord {
  return {
    id: `f${nextId++}`,
    filename: partial.relPath.split('/').pop() as string,
    ext: 'jpg',
    kind: 'image',
    sizeBytes: 1000,
    mtime: 0,
    deviceId: null,
    width: null,
    height: null,
    durationMs: null,
    orientation: null,
    captureTimeRaw: null,
    captureTimeSource: 'none',
    captureUtcOffsetMinutes: null,
    gpsTimeUtc: null,
    origGpsPresent: false,
    origLat: null,
    origLon: null,
    origAlt: null,
    firstSeenAt: 0,
    lastScannedAt: 0,
    missing: false,
    thumbState: 'pending',
    ...partial,
  };
}

const devices: DeviceRecord[] = [
  { id: 'apple|iphone 14|', make: 'Apple', model: 'iPhone 14', serial: null, label: 'Apple iPhone 14' },
  { id: 'sony|a7 iv|123', make: 'Sony', model: 'A7 IV', serial: '123', label: 'Sony A7 IV' },
];

describe('groupByMode by device — SPEC §4.4', () => {
  it('makes one group per device', () => {
    const files = [
      file({ relPath: 'a.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T10:00:00' }),
      file({ relPath: 'b.jpg', deviceId: 'sony|a7 iv|123', captureTimeRaw: '2024-07-12T11:00:00' }),
      file({ relPath: 'c.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T12:00:00' }),
    ];
    const groups = groupByMode('device', files, devices);
    expect(groups).toHaveLength(2);
    expect(groups.map((s) => s.label)).toEqual(['Apple iPhone 14', 'Sony A7 IV']);
    expect(groups[0]?.fileIds).toHaveLength(2);
  });

  it('orders groups by their first capture, not by label', () => {
    const files = [
      file({ relPath: 'z.jpg', deviceId: 'sony|a7 iv|123', captureTimeRaw: '2024-07-12T08:00:00' }),
      file({ relPath: 'a.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T09:00:00' }),
    ];
    expect(groupByMode('device', files, devices).map((s) => s.label)).toEqual([
      'Sony A7 IV',
      'Apple iPhone 14',
    ]);
  });

  it('orders files within a group by capture time', () => {
    const late = file({ relPath: 'late.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T18:00:00' });
    const early = file({ relPath: 'early.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T06:00:00' });
    const groups = groupByMode('device', [late, early], devices);
    expect(groups[0]?.fileIds).toEqual([early.id, late.id]);
  });

  it('collects files with no device identification into one group', () => {
    const files = [
      file({ relPath: 'screenshot.png', captureTimeRaw: '2024-07-12T10:00:00' }),
      file({ relPath: 'download.jpg', captureTimeRaw: '2024-07-12T11:00:00' }),
    ];
    const groups = groupByMode('device', files, devices);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe(UNKNOWN_DEVICE_LABEL);
  });

  it('puts undated files last within a group and undated groups last overall', () => {
    const dated = file({ relPath: 'dated.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T10:00:00' });
    const undated = file({ relPath: 'undated.jpg', deviceId: 'apple|iphone 14|' });
    const orphan = file({ relPath: 'orphan.jpg', deviceId: 'sony|a7 iv|123' });
    const groups = groupByMode('device', [undated, dated, orphan], devices);
    expect(groups[0]?.label).toBe('Apple iPhone 14');
    expect(groups[0]?.fileIds).toEqual([dated.id, undated.id]);
    expect(groups[1]?.label).toBe('Sony A7 IV');
  });

  it('assigns every file to exactly one group', () => {
    const files = [
      file({ relPath: 'a.jpg', deviceId: 'apple|iphone 14|' }),
      file({ relPath: 'b.jpg', deviceId: 'sony|a7 iv|123' }),
      file({ relPath: 'c.jpg' }),
    ];
    const assigned = groupByMode('device', files, devices).flatMap((s) => s.fileIds);
    expect(new Set(assigned).size).toBe(files.length);
  });
});

describe('groupByMode by subfolder — SPEC §4.4', () => {
  it('groups by the immediate parent directory', () => {
    const files = [
      file({ relPath: 'PersonA/a.jpg', captureTimeRaw: '2024-07-12T10:00:00' }),
      file({ relPath: 'PersonB/b.jpg', captureTimeRaw: '2024-07-12T11:00:00' }),
      file({ relPath: 'PersonA/c.jpg', captureTimeRaw: '2024-07-12T12:00:00' }),
    ];
    const groups = groupByMode('subfolder', files, devices);
    expect(groups.map((s) => s.label)).toEqual(['PersonA', 'PersonB']);
  });

  it('labels files sitting directly in the folder root', () => {
    const groups = groupByMode('subfolder', [file({ relPath: 'loose.jpg' })], devices);
    expect(groups[0]?.label).toBe(ROOT_FOLDER_LABEL);
  });

  it('ignores device identity entirely', () => {
    const files = [
      file({ relPath: 'Day1/a.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T10:00:00' }),
      file({ relPath: 'Day1/b.jpg', deviceId: 'sony|a7 iv|123', captureTimeRaw: '2024-07-12T11:00:00' }),
    ];
    expect(groupByMode('subfolder', files, devices)).toHaveLength(1);
  });
});

describe('degenerate input', () => {
  it('returns nothing for an empty folder', () => {
    expect(groupByMode('device', [], devices)).toEqual([]);
  });

  it('handles a single file', () => {
    const groups = groupByMode('device', [file({ relPath: 'only.jpg' })], devices);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.fileIds).toHaveLength(1);
  });

  it('breaks identical capture times by path, so rescans are stable', () => {
    const b = file({ relPath: 'b.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T10:00:00' });
    const a = file({ relPath: 'a.jpg', deviceId: 'apple|iphone 14|', captureTimeRaw: '2024-07-12T10:00:00' });
    expect(groupByMode('device', [b, a], devices)[0]?.fileIds).toEqual([a.id, b.id]);
  });
});
