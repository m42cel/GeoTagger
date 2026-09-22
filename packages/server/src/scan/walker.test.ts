import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countMedia, walkMedia } from './walker.js';

let root: string;

function write(relPath: string, contents = 'x'): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-walk-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const paths = (): string[] => [...walkMedia(root)].map((f) => f.relPath).sort();

describe('walkMedia — SPEC §10.1 step 1', () => {
  it('finds supported media recursively, with forward-slash relative paths', () => {
    write('IMG_0001.JPG');
    write('PersonA/IMG_0002.heic');
    write('PersonA/Day2/VID_0003.MP4');
    expect(paths()).toEqual(['IMG_0001.JPG', 'PersonA/Day2/VID_0003.MP4', 'PersonA/IMG_0002.heic']);
  });

  it('accepts every extension in scope, in any case', () => {
    for (const name of ['a.jpg', 'b.JPEG', 'c.heic', 'd.HEIF', 'e.png', 'f.mp4', 'g.MOV', 'h.m4v']) {
      write(name);
    }
    expect(paths()).toHaveLength(8);
  });

  it('ignores out-of-scope files, RAW included — RAW is deferred (SPEC §9.5)', () => {
    write('a.jpg');
    write('raw.cr2');
    write('raw.arw');
    write('notes.txt');
    write('sidecar.xmp');
    expect(paths()).toEqual(['a.jpg']);
  });

  it('classifies images and videos', () => {
    write('a.jpg');
    write('b.mp4');
    const byPath = new Map([...walkMedia(root)].map((f) => [f.relPath, f]));
    expect(byPath.get('a.jpg')?.kind).toBe('image');
    expect(byPath.get('b.mp4')?.kind).toBe('video');
  });

  it('records size and mtime, which are what change detection compares', () => {
    write('a.jpg', 'twelve chars');
    const found = [...walkMedia(root)][0];
    expect(found?.sizeBytes).toBe(12);
    expect(found?.mtime).toBeGreaterThan(0);
  });

  it('does not descend into .geotagger/, so its own thumbnails are never scanned', () => {
    write('a.jpg');
    write('.geotagger/thumbs/00/1.jpg');
    expect(paths()).toEqual(['a.jpg']);
  });

  it('skips NAS and macOS housekeeping directories', () => {
    write('a.jpg');
    write('@eaDir/a.jpg/SYNOPHOTO_THUMB_M.jpg');
    write('#recycle/deleted.jpg');
    write('.Trashes/old.jpg');
    expect(paths()).toEqual(['a.jpg']);
  });

  it('skips macOS resource forks', () => {
    write('a.jpg');
    write('._a.jpg');
    expect(paths()).toEqual(['a.jpg']);
  });

  it('returns nothing for an empty folder', () => {
    expect(paths()).toEqual([]);
  });

  it('skips an unreadable directory rather than aborting the whole scan', () => {
    write('a.jpg');
    write('locked/b.jpg');
    const locked = path.join(root, 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      expect(paths()).toEqual(['a.jpg']);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('countMedia — the folder browser count', () => {
  it('counts recursively, because that is what opening the folder would scan', () => {
    write('PersonA/a.jpg');
    write('PersonB/b.jpg');
    write('PersonB/Day2/c.mp4');
    expect(countMedia(root)).toMatchObject({ media: 3, capped: false, hasSubfolders: true });
  });

  it('reports no subfolders for a flat folder', () => {
    write('a.jpg');
    expect(countMedia(root)).toMatchObject({ media: 1, hasSubfolders: false });
  });

  it('stops at the cap and says so, so browsing cannot walk the whole NAS', () => {
    for (let i = 0; i < 12; i += 1) write(`f${i}.jpg`);
    expect(countMedia(root, 5)).toMatchObject({ media: 5, capped: true });
    expect(countMedia(root, 100)).toMatchObject({ media: 12, capped: false });
  });

  it('returns zero for a folder it cannot read', () => {
    expect(countMedia(path.join(root, 'nope'))).toMatchObject({ media: 0, capped: false });
  });
});
