import type { FastifyInstance } from 'fastify';
import type { OpenSessionRequest, ScanStatus, SessionState } from '@geotagger/shared';
import type { Session, SessionManager } from '../session.js';

export function registerSessionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.get('/api/session', async (_req, reply): Promise<SessionState | null> => {
    const session = sessions.get();
    if (!session) {
      reply.code(200);
      return null;
    }
    return session.state();
  });

  /**
   * Opens a folder and starts its scan. Returns as soon as the scan has started, not
   * when it finishes — progress streams over `scan-stream` and the UI blocks on it
   * until it settles (SPEC §6.1 step 2).
   */
  app.post<{ Body: OpenSessionRequest }>('/api/session/open', async (req): Promise<SessionState> => {
    const session = sessions.open(req.body?.relPath ?? '');
    startScan(sessions, session, app);
    return session.state();
  });

  app.post('/api/session/rescan', async (): Promise<SessionState> => {
    const session = sessions.require();
    startScan(sessions, session, app);
    return session.state();
  });

  app.post('/api/session/close', async () => {
    sessions.closeAll();
    return { ok: true };
  });

  app.get('/api/session/scan-status', async (): Promise<ScanStatus> => sessions.require().scanner.getStatus());

  /**
   * Records that the timestamp question of SPEC §6.1 has been answered.
   *
   * The answer itself is not stored — both roads stay open afterwards, and the
   * alignment view is reachable at any time. Only the fact that it was asked is, so
   * that reopening a folder whose clocks were sorted out weeks ago does not ask again.
   */
  app.post('/api/session/timestamp-question', async (): Promise<SessionState> => {
    const session = sessions.require();
    session.store.timestampQuestionAnswered = true;
    return session.state();
  });

  /**
   * Progress as Server-Sent Events (SPEC §10.2). A stream rather than polling so the
   * per-file progress of a long first scan actually reaches the UI.
   */
  app.get('/api/session/scan-stream', (req, reply) => {
    const session = sessions.require();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (status: ScanStatus): void => {
      reply.raw.write(`data: ${JSON.stringify(status)}\n\n`);
    };
    send(session.scanner.getStatus());

    // Coalesce: a 5,000-file scan emits far more updates than a UI can use.
    let latest: ScanStatus | null = null;
    const unsubscribe = session.scanner.onChange((s) => {
      latest = s;
    });
    const timer = setInterval(() => {
      if (latest) {
        send(latest);
        latest = null;
      } else {
        reply.raw.write(': keepalive\n\n');
      }
    }, 250);

    req.raw.on('close', () => {
      clearInterval(timer);
      unsubscribe();
    });
  });
}

/**
 * Starts a scan and regroups once it settles.
 *
 * The regroup is skipped if the user opened another folder meanwhile — that session's
 * store is closed by then, and rebuilding strips in it would only raise.
 */
function startScan(sessions: SessionManager, session: Session, app: FastifyInstance): void {
  void session.scanner.start().then(() => {
    if (!sessions.isCurrent(session)) return;
    try {
      session.regroupIfNeeded();
      sessions.rememberRecent(session);
    } catch (err) {
      app.log.warn({ err }, 'could not finish up after scan');
    }
  });
}
