import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FilesResponse } from '@geotagger/shared';
import type { SessionManager } from '../session.js';
import { generateThumb, thumbPath, type ThumbTier } from '../thumbs/generator.js';

export function registerFileRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.get('/api/files', async (): Promise<FilesResponse> => {
    const session = sessions.require();
    const files = session.store.listFiles();
    return {
      files,
      devices: session.store.listDevices(),
      positions: session.positions.compute(files),
    };
  });

  app.get('/api/devices', async () => sessions.require().store.listDevices());

  app.get<{ Params: { id: string } }>('/api/files/:id/thumb', (req, reply) =>
    serveThumb(sessions, req.params.id, 'thumb', reply),
  );

  app.get<{ Params: { id: string } }>('/api/files/:id/preview', (req, reply) =>
    serveThumb(sessions, req.params.id, 'preview', reply),
  );
}

/**
 * Serves a cached thumbnail, rendering it on the spot if it is not there yet. The
 * 1280 px preview tier is only ever produced this way — rendering one per file
 * eagerly would triple the first scan for images most users never open (SPEC §10.1).
 */
async function serveThumb(
  sessions: SessionManager,
  rawId: string,
  tier: ThumbTier,
  reply: FastifyReply,
): Promise<unknown> {
  const session = sessions.require();
  const id = Number.parseInt(rawId, 10);
  const file = Number.isFinite(id) ? session.store.getFile(id) : null;
  if (!file) return reply.code(404).send({ error: 'not_found', message: `No file ${rawId}` });

  const target = thumbPath(session.store.thumbsDir, file.id, tier);
  if (!fs.existsSync(target)) {
    try {
      await generateThumb(session.absPathFor(file.relPath), file, session.store.thumbsDir, tier);
      if (tier === 'thumb') session.store.setThumbState(file.id, 'ready');
    } catch (err) {
      if (tier === 'thumb') session.store.setThumbState(file.id, 'failed');
      return reply.code(422).send({
        error: 'thumb_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Thumbnails are keyed by file id and regenerated whenever size or mtime change,
  // so a long immutable cache is safe and keeps the grid instant on revisits.
  return reply
    .header('Content-Type', 'image/jpeg')
    .header('Cache-Control', 'private, max-age=86400')
    .send(fs.createReadStream(target));
}
