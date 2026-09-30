import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { buildServer, type BuiltServer } from '../server.js';

/**
 * A malformed file id (SPEC §8.2): file ids are UUIDs now, so anything that isn't
 * UUID-shaped has to 404 like an unknown id would, rather than reaching the store or
 * crashing the route.
 */

let root: string;
let built: BuiltServer;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-files-route-'));
  const config: Config = {
    photoRoot: fs.realpathSync(root),
    port: 0,
    host: '127.0.0.1',
    tileCacheDir: path.join(root, 'tiles'),
    pmtilesDir: path.join(root, 'pmtiles'),
    stateDir: path.join(root, 'state'),
    scanConcurrency: 1,
    logLevel: 'silent',
  };
  built = buildServer(config);
  built.sessions.open('');
});

afterEach(async () => {
  built.sessions.closeAll();
  await built.app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('GET /api/files/:id/thumb and /preview', () => {
  it('404s a malformed id instead of reaching the store', async () => {
    for (const tier of ['thumb', 'preview']) {
      const res = await built.app.inject({ method: 'GET', url: `/api/files/not-a-uuid/${tier}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    }
  });

  it('404s an old-style integer id the same way', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/files/123/thumb' });
    expect(res.statusCode).toBe(404);
  });

  it('404s a well-formed but unknown UUID', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/api/files/01958a3e-7f2a-7000-8000-000000000000/thumb',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('position routes — malformed file id', () => {
  it('404s rather than crashing on drag, confirm, revert and reset', async () => {
    const drag = await built.app.inject({
      method: 'POST',
      url: '/api/files/not-a-uuid/position',
      payload: { lat: 1, lon: 2 },
    });
    expect(drag.statusCode).toBe(404);

    for (const action of ['confirm', 'revert-position', 'reset-position']) {
      const res = await built.app.inject({ method: 'POST', url: `/api/files/not-a-uuid/${action}` });
      expect(res.statusCode).toBe(404);
    }
  });
});
