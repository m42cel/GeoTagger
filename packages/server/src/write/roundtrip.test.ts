import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { naiveToMs } from '@geotagger/shared';
import { FolderStore, signatureOf } from '../db/store.js';
import { configureExiftool, exiftool, readRawTags, shutdownExiftool } from '../metadata/reader.js';
import { metadataFromTags } from '../metadata/reader.js';
import { StripService } from '../strips/service.js';
import { ensureExiftoolConfig, GEOTAGGER_GROUP } from './exiftool-config.js';
import { planFor, revertTime, runPersist, type PersistContext } from './persist.js';

/**
 * Metadata round-trip (SPEC §13): write, re-read, and revert against a real file
 * through the real ExifTool.
 *
 * Everything else about the writer is tested on synthetic tags; this is the one place
 * that proves the custom namespace config actually loads, that `-P -overwrite_original`
 * behave as assumed, and that a reverted file ends up as it started.
 */

let folder: string;
let store: FolderStore;
let service: StripService;

async function makeJpeg(relPath: string, dateTimeOriginal: string): Promise<void> {
  const abs = path.join(folder, relPath);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: 160 } } })
    .jpeg()
    .toFile(abs);
  // Group-prefixed tag names are not in exiftool-vendored's `WriteTags` union, which
  // covers the bare names; the writer itself passes the same shape through.
  const tags: Record<string, string> = {
    'EXIF:DateTimeOriginal': dateTimeOriginal,
    'EXIF:Make': 'TestCam',
    'EXIF:Model': 'T1',
  };
  await exiftool().write(abs, tags, ['-overwrite_original']);
}

/** Indexes a file the way a scan would, so the store matches what is on disk. */
async function index(relPath: string): Promise<number> {
  const abs = path.join(folder, relPath);
  const { sizeBytes, mtime } = signatureOf(fs.statSync(abs));
  const { id } = store.upsertScanned(
    {
      relPath,
      filename: path.basename(relPath),
      ext: path.extname(relPath).slice(1).toLowerCase(),
      kind: 'image',
      sizeBytes,
      mtime,
    },
    Date.now(),
  );
  const { metadata, device } = metadataFromTags(await readRawTags(abs, 'image'), path.basename(relPath));
  store.applyScanResult(id, metadata, device);
  return id;
}

/** exiftool-vendored parses date-shaped tags; this gets back to what is in the file. */
function rawValueOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const raw = (value as { rawValue?: unknown } | null)?.rawValue;
  return typeof raw === 'string' ? raw : String(value);
}

function context(): PersistContext {
  return {
    store,
    timeline: service.timeline(),
    absPathFor: (relPath) => path.join(folder, relPath),
    appVersion: '0.1.0-test',
  };
}

beforeAll(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-roundtrip-'));
  configureExiftool(ensureExiftoolConfig(path.join(folder, 'state')));
  store = FolderStore.open(folder);
  service = new StripService(store);
});

afterAll(async () => {
  store.close();
  await shutdownExiftool();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('persist and revert against a real JPEG', () => {
  it('writes the corrected time, preserves the original, and reverts to it', async () => {
    await makeJpeg('IMG_0001.JPG', '2024:07:12 14:32:10');
    const id = await index('IMG_0001.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');

    const strip = service.strips().strips[0];
    expect(strip).toBeDefined();
    // The camera was an hour and two minutes fast.
    service.setOffsets((strip as { id: number }).id, -3732);

    const plan = planFor(context());
    expect(plan.correctedTimestamps).toBe(1);
    expect(plan.utcOffsetsAdded).toBe(1);
    expect(plan.staleCount).toBe(0);

    const progress = await runPersist(context(), {}, () => undefined);
    if (progress.failed > 0) throw new Error(JSON.stringify(progress.results));
    expect(progress.failed).toBe(0);
    expect(progress.written).toBe(1);

    const after = await readRawTags(path.join(folder, 'IMG_0001.JPG'), 'image');
    expect(after['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 13:29:58/);
    expect(after['EXIF:OffsetTimeOriginal']).toBe('+02:00');

    const preserved = await exiftool().readRaw(path.join(folder, 'IMG_0001.JPG'), ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    // ExifTool reads a date-shaped string back as a parsed date, so the raw value is
    // what is compared.
    expect(rawValueOf(preserved[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`])).toBe('2024:07:12 14:32:10');
    expect(preserved[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe(-3732);
    // ExifTool reads "True"/"False" back as a boolean, so this is compared loosely.
    expect(String(preserved[`${GEOTAGGER_GROUP}:OriginalGPSPresent`])).toMatch(/^false$/i);

    // Persisting again writes nothing: the file already says what it should.
    expect(planFor(context()).entries).toEqual([]);

    const reverted = await revertTime(context(), store.getFile(id) as never);
    expect(reverted.ok).toBe(true);
    const back = await readRawTags(path.join(folder, 'IMG_0001.JPG'), 'image');
    expect(back['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 14:32:10/);
    expect(back['EXIF:OffsetTimeOriginal']).toBeUndefined();
    const cleared = await exiftool().readRaw(path.join(folder, 'IMG_0001.JPG'), ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    expect(cleared[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();
  }, 60_000);

  it('does not clobber a file that changed on disk since it was scanned (SPEC §8.3)', async () => {
    await makeJpeg('IMG_0002.JPG', '2024:07:12 09:00:00');
    await index('IMG_0002.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');
    const strip = service.strips().strips.find((s) => s.fileCount > 0);
    service.setOffsets((strip as { id: number }).id, 600);

    // Something else rewrites the file after GeoTagger scanned it.
    const foreignEdit: Record<string, string> = { 'EXIF:Artist': 'Someone else' };
    await exiftool().write(path.join(folder, 'IMG_0002.JPG'), foreignEdit, ['-overwrite_original']);

    const entry = planFor(context()).entries.find((e) => e.relPath === 'IMG_0002.JPG');
    expect(entry?.stale).toBe(true);

    const progress = await runPersist(context(), { fileIds: [entry?.fileId as number], stalePolicy: 'skip' }, () => undefined);
    expect(progress.skipped).toBe(1);
    expect(progress.written).toBe(0);
    const untouched = await readRawTags(path.join(folder, 'IMG_0002.JPG'), 'image');
    expect(untouched['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 09:00:00/);
  }, 60_000);
});
