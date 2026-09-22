import type { FastifyInstance } from 'fastify';
import type { OplogEntry, PersistPlan, PersistProgress, PersistRequest } from '@geotagger/shared';
import type { Session, SessionManager } from '../session.js';
import { planFor, revertTime, runPersist, type PersistContext } from '../write/persist.js';
import { APP_VERSION } from '../version.js';

/**
 * Writing to files (SPEC §9) and the operation log (SPEC §10.3).
 *
 * The write itself is a stream rather than a request that returns when it is done:
 * a few hundred files on a NAS takes long enough that per-file progress is the
 * difference between a usable dialog and a frozen one.
 */
export function registerPersistRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.get('/api/persist/plan', async (): Promise<PersistPlan> => planFor(contextFor(sessions.require())));

  app.post<{ Body: PersistRequest }>('/api/persist', (req, reply) => {
    const session = sessions.require();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (progress: PersistProgress): void => {
      reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
    };

    void runPersist(contextFor(session), req.body ?? {}, send)
      .catch((err: unknown) => {
        app.log.error({ err }, 'persist failed');
        send({
          phase: 'failed',
          total: 0,
          completed: 0,
          currentPath: null,
          written: 0,
          skipped: 0,
          failed: 0,
          results: [],
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => reply.raw.end());
  });

  /** Per-file time revert (SPEC §9.4); positions revert separately, in phase 4. */
  app.post<{ Params: { id: string } }>('/api/files/:id/revert-time', async (req, reply) => {
    const session = sessions.require();
    const id = Number.parseInt(req.params.id, 10);
    const file = Number.isFinite(id) ? session.store.getFile(id) : null;
    if (!file) return reply.code(404).send({ error: 'not_found', message: `No file ${req.params.id}` });
    return revertTime(contextFor(session), file);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/oplog', async (req): Promise<OplogEntry[]> => {
    const limit = Number.parseInt(req.query.limit ?? '', 10);
    return sessions.require().store.listOplog(Number.isFinite(limit) ? Math.min(limit, 5000) : 500);
  });
}

function contextFor(session: Session): PersistContext {
  return {
    store: session.store,
    timeline: session.strips.timeline(),
    absPathFor: (relPath) => session.absPathFor(relPath),
    appVersion: APP_VERSION,
  };
}
