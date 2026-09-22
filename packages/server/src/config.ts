import path from 'node:path';
import fs from 'node:fs';

/** Deployment configuration, from the environment (SPEC §11). */
export interface Config {
  /** Absolute, symlink-resolved root. All filesystem access is confined beneath it. */
  photoRoot: string;
  port: number;
  host: string;
  tileCacheDir: string;
  pmtilesDir: string;
  /**
   * Where application state that is not tied to one photo folder lives — currently
   * only the recent-folders list. Not in SPEC §11; defaults to the parent of
   * TILE_CACHE_DIR so the stock Docker mount (`./cache:/cache`) already covers it.
   */
  stateDir: string;
  scanConcurrency: number;
  logLevel: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Reads the configuration. `photoRootOverride` comes from the CLI argument, which is
 * how the local `geotagger ~/Pictures/Italy2025` form works (SPEC §12).
 */
export function loadConfig(photoRootOverride?: string): Config {
  const rawRoot = photoRootOverride ?? process.env.PHOTO_ROOT;
  if (!rawRoot) {
    throw new Error('PHOTO_ROOT is required (or pass a folder as the first argument)');
  }
  const resolved = path.resolve(rawRoot);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PHOTO_ROOT does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`PHOTO_ROOT is not a directory: ${resolved}`);
  }
  const tileCacheDir = process.env.TILE_CACHE_DIR ?? '/cache/tiles';
  return {
    photoRoot: fs.realpathSync(resolved),
    port: intEnv('PORT', 8080),
    host: process.env.HOST ?? '0.0.0.0',
    tileCacheDir,
    pmtilesDir: process.env.PMTILES_DIR ?? '/cache/pmtiles',
    stateDir: process.env.STATE_DIR ?? path.dirname(tileCacheDir),
    scanConcurrency: intEnv('SCAN_CONCURRENCY', 2),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
