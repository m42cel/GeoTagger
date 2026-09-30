import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FileId, FilesResponse } from '@geotagger/shared';
import type { SessionManager } from '../session.js';
import { generateThumb, thumbPath, type ThumbTier } from '../thumbs/generator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A file id is a UUID (SPEC §8.2); anything else is malformed and 404s rather than 500s. */
export function isFileId(raw: string): raw is FileId {
  return UUID_RE.test(raw);
}

export function registerFileRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.get('/api/files', async (): Promise<FilesResponse> => {
    const session = sessions.require();
    const files = session.store.listFiles();
    const positions = session.positions.compute(files);
    return {
      files,
      devices: session.store.listDevices(),
      positions,
      unpersistedFileIds: session.positions.unpersistedFileIds(positions),
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
  const file = isFileId(rawId) ? session.store.getFile(rawId) : null;
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

  // File ids are UUIDv7, unique across every folder GeoTagger ever opens, so a
  // thumbnail's id never means a different photo after a rescan or a reopened
  // folder — which is what makes a day-long cache safe here.
  return reply
    .header('Content-Type', 'image/jpeg')
    .header('Cache-Control', 'private, max-age=86400')
    .send(fs.createReadStream(target));
}
