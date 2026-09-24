import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FileRecord } from '@geotagger/shared';
import { exiftool } from '../metadata/reader.js';

/** Two cached tiers (SPEC §10.1 step 6): eager grid thumbnails, on-demand previews. */
export type ThumbTier = 'thumb' | 'preview';

/**
 * The grid tier is sized for the alignment view's film-strip frames. Those frames are
 * square and crop to fill, so what has to cover them is the image's *short* edge:
 * 256 on the long edge leaves roughly 170 across a 3:2 frame, a little under twice
 * the density a retina display would ask of a 102 px frame. Raising it is a cache
 * rebuild, so it stays here until the softness is worth one.
 */
export const TIER_SIZE: Record<ThumbTier, number> = { thumb: 256, preview: 1280 };

/**
 * The pixel size is part of the cache path, so changing a tier invalidates it.
 * Without that, raising a tier would leave every folder scanned before the change
 * serving yesterday's smaller image for good — the cache is on disk and keyed only
 * by file id.
 */
function tierDir(tier: ThumbTier): string {
  return `${tier}-${TIER_SIZE[tier]}`;
}

/**
 * Matches any tier directory, this build's or an older build's — including the
 * unsuffixed names used before the size was part of the path, which are stale by
 * definition now that every current name carries one.
 */
const TIER_DIR_RE = /^(thumb|preview)(-\d+)?$/;

export function thumbPath(thumbsDir: string, fileId: number, tier: ThumbTier): string {
  // Two hex levels of fan-out, so a 5,000-file folder never puts 5,000 entries in
  // one directory — which some NAS filesystems handle poorly.
  const bucket = (fileId % 256).toString(16).padStart(2, '0');
  return path.join(thumbsDir, tierDir(tier), bucket, `${fileId}.jpg`);
}

/**
 * Deletes cache directories left by an older tier size, which nothing will read
 * again. Only directories named like a tier are touched: this runs over a directory
 * inside the user's photo folder, and nothing else in there is GeoTagger's to remove.
 */
export function pruneStaleThumbTiers(thumbsDir: string): void {
  const current = new Set((Object.keys(TIER_SIZE) as ThumbTier[]).map(tierDir));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(thumbsDir, { withFileTypes: true });
  } catch {
    return; // nothing cached yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || current.has(entry.name) || !TIER_DIR_RE.test(entry.name)) continue;
    fs.rmSync(path.join(thumbsDir, entry.name), { recursive: true, force: true });
  }
}

export function thumbExists(thumbsDir: string, fileId: number, tier: ThumbTier): boolean {
  return fs.existsSync(thumbPath(thumbsDir, fileId, tier));
}

/**
 * Renders one thumbnail, taking the lowest-cost path that works (SPEC §10.1 step 5).
 *
 * The order matters on a weak ARM CPU: an embedded preview is a JPEG already in the
 * file and costs a read plus a downscale, while decoding a 48-megapixel HEIC costs
 * seconds. ffmpeg is the last resort for images because the bundled libvips may lack
 * HEVC-based HEIC support (SPEC §14 risk 1).
 */
export async function generateThumb(
  absPath: string,
  file: FileRecord,
  thumbsDir: string,
  tier: ThumbTier,
): Promise<string> {
  const target = thumbPath(thumbsDir, file.id, tier);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const size = TIER_SIZE[tier];

  const embedded = file.kind === 'video' ? null : await extractEmbeddedPreview(absPath, size);
  const source =
    file.kind === 'video'
      ? await grabVideoFrame(absPath, file.durationMs)
      : (embedded ?? (await readWhole(absPath)));

  // An embedded preview is a bare JPEG with no EXIF of its own, so nothing in it says
  // which way up it goes — the orientation lives on the parent file. ffmpeg already
  // applies a video's display matrix, and a whole image carries its own tag, so the
  // parent's orientation is needed for exactly the embedded-preview case.
  const fallbackOrientation = embedded ? file.orientation : null;

  try {
    await downscale(source, target, size, fallbackOrientation);
    return target;
  } catch (err) {
    if (file.kind === 'video') throw err;
    // libvips could not decode it — most likely HEIC without HEVC support, which the
    // bundled libvips may lack for licensing reasons (SPEC §14 risk 1). ffmpeg can
    // usually still decode it.
    try {
      // ffmpeg does not apply EXIF orientation to a still, so pass the parent's.
      const decoded = await decodeStill(absPath);
      await downscale(decoded, target, size, file.orientation);
      return target;
    } catch (fallbackErr) {
      // Report both, or a HEIC that neither can decode looks like an ffmpeg problem.
      throw new Error(
        `could not render ${file.relPath}: libvips said "${message(err)}"; ffmpeg said "${message(fallbackErr)}"`,
      );
    }
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().slice(0, 200);
}

/**
 * Resizes to `size` and writes a JPEG, the right way up.
 *
 * `-autorotate` (ffmpeg's default) applies the orientation carried by the input
 * buffer itself, which covers a whole image read off disk. When the input has
 * none — an extracted preview, or an ffmpeg-decoded still — `fallbackOrientation`
 * supplies the parent file's value and the transform is applied explicitly. The
 * two never overlap in practice: callers only pass a non-null fallback for a
 * buffer they know carries no tag of its own (see generateThumb).
 *
 * `min(size,i{w,h})` clamps the fit box to the source itself, so
 * force_original_aspect_ratio=decrease — which shrinks to fit but does not
 * refuse to enlarge — never scales a smaller source up to `size`.
 */
async function downscale(
  input: Buffer,
  target: string,
  size: number,
  fallbackOrientation: number | null,
): Promise<void> {
  const filters = [
    orientationFilter(fallbackOrientation),
    `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`,
  ].filter((f): f is string => f !== null);

  await runFfmpegToFile(
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', filters.join(','),
      '-vcodec', 'mjpeg',
      '-q:v', '4',
      '-y', target,
    ],
    input,
  );
}

/**
 * ffmpeg filter fragment that corrects an EXIF orientation (1–8) baked in as pixel
 * geometry rather than a tag ffmpeg can autorotate from.
 *
 * This is the standard EXIF-orientation-to-transpose table (the same one ffmpeg's
 * own autorotate logic uses internally) rather than a hand-derived flip/rotate
 * composition — 5 and 7 are the two that are easy to get backwards, since both
 * combine a quarter turn with a mirror in opposite directions.
 */
export function orientationFilter(orientation: number | null): string | null {
  switch (orientation) {
    case 2: return 'hflip';
    case 3: return 'hflip,vflip';
    case 4: return 'vflip';
    case 5: return 'transpose=cclock_flip';
    case 6: return 'transpose=clock';
    case 7: return 'transpose=clock_flip';
    case 8: return 'transpose=cclock';
    default: return null;
  }
}

/** What a camera's own `ThumbnailImage` is worth: typically 160 px, never more. */
const EMBEDDED_THUMBNAIL_PX = 160;

/**
 * Pulls a JPEG preview out of the file's own metadata. Tries the largest first:
 * `JpgFromRaw` and `PreviewImage` are full-size-ish, `ThumbnailImage` is typically
 * 160 px and so only satisfies a tier no larger than that — asking a bigger tier to
 * accept it would cache a small image under a large name, since nothing here enlarges.
 */
async function extractEmbeddedPreview(absPath: string, size: number): Promise<Buffer | null> {
  const tags = size <= EMBEDDED_THUMBNAIL_PX
    ? ['JpgFromRaw', 'PreviewImage', 'ThumbnailImage']
    : ['JpgFromRaw', 'PreviewImage'];
  for (const tag of tags) {
    try {
      const buf = await exiftool().extractBinaryTagToBuffer(tag as never, absPath);
      if (buf && buf.length > 0) return Buffer.from(buf);
    } catch {
      // tag absent on this file; try the next
    }
  }
  return null;
}

async function readWhole(absPath: string): Promise<Buffer> {
  return fs.promises.readFile(absPath);
}

/**
 * Decodes a still image ffmpeg understands but libvips does not — in practice HEIC,
 * whose HEVC decoder the bundled libvips lacks (SPEC §14 risk 1). No seeking: a
 * still has one frame, and `-ss` on it only wastes a process.
 */
async function decodeStill(absPath: string): Promise<Buffer> {
  return runFfmpeg([
    '-loglevel', 'error',
    '-i', absPath,
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-',
  ]);
}

/**
 * Grabs a still from a video at ~10% of its duration, clamped to 1–5 s (SPEC §10.1).
 * The first frame is often a black fade-in, and 10% lands inside the actual shot.
 */
async function grabVideoFrame(absPath: string, durationMs: number | null): Promise<Buffer> {
  const seekSeconds = clamp(((durationMs ?? 0) / 1000) * 0.1, 1, 5);
  return runFfmpeg([
    '-loglevel', 'error',
    '-ss', seekSeconds.toFixed(2),
    '-i', absPath,
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-',
  ]).catch(() =>
    // Seeking past the end of a very short clip yields nothing; fall back to frame 0.
    decodeStill(absPath),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg';

function runFfmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const out = Buffer.concat(chunks);
      if (out.length > 0) resolve(out);
      else reject(new Error(`ffmpeg produced no frame (exit ${code}): ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/**
 * Like `runFfmpeg`, but feeds `input` on stdin and writes straight to a target
 * file instead of collecting stdout — used for the resize step, whose output is
 * cached on disk rather than piped onward.
 */
function runFfmpegToFile(args: string[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().slice(0, 200)}`));
    });
    // ffmpeg may reject the input and close stdin before we finish writing it;
    // the close handler above still reports that via the non-zero exit code.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}
