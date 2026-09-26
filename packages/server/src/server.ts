import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import { SessionManager, NoSessionError } from './session.js';
import { PathConfinementError } from './paths.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerFileRoutes } from './routes/files.js';
import { registerStripRoutes } from './routes/strips.js';
import { registerPersistRoutes } from './routes/persist.js';
import { registerTileRoutes } from './routes/tiles.js';
import { StripOperationError } from './strips/service.js';
import { configureExiftool } from './metadata/reader.js';
import { ensureExiftoolConfig } from './write/exiftool-config.js';

export interface BuiltServer {
  app: FastifyInstance;
  sessions: SessionManager;
}

export function buildServer(config: Config): BuiltServer {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Media paths can be long; the default 8 kB header limit is unrelated but the
    // body limit matters once persist batches arrive in phase 1.
    bodyLimit: 8 * 1024 * 1024,
    // scan-stream and persist are long-lived SSE responses that Fastify's default
    // 'idle' close policy never sees as idle. Without this, app.close() blocks on
    // them until the client disconnects, so `docker stop` stalls out its grace
    // period and gets SIGKILLed instead of shutting down.
    forceCloseConnections: true,
  });

  const sessions = new SessionManager(config, (msg, err) => app.log.warn({ err }, msg));

  // ExifTool's launch arguments are fixed for the life of the process, so the config
  // that declares GeoTagger's XMP namespace has to be in place before the first read.
  const exiftoolConfig = ensureExiftoolConfig(config.stateDir);
  if (exiftoolConfig === null) {
    app.log.warn(
      'could not write the ExifTool config; original values will be kept in the edit store only (SPEC §9.3)',
    );
  }
  configureExiftool(exiftoolConfig);

  app.setErrorHandler((rawError, _req, reply) => {
    const err = rawError as Error & { statusCode?: number; code?: string };
    if (err instanceof NoSessionError) {
      return reply.code(409).send({ error: 'no_session', message: err.message });
    }
    if (err instanceof StripOperationError) {
      // A refused strip edit is an answer to the user, not a fault: a locked strip, a
      // cut outside a strip, two segments that are not adjacent.
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof PathConfinementError) {
      // Containment of a path-traversal mistake, not an authentication failure.
      app.log.warn({ err }, 'rejected path outside PHOTO_ROOT');
      return reply.code(403).send({ error: 'forbidden_path', message: err.message });
    }
    if (err.code === 'ENOENT') {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    app.log.error({ err }, 'request failed');
    return reply.code(err.statusCode ?? 500).send({
      error: 'internal_error',
      message: err.message,
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    photoRoot: config.photoRoot,
    scanConcurrency: config.scanConcurrency,
  }));

  registerFolderRoutes(app, config, sessions);
  registerSessionRoutes(app, sessions);
  registerFileRoutes(app, sessions);
  registerStripRoutes(app, sessions);
  registerPersistRoutes(app, sessions);
  registerTileRoutes(app, config);

  registerWebUi(app);

  return { app, sessions };
}

/**
 * Serves the built frontend when it is present. In development the Vite dev server
 * proxies to this process instead, so a missing `web/dist` is normal and not an error.
 */
function registerWebUi(app: FastifyInstance): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web'),
  ];
  const webRoot = candidates.find((c) => fs.existsSync(path.join(c, 'index.html')));
  if (!webRoot) {
    app.log.info('no built frontend found; API only');
    return;
  }
  void app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: `No route ${req.url}` });
    }
    return reply.sendFile('index.html');
  });
}
