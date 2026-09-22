import { ExifTool } from 'exiftool-vendored';
import type { MediaKind } from '@geotagger/shared';
import type { FileMetadata } from '../db/store.js';
import { resolveCaptureTime } from './capture-time.js';
import {
  collectDateCandidates,
  collectDevice,
  collectDimensions,
  collectGps,
  type RawTags,
} from './exif-parse.js';

/**
 * One long-lived ExifTool process in `-stay_open` mode. Starting Perl per file would
 * dominate the scan time on a low-power NAS, which is the whole reason for
 * `exiftool-vendored` (SPEC §2).
 */
let shared: ExifTool | null = null;
let configPath: string | null = null;

/**
 * Points ExifTool at the config declaring GeoTagger's XMP namespace (SPEC §9.3).
 *
 * `-config` has to be the very first argument ExifTool sees, so it goes in front of
 * the `-stay_open` pair the process is launched with. Must be called before the first
 * read: the process lives for the life of the server and its launch args are fixed.
 */
export function configureExiftool(path: string | null): void {
  if (shared !== null) throw new Error('ExifTool is already running; configure it before the first read');
  configPath = path;
}

export function exiftool(): ExifTool {
  shared ??= new ExifTool({
    taskTimeoutMillis: 20_000,
    maxProcs: 1,
    exiftoolArgs: [...(configPath === null ? [] : ['-config', configPath]), '-stay_open', 'True', '-@', '-'],
  });
  return shared;
}

export async function shutdownExiftool(): Promise<void> {
  if (shared) {
    const et = shared;
    shared = null;
    await et.end();
  }
}

/**
 * The tags GeoTagger cares about, grouped (`-G0`) so `CreateDate` from EXIF and from
 * QuickTime stay distinguishable.
 *
 * `-n` would also strip the date formatting this code relies on, so unformatted
 * output is requested per tag via `Composite:GPSLatitude#` rather than globally.
 */
const TAG_ARGS = [
  '-EXIF:DateTimeOriginal',
  '-EXIF:CreateDate',
  '-EXIF:DateTimeDigitized',
  '-EXIF:OffsetTime',
  '-EXIF:OffsetTimeOriginal',
  '-EXIF:OffsetTimeDigitized',
  '-EXIF:Make',
  '-EXIF:Model',
  '-EXIF:SerialNumber',
  '-EXIF:BodySerialNumber',
  '-EXIF:Orientation#',
  '-EXIF:ExifImageWidth',
  '-EXIF:ExifImageHeight',
  '-QuickTime:CreateDate',
  '-QuickTime:Make',
  '-QuickTime:Model',
  '-QuickTime:ImageWidth',
  '-QuickTime:ImageHeight',
  '-QuickTime:Duration',
  '-XMP:DateCreated',
  '-XMP:CreateDate',
  '-XMP:Make',
  '-XMP:Model',
  '-Composite:SubSecDateTimeOriginal',
  '-Composite:GPSDateTime',
  '-Composite:GPSLatitude#',
  '-Composite:GPSLongitude#',
  '-Composite:Duration',
  '-File:FileModifyDate',
  '-File:ImageWidth',
  '-File:ImageHeight',
  '-MakerNotes:SerialNumber',
];

/**
 * Reads one file's tags.
 *
 * `-fast2` stops ExifTool after the EXIF header, which is a large saving across
 * thousands of JPEGs — but it yields *nothing at all* for QuickTime, whose metadata
 * lives in a `moov` atom that can sit at the end of the file. So it is applied to
 * images only; videos are read in full, and there are far fewer of them.
 */
export async function readRawTags(absPath: string, kind: MediaKind): Promise<RawTags> {
  const args = [
    '-G0',
    '-charset', 'filename=utf8',
    ...(kind === 'image' ? ['-fast2'] : []),
    ...TAG_ARGS,
  ];
  const tags = await exiftool().readRaw(absPath, args);
  return tags as RawTags;
}

/**
 * Turns raw tags into the metadata the index stores, resolving capture time by the
 * precedence of SPEC §4.1. Pure apart from the tag read, so the resolution logic is
 * tested directly against synthetic tags.
 */
export function metadataFromTags(
  tags: RawTags,
  filename: string,
): { metadata: FileMetadata; device: ReturnType<typeof collectDevice> } {
  const candidates = collectDateCandidates(tags);
  const capture = resolveCaptureTime(candidates, filename);
  const gps = collectGps(tags);
  const dims = collectDimensions(tags);
  const device = collectDevice(tags);

  return {
    metadata: {
      deviceId: device?.id ?? null,
      width: dims.width,
      height: dims.height,
      durationMs: dims.durationMs,
      orientation: dims.orientation,
      captureTimeRaw: capture.source === 'none' ? null : capture.localIso,
      captureTimeSource: capture.source,
      captureUtcOffsetMinutes: capture.utcOffsetMinutes,
      // Kept even when another source won the capture time: satellite UTC against the
      // camera's own clock is the exact-offset observation of SPEC §4.5.
      gpsTimeUtc: candidates['exif:GPSDateTime']?.localIso ?? null,
      origGpsPresent: gps !== null,
      origLat: gps?.lat ?? null,
      origLon: gps?.lon ?? null,
    },
    device,
  };
}
