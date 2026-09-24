import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { FFMPEG_BIN, orientationFilter, pruneStaleThumbTiers, thumbPath, TIER_SIZE } from './generator.js';

const JPEG = { quality: 100, chromaSubsampling: '4:4:4' } as const;

/**
 * Applies an orientationFilter fragment the same way `downscale` does — spawns
 * real ffmpeg rather than re-implementing filter semantics in the test, so a
 * wrong `transpose` direction fails here instead of only in a rendered thumbnail.
 */
async function ffmpegOrient(src: Buffer, filter: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1'];
    if (filter) args.push('-vf', filter);
    args.push('-vcodec', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', '-');
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().slice(0, 200)}`));
    });
    proc.stdin.end(src);
  });
}

/**
 * A probe image with four identifiable quadrants: top-left red, top-right green,
 * bottom-left blue, bottom-right white. Reading them back after a transform says
 * exactly which rotation or mirror was applied.
 */
async function probe(): Promise<Buffer> {
  const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  return sharp(raw, { raw: { width: 2, height: 2, channels: 3 } })
    .resize(120, 120, { kernel: 'nearest' })
    .jpeg(JPEG)
    .toBuffer();
}

/** The four quadrant colours, sampled at their centres, as "TL TR BL BR". */
async function quadrants(buf: Buffer): Promise<string> {
  const { width = 0, height = 0 } = await sharp(buf).metadata();
  const out: string[] = [];
  for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
    const { data } = await sharp(buf)
      .extract({ left: Math.floor(width * fx), top: Math.floor(height * fy), width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const [r = 0, g = 0, b = 0] = data;
    out.push(
      r > 150 && g < 100 && b < 100 ? 'R'
      : g > 150 && r < 100 && b < 100 ? 'G'
      : b > 150 && r < 100 && g < 100 ? 'B'
      : r > 150 && g > 150 && b > 150 ? 'W'
      : '?',
    );
  }
  return out.join('');
}

describe('orientationFilter', () => {
  it('stores the probe unrotated, so the fixtures below mean what they say', async () => {
    expect(await quadrants(await probe())).toBe('RGBW');
  });

  /**
   * The expected values are the EXIF standard: 2–4 are mirrors, 6 and 8 are quarter
   * turns, and 5 and 7 are the diagonal mirrors that are easy to get backwards.
   */
  const expected: Record<number, string> = {
    1: 'RGBW', // upright
    2: 'GRWB', // mirrored horizontally
    3: 'WBGR', // 180°
    4: 'BWRG', // mirrored vertically
    5: 'RBGW', // transposed
    6: 'BRWG', // 90° clockwise
    7: 'WGBR', // transversed
    8: 'GWRB', // 270° clockwise
  };

  for (const [orientation, want] of Object.entries(expected)) {
    it(`orientation ${orientation} produces ${want}`, async () => {
      const src = await probe();
      const out = await ffmpegOrient(src, orientationFilter(Number(orientation)));
      expect(await quadrants(out)).toBe(want);
    });
  }

  /**
   * The point of the mapping: it must agree with what sharp itself does when the tag
   * is present. If a future ffmpeg or sharp changes its convention, this fails rather
   * than silently tilting every thumbnail rendered from an embedded preview.
   */
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`orientation ${orientation} matches sharp's own auto-rotate`, async () => {
      const src = await probe();
      const tagged = await sharp(src).withMetadata({ orientation }).jpeg(JPEG).toBuffer();
      const auto = await sharp(tagged).rotate().jpeg(JPEG).toBuffer();
      const explicit = await ffmpegOrient(src, orientationFilter(orientation));
      expect(await quadrants(explicit)).toBe(await quadrants(auto));
    });
  }

  it('leaves the image alone for a missing or meaningless orientation', async () => {
    const src = await probe();
    for (const value of [null, 0, 9, 1]) {
      const out = await ffmpegOrient(src, orientationFilter(value));
      expect(await quadrants(out)).toBe('RGBW');
    }
  });
});

/**
 * The cache lives inside the user's photo folder and outlives any one build, so the
 * two things that matter are that a tier's size reaches its path — otherwise a raised
 * tier silently serves the old, smaller image for ever — and that pruning it cannot
 * reach anything that is not GeoTagger's.
 */
describe('the thumbnail cache', () => {
  function tempThumbsDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-thumbs-'));
  }

  function touch(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }

  it('keys a path by the tier and its pixel size', () => {
    const p = thumbPath('/state/thumbs', 42, 'thumb');
    expect(p).toContain(`thumb-${TIER_SIZE.thumb}`);
    expect(path.basename(p)).toBe('42.jpg');
  });

  it('deletes an older tier size and keeps the current ones', () => {
    const dir = tempThumbsDir();
    touch(path.join(dir, 'thumb-160', '2a', '1.jpg'));
    // The layout before the size was part of the path.
    touch(path.join(dir, 'thumb', '2a', '1.jpg'));
    touch(thumbPath(dir, 1, 'thumb'));
    touch(thumbPath(dir, 1, 'preview'));

    pruneStaleThumbTiers(dir);

    expect(fs.existsSync(path.join(dir, 'thumb-160'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'thumb'))).toBe(false);
    expect(fs.existsSync(thumbPath(dir, 1, 'thumb'))).toBe(true);
    expect(fs.existsSync(thumbPath(dir, 1, 'preview'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves anything that is not a tier directory alone', () => {
    const dir = tempThumbsDir();
    touch(path.join(dir, 'holiday', 'DSC001.jpg'));
    touch(path.join(dir, 'loose.jpg'));

    pruneStaleThumbTiers(dir);

    expect(fs.existsSync(path.join(dir, 'holiday', 'DSC001.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'loose.jpg'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing about a folder that has never been scanned', () => {
    expect(() => pruneStaleThumbTiers(path.join(os.tmpdir(), 'geotagger-absent-xyz'))).not.toThrow();
  });
});
