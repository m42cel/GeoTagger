import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import type { FileRecord } from '@geotagger/shared';
import { exiftool } from '../metadata/reader.js';

/** Two cached tiers (SPEC §10.1 step 6): eager grid thumbnails, on-demand previews. */
export type ThumbTier = 'thumb' | 'preview';

export const TIER_SIZE: Record<ThumbTier, number> = { thumb: 160, preview: 1280 };

export function thumbPath(thumbsDir: string, fileId: number, tier: ThumbTier): string {
  // Two hex levels of fan-out, so a 5,000-file folder never puts 5,000 entries in
  // one directory — which some NAS filesystems handle poorly.
  const bucket = (fileId % 256).toString(16).padStart(2, '0');
  return path.join(thumbsDir, tier, bucket, `${fileId}.jpg`);
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
 * `.rotate()` with no argument applies the orientation carried by the input buffer
 * itself, which covers a whole image read off disk. When the input has none —
 * an extracted preview, or an ffmpeg-decoded still — `fallbackOrientation` supplies
 * the parent file's value and the transform is applied explicitly.
 */
async function downscale(
  input: Buffer,
  target: string,
  size: number,
  fallbackOrientation: number | null,
): Promise<void> {
  const pipeline = sharp(input, { failOn: 'none' });
  const own = (await pipeline.metadata()).orientation ?? null;

  // The input's own tag wins: it describes the bytes actually being decoded.
  const oriented = own !== null ? pipeline.rotate() : applyOrientation(pipeline, fallbackOrientation);

  await oriented
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(target);
}

/**
 * Applies an EXIF orientation (1–8) as explicit geometry.
 *
 * The mapping is verified against sharp's own `.rotate()` for all eight values —
 * note that 5 and 7 are the two that are easy to transpose, since both combine a
 * quarter turn with a mirror in opposite directions.
 */
export function applyOrientation(pipeline: sharp.Sharp, orientation: number | null): sharp.Sharp {
  switch (orientation) {
    case 2: return pipeline.flop();
    case 3: return pipeline.rotate(180);
    case 4: return pipeline.flip();
    case 5: return pipeline.rotate(270).flop();
    case 6: return pipeline.rotate(90);
    case 7: return pipeline.rotate(90).flop();
    case 8: return pipeline.rotate(270);
    default: return pipeline;
  }
}

/**
 * Pulls a JPEG preview out of the file's own metadata. Tries the largest first:
 * `JpgFromRaw` and `PreviewImage` are full-size-ish, `ThumbnailImage` is typically
 * 160 px and only usable for the small tier.
 */
async function extractEmbeddedPreview(absPath: string, size: number): Promise<Buffer | null> {
  const tags = size <= TIER_SIZE.thumb
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
