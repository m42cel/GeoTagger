import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { TILE_PROVIDERS } from '../tiles/providers.js';
import { TileProxy, UnknownProviderError, UpstreamTileError } from '../tiles/proxy.js';

/** The cached tile proxy of SPEC §7 — no folder needs to be open to serve a tile. */
export function registerTileRoutes(app: FastifyInstance, config: Config): void {
  const proxy = new TileProxy(config.tileCacheDir);

  app.get('/api/tile-providers', async () => Object.values(TILE_PROVIDERS).map((p) => ({ id: p.id, label: p.label })));

  app.get<{ Params: { provider: string; z: string; x: string; y: string } }>(
    '/tiles/:provider/:z/:x/:y.png',
    async (req, reply) => {
      const { provider, z, x, y } = req.params;
      const zn = Number.parseInt(z, 10);
      const xn = Number.parseInt(x, 10);
      const yn = Number.parseInt(y, 10);
      if (!Number.isFinite(zn) || !Number.isFinite(xn) || !Number.isFinite(yn)) {
        return badRequest(reply, 'z, x and y must be integers.');
      }

      try {
        const tile = await proxy.getTile(provider, zn, xn, yn);
        // Content is keyed by (provider, z, x, y) and never changes once cached, so
        // the browser can hold onto it indefinitely (SPEC §7.2: the cache itself
        // never expires either).
        return reply
          .header('Content-Type', tile.contentType)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .send(fs.createReadStream(tile.path));
      } catch (err) {
        if (err instanceof UnknownProviderError) {
          return reply.code(404).send({ error: 'unknown_provider', message: err.message });
        }
        if (err instanceof UpstreamTileError) {
          return reply.code(502).send({ error: 'upstream_tile_error', message: err.message });
        }
        throw err;
      }
    },
  );
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}
