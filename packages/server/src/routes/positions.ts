import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BulkConfirmRequest, DragPositionRequest, FilesResponse } from '@geotagger/shared';
import type { Session, SessionManager } from '../session.js';

/**
 * Editing a file's position (SPEC §5.5, §5.6, §6.5): drag, confirm, revert, reset,
 * and a multi-select bulk confirm.
 *
 * Revert and reset are deliberately two different routes, not one: revert cancels
 * only a drag in progress, falling back to whatever anchor (confirmed or camera GPS)
 * was underneath it; reset discards that anchor too. Confirming a plain interpolated
 * estimate that was never dragged has no anchor to fall back to, so it only ever
 * gets a reset.
 *
 * Bulk confirm takes one snapshot of the current positions and confirms each
 * selected file against it, rather than recomputing between every one — "confirm the
 * selection together" (§6.5) means as they currently stand, not a cascade where
 * confirming one shifts what a later one in the same batch would confirm.
 *
 * Every route answers with the whole `FilesResponse`, like the strips routes answer
 * with the whole timeline. A drag only ever changes the dragged file's own entry,
 * but a confirm, revert, reset or bulk confirm can change which files are anchors,
 * which recomputes every unconfirmed estimate in the folder (SPEC §5.5) — either
 * way, nothing less than the whole response would leave the map showing stale
 * positions somewhere.
 */
export function registerPositionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  const filesResponse = (session: Session): FilesResponse => {
    const files = session.store.listFiles();
    const positions = session.positions.compute(files);
    return {
      files,
      devices: session.store.listDevices(),
      positions,
      unpersistedFileIds: session.positions.unpersistedFileIds(positions),
    };
  };

  app.post<{ Params: { id: string }; Body: DragPositionRequest }>('/api/files/:id/position', async (req, reply) => {
    const session = sessions.require();
    const id = parseId(req.params.id);
    const { lat, lon } = req.body ?? {};
    if (id === null || !session.store.getFile(id)) return notFound(reply, req.params.id);
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return badRequest(reply, 'lat and lon must be numbers.');
    }
    session.store.setDraggedPosition(id, lat, lon);
    return filesResponse(session);
  });

  app.post<{ Params: { id: string } }>('/api/files/:id/confirm', async (req, reply) => {
    const session = sessions.require();
    const id = parseId(req.params.id);
    if (id === null || !session.store.getFile(id)) return notFound(reply, req.params.id);

    const current = session.positions.compute(session.store.listFiles()).find((p) => p.fileId === id);
    if (!current || current.lat === null || current.lon === null) {
      return badRequest(reply, 'This file has no position to confirm.');
    }
    session.store.confirmPosition(id, current.lat, current.lon, current.uncertaintyM, current.source === 'manual');
    return filesResponse(session);
  });

  app.post<{ Params: { id: string } }>('/api/files/:id/revert-position', async (req, reply) => {
    const session = sessions.require();
    const id = parseId(req.params.id);
    if (id === null || !session.store.getFile(id)) return notFound(reply, req.params.id);
    session.store.revertPendingPosition(id);
    return filesResponse(session);
  });

  app.post<{ Params: { id: string } }>('/api/files/:id/reset-position', async (req, reply) => {
    const session = sessions.require();
    const id = parseId(req.params.id);
    if (id === null || !session.store.getFile(id)) return notFound(reply, req.params.id);
    session.store.resetPosition(id);
    return filesResponse(session);
  });

  /**
   * Reset to original (SPEC §6.5, §9.4): shown only once the file has been persisted.
   * Flag-setting only — nothing is written until the next Persist run.
   */
  app.post<{ Params: { id: string } }>('/api/files/:id/reset-position-to-original', async (req, reply) => {
    const session = sessions.require();
    const id = parseId(req.params.id);
    if (id === null || !session.store.getFile(id)) return notFound(reply, req.params.id);
    session.store.resetPositionToOriginal(id);
    return filesResponse(session);
  });

  app.post<{ Body: BulkConfirmRequest }>('/api/edits/bulk', async (req, reply) => {
    const session = sessions.require();
    const fileIds = req.body?.fileIds;
    if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== 'number')) {
      return badRequest(reply, 'fileIds must be an array of numbers.');
    }
    for (const id of fileIds) {
      if (!session.store.getFile(id)) return notFound(reply, String(id));
    }

    const snapshot = new Map(session.positions.compute(session.store.listFiles()).map((p) => [p.fileId, p]));
    for (const id of fileIds) {
      const current = snapshot.get(id);
      // Same eligibility as the single-file confirm button (§6.5): camera GPS and an
      // already-confirmed position are already anchors, with nothing to confirm —
      // "confirming" one again would just re-stamp it as a manual edit for no reason.
      if (!current || current.lat === null || current.lon === null) continue;
      if (current.source !== 'estimate' && current.source !== 'manual') continue;
      session.store.confirmPosition(id, current.lat, current.lon, current.uncertaintyM, current.source === 'manual');
    }
    return filesResponse(session);
  });
}

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? id : null;
}

function notFound(reply: FastifyReply, rawId: string): FastifyReply {
  return reply.code(404).send({ error: 'not_found', message: `No file ${rawId}` });
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}
