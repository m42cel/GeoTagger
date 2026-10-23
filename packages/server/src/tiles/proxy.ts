import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_VERSION } from '../version.js';
import { Semaphore } from './limiter.js';
import { getProvider, type TileProvider } from './providers.js';

/**
 * The OSMF tile usage policy requires an identifying User-Agent (SPEC §7.1); naming
 * the tool and marking it self-hosted is what a reviewer of the access log needs.
 */
const USER_AGENT = `GeoTagger/${APP_VERSION} (self-hosted photo geotagging tool)`;

export class UnknownProviderError extends Error {
  constructor(id: string) {
    super(`Unknown tile provider: ${id}`);
    this.name = 'UnknownProviderError';
  }
}

export class UpstreamTileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTileError';
  }
}

/**
 * Serves tiles from a permanent on-disk cache (SPEC §7.2), fetching from the
 * provider and caching on a miss. The cache never expires and is shared across every
 * folder — map data ages, but disk is cheap and staying cached maximises offline
 * coverage.
 *
 * One instance lives for the life of the process (not per-session, like `Session`),
 * because the cache and the provider concurrency limits are global.
 */
export class TileProxy {
  private readonly limiters = new Map<string, Semaphore>();
  // De-duplicates concurrent requests for the tile the browser has not received yet
  // — panning re-requests visible tiles quickly, and two fetches racing to write the
  // same cache file would waste a request and could interleave the two writes.
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly cacheDir: string) {}

  /** Resolves to the cached tile's path and content type, fetching it first on a miss. */
  async getTile(providerId: string, z: number, x: number, y: number): Promise<{ path: string; contentType: string }> {
    const provider = getProvider(providerId);
    if (!provider) throw new UnknownProviderError(providerId);

    const cachePath = this.pathFor(provider.id, z, x, y);
    if (fs.existsSync(cachePath)) return { path: cachePath, contentType: provider.contentType };

    const pending = this.inFlight.get(cachePath);
    if (!pending) {
      const task = this.fetchAndCache(provider, z, x, y, cachePath).finally(() => {
        this.inFlight.delete(cachePath);
      });
      this.inFlight.set(cachePath, task);
    }
    await this.inFlight.get(cachePath);
    return { path: cachePath, contentType: provider.contentType };
  }

  private pathFor(providerId: string, z: number, x: number, y: number): string {
    // SPEC §7.2: `TILE_CACHE_DIR/<provider>/<z>/<x>/<y>.png`
    return path.join(this.cacheDir, providerId, String(z), String(x), `${y}.png`);
  }

  private limiterFor(provider: TileProvider): Semaphore {
    let limiter = this.limiters.get(provider.id);
    if (!limiter) {
      limiter = new Semaphore(provider.concurrency);
      this.limiters.set(provider.id, limiter);
    }
    return limiter;
  }

  private async fetchAndCache(
    provider: TileProvider,
    z: number,
    x: number,
    y: number,
    cachePath: string,
  ): Promise<string> {
    const buffer = await this.limiterFor(provider).run(async () => {
      const res = await fetch(provider.url(z, x, y), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        throw new UpstreamTileError(`${provider.label} returned ${res.status} for tile ${z}/${x}/${y}`);
      }
      return Buffer.from(await res.arrayBuffer());
    });

    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    // Written under a temporary name and renamed into place so a reader never sees
    // a partially written file, however many tiles are downloading at once.
    const tmpPath = `${cachePath}.tmp-${crypto.randomUUID()}`;
    await fsp.writeFile(tmpPath, buffer);
    await fsp.rename(tmpPath, cachePath);
    return cachePath;
  }
}
