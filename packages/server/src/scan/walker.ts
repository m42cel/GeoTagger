import fs from 'node:fs';
import path from 'node:path';
import { kindForExtension } from '@geotagger/shared';
import type { ScannedFile } from '../db/store.js';
import { GEOTAGGER_DIR } from '../db/store.js';
import { toRelPath } from '../paths.js';

/** Directories that never hold the user's media and cost time to descend into. */
const SKIP_DIRS = new Set([
  GEOTAGGER_DIR,
  '.git',
  '@eaDir', // Synology thumbnail sidecars — one per media file, so skipping matters
  '#recycle',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '#snapshot',
  '.thumbnails',
]);

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

/** macOS resource forks and Synology sidecars look like media but are not. */
function isSkippedFile(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store';
}

/**
 * Walks a folder recursively, yielding the media files in it (SPEC §10.1 step 1).
 *
 * Generated rather than collected so the scan can report progress and start reading
 * metadata while the walk is still running — on a few thousand files over a NAS the
 * walk alone is long enough to be worth overlapping.
 */
export function* walkMedia(root: string): Generator<ScannedFile> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abort the whole scan
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSkippedFile(entry.name)) continue;

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const kind = kindForExtension(ext);
      if (!kind) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      yield {
        relPath: toRelPath(root, abs),
        filename: entry.name,
        ext,
        kind,
        sizeBytes: stat.size,
        mtime: Math.floor(stat.mtimeMs),
      };
    }
  }
}

/**
 * Media count for the folder browser (SPEC §6.1).
 *
 * Counted recursively, because that is what opening the folder would actually scan —
 * a folder holding only `PersonA/` and `PersonB/` would otherwise be reported as empty.
 * The count stops at `cap` and says so, so browsing a large tree cannot turn into a
 * full walk of the NAS: the picker only needs "a lot", not an exact figure.
 *
 * No `stat` is issued here — `readdir` with `withFileTypes` is enough, and the stat
 * per file is what makes the real scan slow.
 */
export interface MediaCount {
  media: number;
  /** True when counting stopped at the cap, so the UI can show "500+". */
  capped: boolean;
  hasSubfolders: boolean;
}

export function countMedia(dir: string, cap = 500): MediaCount {
  let media = 0;
  let hasSubfolders = false;
  const stack: string[] = [dir];
  let first = true;

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name) || entry.name.startsWith('.')) continue;
        if (first) hasSubfolders = true;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile() || isSkippedFile(entry.name)) continue;
      if (!kindForExtension(path.extname(entry.name).slice(1))) continue;
      media += 1;
      // Checked per file, not per directory: one flat folder of 5,000 photos would
      // otherwise sail past the cap entirely.
      if (media >= cap) return { media: cap, capped: true, hasSubfolders };
    }
    first = false;
  }
  return { media, capped: false, hasSubfolders };
}
