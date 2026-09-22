import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FolderEntry, FolderListing, RecentFolder } from '@geotagger/shared';
import type { Config } from '../config.js';
import type { SessionManager } from '../session.js';
import { FolderStore, GEOTAGGER_DIR } from '../db/store.js';
import { resolveWithinRoot, toRelPath } from '../paths.js';
import { countMedia } from '../scan/walker.js';

/**
 * The server-side folder browser of SPEC §6.1, rooted at PHOTO_ROOT. The browser runs
 * where the files are, so the NAS deployment needs no native folder dialog.
 */
export function registerFolderRoutes(app: FastifyInstance, config: Config, sessions: SessionManager): void {
  app.get<{ Querystring: { path?: string } }>('/api/folders', async (req) => {
    const relPath = normaliseRel(req.query.path ?? '');
    const abs = resolveWithinRoot(config.photoRoot, relPath);

    const entries: FolderEntry[] = [];
    for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.') || dirent.name === GEOTAGGER_DIR) continue;
      const childAbs = path.join(abs, dirent.name);
      const counts = countMedia(childAbs);
      entries.push({
        name: dirent.name,
        relPath: toRelPath(config.photoRoot, childAbs),
        mediaCount: counts.media,
        mediaCountCapped: counts.capped,
        hasSubfolders: counts.hasSubfolders,
        known: FolderStore.isKnown(childAbs),
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const listing: FolderListing = {
      relPath,
      parentRelPath: relPath === '' ? null : toRelPath(config.photoRoot, path.dirname(abs)),
      entries,
    };
    return listing;
  });

  /** The current folder itself, so the picker can show a count for "open this one". */
  app.get<{ Querystring: { path?: string } }>('/api/folders/summary', async (req) => {
    const relPath = normaliseRel(req.query.path ?? '');
    const abs = resolveWithinRoot(config.photoRoot, relPath);
    const counts = countMedia(abs);
    const entry: FolderEntry = {
      name: relPath === '' ? path.basename(config.photoRoot) : path.basename(abs),
      relPath,
      mediaCount: counts.media,
      mediaCountCapped: counts.capped,
      hasSubfolders: counts.hasSubfolders,
      known: FolderStore.isKnown(abs),
    };
    return entry;
  });

  app.get('/api/folders/recent', async (): Promise<RecentFolder[]> => sessions.listRecent());
}

/** Strips leading slashes so `/Italy2025` and `Italy2025` mean the same folder. */
function normaliseRel(input: string): string {
  return input.replace(/^\/+/, '');
}
