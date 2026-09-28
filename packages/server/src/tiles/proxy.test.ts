import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TileProxy, UnknownProviderError, UpstreamTileError } from './proxy.js';

let cacheDir: string;

function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-tiles-'));
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('TileProxy', () => {
  it('fetches a tile on a miss and caches it at <provider>/<z>/<x>/<y>.png', async () => {
    const fetchSpy = vi.fn(async (..._args: unknown[]) => fakeResponse('tile-bytes'));
    vi.stubGlobal('fetch', fetchSpy);

    const proxy = new TileProxy(cacheDir);
    const tile = await proxy.getTile('osm', 5, 16, 11);

    expect(tile.path).toBe(path.join(cacheDir, 'osm', '5', '16', '11.png'));
    expect(tile.contentType).toBe('image/png');
    expect(fs.readFileSync(tile.path, 'utf8')).toBe('tile-bytes');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ headers: { 'User-Agent': expect.stringContaining('GeoTagger') } });
  });

  it('reports the provider-specific content type, since Esri serves JPEG under a .png cache path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('jpeg-bytes')));
    const proxy = new TileProxy(cacheDir);
    const tile = await proxy.getTile('esri', 1, 1, 1);
    expect(tile.contentType).toBe('image/jpeg');
  });

  it('serves a cached tile without fetching again', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse('tile-bytes'));
    vi.stubGlobal('fetch', fetchSpy);

    const proxy = new TileProxy(cacheDir);
    await proxy.getTile('osm', 1, 2, 3);
    await proxy.getTile('osm', 1, 2, 3);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent requests for the same not-yet-cached tile', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal('fetch', fetchSpy);

    const proxy = new TileProxy(cacheDir);
    const first = proxy.getTile('osm', 1, 1, 1);
    const second = proxy.getTile('osm', 1, 1, 1);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    resolveFetch(fakeResponse('tile-bytes'));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown provider without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const proxy = new TileProxy(cacheDir);
    await expect(proxy.getTile('bing', 1, 1, 1)).rejects.toBeInstanceOf(UnknownProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a non-OK upstream response as UpstreamTileError, without caching it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('', false, 503)));
    const proxy = new TileProxy(cacheDir);
    await expect(proxy.getTile('osm', 1, 1, 1)).rejects.toBeInstanceOf(UpstreamTileError);
    expect(fs.existsSync(path.join(cacheDir, 'osm', '1', '1', '1.png'))).toBe(false);
  });
});
