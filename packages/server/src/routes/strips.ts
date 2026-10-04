import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CutRequest,
  FolderUtcOffsetRequest,
  LaneRequest,
  LockRequest,
  MergeRequest,
  PinRequest,
  RegroupRequest,
  ResetRequest,
  SetOffsetRequest,
  SetTrueTimeRequest,
  StretchRequest,
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
    const seconds = req.body?.offsetSeconds;
    if (id === null || typeof seconds !== 'number' || !Number.isFinite(seconds)) {
      return badRequest(reply, 'offsetSeconds must be a number of seconds.');
    }
    sessions.require().strips.setOffset(id, seconds);
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

  /** Resets the offset, the stretch, or both (the default) — SPEC §4.3. */
  app.post<{ Params: { id: string }; Body: ResetRequest }>('/api/strips/:id/reset', async (req, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'A strip id is needed.');
    const part = req.body?.part ?? 'all';
    const strips = sessions.require().strips;
    if (part === 'offset') strips.resetOffset(id);
    else if (part === 'drift') strips.resetDrift(id);
    else if (part === 'all') strips.reset(id);
    else return badRequest(reply, `Unknown part to reset: ${String(part)}`);
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

  /**
   * Set true time (SPEC §4.3): shifts the file's whole strip so it lands there, or
   * stretches it about its pinned photo when it has one.
   */
  app.post<{ Body: SetTrueTimeRequest }>('/api/strips/set-true-time', async (req, reply) => {
    const { fileId, trueLocalIso } = req.body ?? {};
    if (typeof fileId !== 'string' || typeof trueLocalIso !== 'string') {
      return badRequest(reply, 'A file and a true time are needed.');
    }
    sessions.require().strips.setTrueTime(fileId, trueLocalIso);
    return timeline();
  });

  /** Pin or unpin one photo as having the right time (SPEC §4.3). */
  app.post<{ Body: PinRequest }>('/api/strips/pin', async (req, reply) => {
    const { fileId, pinned } = req.body ?? {};
    if (typeof fileId !== 'string' || typeof pinned !== 'boolean') {
      return badRequest(reply, 'A file and whether to pin it are needed.');
    }
    sessions.require().strips.setPinned(fileId, pinned);
    return timeline();
  });

  /** Stretch a strip about its pinned photo so one file lands on an instant (SPEC §4.3). */
  app.post<{ Params: { id: string }; Body: StretchRequest }>('/api/strips/:id/stretch', async (req, reply) => {
    const id = parseId(req.params.id);
    const { fileId, targetEffectiveMs } = req.body ?? {};
    if (id === null || typeof fileId !== 'string' || typeof targetEffectiveMs !== 'number' || !Number.isFinite(targetEffectiveMs)) {
      return badRequest(reply, 'A file and the instant it should land on are needed.');
    }
    sessions.require().strips.stretch(id, fileId, targetEffectiveMs);
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
