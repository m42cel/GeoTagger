import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { FileId } from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import { FolderStore, signatureOf } from '../db/store.js';
import { configureExiftool, exiftool, readRawTags, shutdownExiftool } from '../metadata/reader.js';
import { metadataFromTags } from '../metadata/reader.js';
import { StripService } from '../strips/service.js';
import { ensureExiftoolConfig, GEOTAGGER_GROUP } from './exiftool-config.js';
import { planFor, runPersist, type PersistContext } from './persist.js';

/**
 * Metadata round-trip (SPEC §13): write and re-read a real file through the real
 * ExifTool.
 *
 * Everything else about the writer is tested on synthetic tags; this is the one place
 * that proves the custom namespace config actually loads, that `-P -overwrite_original`
 * behave as assumed, and that the preserved originals land in the file as written.
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
async function index(relPath: string): Promise<FileId> {
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

describe('persist against a real JPEG', () => {
  it('writes the corrected time and preserves the original', async () => {
    await makeJpeg('IMG_0001.JPG', '2024:07:12 14:32:10');
    const id = await index('IMG_0001.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');

    const strip = service.strips().strips[0];
    expect(strip).toBeDefined();
    // The camera was an hour and two minutes fast.
    service.setOffset((strip as { id: number }).id, -3732);

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
    // One original per tag written, and `n/a` for the offset tags this file never had —
    // absent and empty have to stay distinguishable (SPEC §9.3).
    expect(rawValueOf(preserved[`${GEOTAGGER_GROUP}:OriginalCreateDate`])).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalOffsetTimeDigitized`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe(-3732);
    // Nothing GPS was ever touched, so the position half of the block was never
    // written at all — not even to say GPS is absent (SPEC §9.3's two halves).
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBeUndefined();
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalXMPGPSLatitude`]).toBeUndefined();

    // Persisting again writes nothing: the file already says what it should.
    expect(planFor(context()).entries).toEqual([]);

  }, 60_000);

  it('writes a confirmed position alongside a time correction in one write', async () => {
    await makeJpeg('IMG_0003.JPG', '2024:07:12 09:00:00');
    const id = await index('IMG_0003.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');
    const strip = service.strips().strips.find((s) => s.fileCount > 0);
    service.setOffset((strip as { id: number }).id, 300);
    store.confirmPosition(id, 47.1234, 11.3456, null, true);

    const plan = planFor(context());
    const entry = plan.entries.find((e) => e.fileId === id);
    expect(entry?.fields.map((f) => f.field)).toEqual(['timestamp', 'utcOffset', 'position']);

    const progress = await runPersist(context(), { fileIds: [id] }, () => undefined);
    expect(progress.failed).toBe(0);
    expect(progress.written).toBe(1);

    const after = await readRawTags(path.join(folder, 'IMG_0003.JPG'), 'image');
    expect(after['Composite:GPSLatitude']).toBeCloseTo(47.1234, 3);
    expect(after['Composite:GPSLongitude']).toBeCloseTo(11.3456, 3);

    const preserved = await exiftool().readRaw(path.join(folder, 'IMG_0003.JPG'), ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    // The camera recorded no position, so every position tag's original is `n/a` —
    // including the XMP pair, which is why a restore knows to remove it again.
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalGPSLatitudeRef`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalXMPGPSLatitude`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalXMPGPSLongitude`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:PositionSource`]).toBe('manual');

  }, 60_000);

  it('preserves only the tags it writes, and preserves the rest when they are written later', async () => {
    // The file's wall clock is already right, so §4.2's offset is the whole write — and
    // the whole of what gets preserved. The date tags are untouched, so claiming an
    // original for them would be claiming to have overwritten something.
    await makeJpeg('IMG_0004.JPG', '2024:07:12 14:32:10');
    const id = await index('IMG_0004.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');

    const entry = planFor(context()).entries.find((e) => e.fileId === id);
    // Only the offset moves, and both its tags are being written for the first time.
    expect(entry?.fields).toEqual([{ field: 'utcOffset', oldMinutes: null, newMinutes: 120 }]);
    expect(entry?.changes.every((c) => c.stampsOriginal)).toBe(true);

    const progress = await runPersist(context(), { fileIds: [id] }, () => undefined);
    expect(progress.failed).toBe(0);

    const abs = path.join(folder, 'IMG_0004.JPG');
    expect((await readRawTags(abs, 'image'))['EXIF:OffsetTimeOriginal']).toBe('+02:00');
    const preserved = await exiftool().readRaw(abs, ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalOffsetTimeDigitized`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`]).toBeUndefined();

    // Persisting again writes nothing: every tag already says what it should.
    expect(planFor(context()).entries.filter((e) => e.fileId === id)).toEqual([]);

    // Correcting the clock later is the date tags' first write, so *their* originals are
    // preserved now — still the pre-GeoTagger values, since nothing has touched them.
    const stripId = (service.strips().strips.find((s) => s.fileCount > 0) as { id: number }).id;
    service.setOffset(stripId, 3600);
    expect((await runPersist(context(), { fileIds: [id] }, () => undefined)).failed).toBe(0);

    const later = await exiftool().readRaw(abs, ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    expect(rawValueOf(later[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`])).toBe('2024:07:12 14:32:10');
    expect(rawValueOf(later[`${GEOTAGGER_GROUP}:OriginalCreateDate`])).toBe('n/a');
    // And the offset's original is untouched by that second write.
    expect(later[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBe('n/a');
    expect((await readRawTags(abs, 'image'))['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 15:32:10/);
  }, 60_000);

  it('corrects the time of a folder with no known offset without inventing one (SPEC §4.2)', async () => {
    // Nothing here knows the offset — no GPS-bearing file, no override, no answer from
    // the user — so the timeline assumes UTC only to place the files on it. That
    // assumption must not reach the file: written as `+00:00` it would read back as
    // fact on the next scan, silently answering the question the app still needs to ask.
    await makeJpeg('IMG_0006.JPG', '2024:07:12 14:00:00');
    const id = await index('IMG_0006.JPG');
    store.folderUtcOffsetMinutes = null;
    service.regroup('device');
    const stripId = (service.strips().strips.find((s) => s.fileCount > 0) as { id: number }).id;
    service.setOffset(stripId, 3600);

    const entry = planFor(context()).entries.find((e) => e.fileId === id);
    expect(entry?.fields.map((f) => f.field)).toEqual(['timestamp']);
    expect(entry?.changes.map((c) => c.tag)).toEqual(['EXIF:DateTimeOriginal', 'EXIF:CreateDate']);

    const progress = await runPersist(context(), { fileIds: [id] }, () => undefined);
    expect(progress.failed).toBe(0);

    const after = await readRawTags(path.join(folder, 'IMG_0006.JPG'), 'image');
    expect(after['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 15:00:00/);
    expect(after['EXIF:OffsetTimeOriginal']).toBeUndefined();
    expect(after['EXIF:OffsetTimeDigitized']).toBeUndefined();
    // The date tags are the write, so they are what gets preserved — no offset original,
    // because no offset tag was touched.
    const preserved = await exiftool().readRaw(path.join(folder, 'IMG_0006.JPG'), ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    expect(rawValueOf(preserved[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`])).toBe('2024:07:12 14:00:00');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalOffsetTimeOriginal`]).toBeUndefined();
  }, 60_000);

  it('goes quiet after writing one field of a file that had both written (SPEC §9.1)', async () => {
    // The bug this replaces: the record of a write covered the whole file, so writing the
    // timestamp forgot the position that was already on disk, the next plan proposed it
    // again, that write forgot the timestamp, and Persist never went quiet — it alternated
    // between two phantom changes for ever, rewriting the file each time.
    await makeJpeg('IMG_0007.JPG', '2024:07:12 14:00:00');
    const id = await index('IMG_0007.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');
    const stripId = (service.strips().strips.find((s) => s.fileCount > 0) as { id: number }).id;
    service.setOffset(stripId, 3600);
    store.confirmPosition(id, 47.5, 11.5, null, true);
    expect((await runPersist(context(), { fileIds: [id] }, () => undefined)).failed).toBe(0);

    // One further edit, to the clock alone.
    service.setOffset(stripId, 7200);
    const entry = planFor(context()).entries.find((e) => e.fileId === id);
    expect(entry?.fields.map((f) => f.field)).toEqual(['timestamp']);
    expect((await runPersist(context(), { fileIds: [id] }, () => undefined)).failed).toBe(0);

    // Nothing left to do, however many times it is asked.
    expect(planFor(context()).entries.filter((e) => e.fileId === id)).toEqual([]);
    expect(planFor(context()).entries.filter((e) => e.fileId === id)).toEqual([]);

    const abs = path.join(folder, 'IMG_0007.JPG');
    const f = await readRawTags(abs, 'image');
    expect(f['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 16:00:00/);
    expect(f['Composite:GPSLatitude']).toBeCloseTo(47.5, 4);
    // Each field's original is still the pre-GeoTagger one, stamped by its own first write.
    const preserved = await exiftool().readRaw(abs, ['-G1', `-${GEOTAGGER_GROUP}:all`]);
    expect(rawValueOf(preserved[`${GEOTAGGER_GROUP}:OriginalDateTimeOriginal`])).toBe('2024:07:12 14:00:00');
    expect(preserved[`${GEOTAGGER_GROUP}:OriginalGPSLatitude`]).toBe('n/a');
    expect(preserved[`${GEOTAGGER_GROUP}:TimeShiftSeconds`]).toBe(7200);
  }, 60_000);

  it('verifies a western-hemisphere position written over the camera’s own (SPEC §9.1)', async () => {
    // The camera already recorded a position west of Greenwich, so `GPSLongitudeRef` is
    // already `W` and the confirmed position does not change it — only the coordinates
    // themselves move. Nothing about the write may depend on that ref being part of it.
    await makeJpeg('IMG_0008.JPG', '2024:07:12 14:00:00');
    const abs = path.join(folder, 'IMG_0008.JPG');
    await exiftool().write(
      abs,
      { 'EXIF:GPSLatitude': 52.2, 'EXIF:GPSLatitudeRef': 'N', 'EXIF:GPSLongitude': 117.0, 'EXIF:GPSLongitudeRef': 'W' } as Record<string, string | number>,
      ['-overwrite_original'],
    );
    const id = await index('IMG_0008.JPG');
    store.folderUtcOffsetMinutes = -420;
    service.regroup('device');
    store.confirmPosition(id, 52.2816036, -117.0703125, null, true);

    const progress = await runPersist(context(), { fileIds: [id] }, () => undefined);
    if (progress.failed > 0) throw new Error(JSON.stringify(progress.results));
    expect(progress.written).toBe(1);

    const after = await readRawTags(abs, 'image');
    expect(after['Composite:GPSLatitude']).toBeCloseTo(52.2816036, 5);
    expect(after['Composite:GPSLongitude']).toBeCloseTo(-117.0703125, 5);
  }, 60_000);

  it('does not clobber a file that changed on disk since it was scanned (SPEC §8.3)', async () => {
    await makeJpeg('IMG_0002.JPG', '2024:07:12 09:00:00');
    await index('IMG_0002.JPG');
    store.folderUtcOffsetMinutes = 120;
    service.regroup('device');
    const strip = service.strips().strips.find((s) => s.fileCount > 0);
    service.setOffset((strip as { id: number }).id, 600);

    // Something else rewrites the file after GeoTagger scanned it.
    const foreignEdit: Record<string, string> = { 'EXIF:Artist': 'Someone else' };
    await exiftool().write(path.join(folder, 'IMG_0002.JPG'), foreignEdit, ['-overwrite_original']);

    const entry = planFor(context()).entries.find((e) => e.relPath === 'IMG_0002.JPG');
    expect(entry?.stale).toBe(true);

    const progress = await runPersist(context(), { fileIds: [entry?.fileId as FileId], stalePolicy: 'skip' }, () => undefined);
    expect(progress.skipped).toBe(1);
    expect(progress.written).toBe(0);
    const untouched = await readRawTags(path.join(folder, 'IMG_0002.JPG'), 'image');
    expect(untouched['EXIF:DateTimeOriginal']).toMatch(/^2024:07:12 09:00:00/);
  }, 60_000);
});
