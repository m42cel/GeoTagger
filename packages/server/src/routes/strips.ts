import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CutRequest,
  FolderUtcOffsetRequest,
  LaneRequest,
  LockRequest,
  MergeRequest,
  PinTrueTimeRequest,
  RegroupRequest,
  SetOffsetRequest,
  StripUtcOffsetRequest,
  StripsResponse,
  TimelineResponse,
} from '@geotagger/shared';
import type { SessionManager } from '../session.js';

/**
 * The alignment view's API (SPEC §10.2).
 *
 * Every mutating route answers with the whole timeline rather than just what it
 * changed. One offset change can promote a strip to a new lane, renumber every lane
 * below it, and move which UTC offset period its files inherit from — so anything
 * less would leave the view to guess, or to ask again immediately.
 */
export function registerStripRoutes(app: FastifyInstance, sessions: SessionManager): void {
  const timeline = (): TimelineResponse => sessions.require().strips.timelineResponse();

  app.get('/api/strips', async (): Promise<StripsResponse> => sessions.require().strips.strips());

  app.get('/api/timeline', async (): Promise<TimelineResponse> => timeline());

  app.post<{ Body: RegroupRequest }>('/api/strips/regroup', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== 'device' && mode !== 'subfolder' && mode !== 'manual') {
      return badRequest(reply, `Unknown grouping mode: ${String(mode)}`);
    }
    sessions.require().strips.regroup(mode, { fileIds: req.body.fileIds, label: req.body.label });
    return timeline();
  });

  app.post('/api/strips/reset-all', async () => {
    sessions.require().strips.resetAll();
    return timeline();
  });

  app.post('/api/strips/undo', async () => {
    sessions.require().strips.undo();
    return timeline();
  });

  app.post<{ Params: { id: string }; Body: SetOffsetRequest }>('/api/strips/:id/offset', async (req, reply) => {
    const id = parseId(req.params.id);
    const start = req.body?.offsetStartSeconds;
    if (id === null || typeof start !== 'number' || !Number.isFinite(start)) {
      return badRequest(reply, 'offsetStartSeconds must be a number of seconds.');
    }
    const end = req.body.offsetEndSeconds;
    sessions.require().strips.setOffsets(id, start, typeof end === 'number' && Number.isFinite(end) ? end : undefined);
    return timeline();
  });

  app.post<{ Params: { id: string }; Body: CutRequest }>('/api/strips/:id/cut', async (req, reply) => {
    const id = parseId(req.params.id);
    const at = req.body?.atEffectiveMs;
    if (id === null || typeof at !== 'number' || !Number.isFinite(at)) {
      return badRequest(reply, 'atEffectiveMs must be a point on the time axis.');
    }
    sessions.require().strips.cut(id, at);
    return timeline();
  });

  app.post<{ Body: MergeRequest }>('/api/strips/merge', async (req, reply) => {
    const { leftStripId, rightStripId } = req.body ?? {};
    if (typeof leftStripId !== 'number' || typeof rightStripId !== 'number') {
      return badRequest(reply, 'Two strip ids are needed to merge.');
    }
    sessions.require().strips.merge(leftStripId, rightStripId);
    return timeline();
  });

  app.post<{ Params: { id: string }; Body: LaneRequest }>('/api/strips/:id/lane', async (req, reply) => {
    const id = parseId(req.params.id);
    const lane = req.body?.lane;
    if (id === null || typeof lane !== 'number' || !Number.isFinite(lane)) {
      return badRequest(reply, 'lane must be a number.');
    }
    sessions.require().strips.moveToLane(id, lane);
    return timeline();
  });

  app.post<{ Params: { id: string }; Body: LockRequest }>('/api/strips/:id/lock', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null || typeof req.body?.locked !== 'boolean') {
      return badRequest(reply, 'locked must be true or false.');
    }
    sessions.require().strips.setLocked(id, req.body.locked);
    return timeline();
  });

  app.post<{ Params: { id: string } }>('/api/strips/:id/reset', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'A strip id is needed.');
    sessions.require().strips.reset(id);
    return timeline();
  });

  app.post<{ Params: { id: string }; Body: StripUtcOffsetRequest }>(
    '/api/strips/:id/utc-offset',
    async (req, reply) => {
      const id = parseId(req.params.id);
      const minutes = req.body?.utcOffsetMinutes;
      if (id === null || (minutes !== null && typeof minutes !== 'number')) {
        return badRequest(reply, 'utcOffsetMinutes must be a number of minutes, or null.');
      }
      sessions.require().strips.setUtcOffsetOverride(id, minutes);
      return timeline();
    },
  );

  /** Set true time (SPEC §4.3): shifts the file's whole strip so it lands there. */
  app.post<{ Body: PinTrueTimeRequest }>('/api/strips/pin-true-time', async (req, reply) => {
    const { fileId, trueLocalIso } = req.body ?? {};
    if (typeof fileId !== 'number' || typeof trueLocalIso !== 'string') {
      return badRequest(reply, 'A file and a true time are needed.');
    }
    const session = sessions.require();
    session.strips.pinTrueTime(fileId, trueLocalIso, session.strips.timeline().displayUtcOffsetMinutes);
    return timeline();
  });

  /** The one-off answer of SPEC §4.2, for a folder with no GPS-bearing file at all. */
  app.post<{ Body: FolderUtcOffsetRequest }>('/api/session/utc-offset', async (req, reply) => {
    const minutes = req.body?.utcOffsetMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || Math.abs(minutes) > 16 * 60) {
      return badRequest(reply, 'utcOffsetMinutes must be a plausible number of minutes east of UTC.');
    }
    sessions.require().store.folderUtcOffsetMinutes = minutes;
    return timeline();
  });
}

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}
