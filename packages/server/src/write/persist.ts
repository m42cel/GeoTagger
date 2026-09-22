import fs from 'node:fs';
import type {
  FileRecord,
  PersistFileResult,
  PersistPlan,
  PersistProgress,
  PersistRequest,
  StalePolicy,
} from '@geotagger/shared';
import { contentSig, signatureOf, type FolderStore } from '../db/store.js';
import { exiftool, readRawTags } from '../metadata/reader.js';
import { collectDateCandidates } from '../metadata/exif-parse.js';
import type { Timeline } from '../time/timeline.js';
import { buildPersistPlan, type PlanContext } from './plan.js';
import {
  buildTimeRevert,
  buildTimeWrite,
  fromExifDate,
  localIsoForFile,
  type AppliedState,
  type OriginalSnapshot,
  type TimePayload,
} from './tags.js';

/**
 * The persist step (SPEC §9.1).
 *
 * Nothing reaches a file until the user runs it; then each file is written once,
 * re-read, and compared against what was intended. A failure does not abort the run —
 * the file keeps its pending state and can be retried — and every write, successful or
 * not, is appended to the operation log.
 */

export interface PersistContext {
  store: FolderStore;
  timeline: Timeline;
  absPathFor: (relPath: string) => string;
  appVersion: string;
}

/** Args on every write: keep the filesystem mtime, and leave no `_original` copies. */
const WRITE_ARGS = ['-P', '-overwrite_original'];

export function planFor(ctx: PersistContext): PersistPlan {
  return buildPersistPlan(planContext(ctx));
}

function planContext(ctx: PersistContext): PlanContext {
  const persisted = ctx.store.listPersisted();
  const applied = new Map<number, AppliedState>();
  for (const [fileId, row] of persisted) {
    if (row.appliedJson === null) continue;
    try {
      applied.set(fileId, JSON.parse(row.appliedJson) as AppliedState);
    } catch {
      // A corrupt row means the plan falls back to what the file said at scan time,
      // which at worst rewrites a value that is already correct.
    }
  }
  return {
    files: ctx.store.listFiles(),
    timeline: ctx.timeline,
    applied,
    currentSig: (file) => statOf(ctx.absPathFor(file.relPath))?.sig ?? null,
    storedSig: (file) => contentSig(file.sizeBytes, file.mtime),
  };
}

function statOf(absPath: string): { sizeBytes: number; mtime: number; sig: string } | null {
  try {
    return signatureOf(fs.statSync(absPath));
  } catch {
    return null;
  }
}

/**
 * Writes the plan.
 *
 * `onProgress` is called per file so the UI can show which one is being written, as
 * SPEC §9.1 requires — on a NAS a run of a few hundred files is not instantaneous.
 */
export async function runPersist(
  ctx: PersistContext,
  request: PersistRequest,
  onProgress: (progress: PersistProgress) => void,
): Promise<PersistProgress> {
  const plan = planFor(ctx);
  const wanted = request.fileIds === undefined ? null : new Set(request.fileIds);
  const entries = plan.entries.filter((e) => wanted === null || wanted.has(e.fileId));
  const stalePolicy: StalePolicy = request.stalePolicy ?? 'skip';

  const progress: PersistProgress = {
    phase: 'writing',
    total: entries.length,
    completed: 0,
    currentPath: null,
    written: 0,
    skipped: 0,
    failed: 0,
    results: [],
    error: null,
  };
  onProgress(progress);

  const filesById = new Map(ctx.store.listFiles().map((f) => [f.id, f]));

  for (const entry of entries) {
    const file = filesById.get(entry.fileId);
    progress.currentPath = entry.relPath;
    onProgress({ ...progress });

    const result = file
      ? await writeOne(ctx, file, stalePolicy)
      : { fileId: entry.fileId, relPath: entry.relPath, ok: false, skipped: false, reason: 'The file is no longer in the index.' };

    progress.results.push(result);
    progress.completed += 1;
    if (result.skipped) progress.skipped += 1;
    else if (result.ok) progress.written += 1;
    else progress.failed += 1;
    onProgress({ ...progress });
  }

  progress.phase = 'done';
  progress.currentPath = null;
  onProgress({ ...progress });
  return progress;
}

async function writeOne(
  ctx: PersistContext,
  file: FileRecord,
  stalePolicy: StalePolicy,
): Promise<PersistFileResult> {
  const absPath = ctx.absPathFor(file.relPath);
  const base = { fileId: file.id, relPath: file.relPath };
  const line = ctx.timeline.byId.get(file.id);
  if (!line || line.effectiveMs === null) {
    return { ...base, ok: false, skipped: true, reason: 'The file has no timestamp to write.' };
  }

  // Re-checked immediately before the write, not only when the plan was built
  // (SPEC §8.3): the user may have spent minutes in the confirmation dialog.
  const stat = statOf(absPath);
  if (stat === null) {
    return recordFailure(ctx, file, 'The file is missing from disk.');
  }
  if (stat.sig !== contentSig(file.sizeBytes, file.mtime) && stalePolicy === 'skip') {
    ctx.store.appendOplog({ fileId: file.id, action: 'persist-time', ok: false, error: 'stale' });
    return { ...base, ok: false, skipped: true, reason: 'Changed on disk since it was scanned.' };
  }

  const payload: TimePayload = {
    effectiveMs: line.effectiveMs,
    utcOffsetMinutes: line.utcOffsetMinutes,
    timeShiftSeconds: Math.round(line.offsetSeconds),
  };
  const previous = ctx.store.getPersisted(file.id);
  const original: OriginalSnapshot | null =
    previous?.originalSnapshotJson === undefined || previous?.originalSnapshotJson === null
      ? snapshotOf(file)
      : null;
  const write = buildTimeWrite(file, payload, original, ctx.appVersion);

  try {
    const result = await exiftool().write(absPath, write.tags, WRITE_ARGS);

    const verified = await verify(absPath, file, write.writtenLocalIso);
    if (!verified.ok) {
      return recordFailure(ctx, file, verified.reason ?? 'The file did not read back with the value written.');
    }

    const after = statOf(absPath);
    ctx.store.transact(() => {
      if (after) ctx.store.updateFileSignature(file.id, after.sizeBytes, after.mtime);
      ctx.store.recordPersisted({
        fileId: file.id,
        persistedAt: Date.now(),
        wroteGps: false,
        wroteTime: true,
        originalSnapshotJson: original === null ? null : JSON.stringify(original),
        appliedJson: JSON.stringify({
          localIso: write.writtenLocalIso,
          utcOffsetMinutes: write.wroteUtcOffset ? payload.utcOffsetMinutes : null,
          timeShiftSeconds: payload.timeShiftSeconds,
        } satisfies AppliedState),
        exiftoolResult: JSON.stringify({ updated: result.updated, warnings: result.warnings ?? [] }),
      });
      ctx.store.appendOplog({
        fileId: file.id,
        action: 'persist-time',
        before: { localIso: file.captureTimeRaw, utcOffsetMinutes: file.captureUtcOffsetMinutes },
        after: { localIso: write.writtenLocalIso, utcOffsetMinutes: payload.utcOffsetMinutes },
      });
    });

    return { ...base, ok: true, skipped: false, reason: null };
  } catch (err) {
    return recordFailure(ctx, file, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Reads the file back and compares it with what was written (SPEC §9.1).
 *
 * Reading the file again rather than trusting ExifTool's exit status is the point:
 * a container that silently refuses a tag, or a filesystem that dropped the write,
 * both report success.
 */
async function verify(
  absPath: string,
  file: FileRecord,
  expectedLocalIso: string,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const tags = await readRawTags(absPath, file.kind);
    const candidates = collectDateCandidates(tags);
    const written =
      file.kind === 'video'
        ? candidates['quicktime:CreateDate']?.localIso
        : candidates['exif:DateTimeOriginal']?.localIso;
    if (written === undefined) {
      return { ok: false, reason: 'No timestamp could be read back after writing.' };
    }
    const normalised = fromExifDate(written) ?? written;
    if (normalised !== expectedLocalIso) {
      return { ok: false, reason: `Read back ${normalised}, expected ${expectedLocalIso}.` };
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function recordFailure(ctx: PersistContext, file: FileRecord, reason: string): PersistFileResult {
  ctx.store.appendOplog({ fileId: file.id, action: 'persist-time', ok: false, error: reason });
  return { fileId: file.id, relPath: file.relPath, ok: false, skipped: false, reason };
}

function snapshotOf(file: FileRecord): OriginalSnapshot {
  return {
    dateTimeOriginal: file.captureTimeRaw,
    offsetTimeOriginal:
      file.captureUtcOffsetMinutes === null ? null : formatOffsetTag(file.captureUtcOffsetMinutes),
    gpsPresent: file.origGpsPresent,
    gpsLatitude: file.origLat,
    gpsLongitude: file.origLon,
  };
}

function formatOffsetTag(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Undoes GeoTagger's time changes to one file (SPEC §9.4).
 *
 * Timestamps revert independently of positions, and the originals come from the edit
 * store, which is the copy that survives the file being rewritten by anything else.
 */
export async function revertTime(ctx: PersistContext, file: FileRecord): Promise<PersistFileResult> {
  const base = { fileId: file.id, relPath: file.relPath };
  const row = ctx.store.getPersisted(file.id);
  if (!row || !row.wroteTime || row.originalSnapshotJson === null) {
    return { ...base, ok: false, skipped: true, reason: 'GeoTagger has not written a time to this file.' };
  }

  let original: OriginalSnapshot;
  try {
    original = JSON.parse(row.originalSnapshotJson) as OriginalSnapshot;
  } catch {
    return { ...base, ok: false, skipped: false, reason: 'The stored original could not be read.' };
  }

  const revert = buildTimeRevert(file, original);
  try {
    await exiftool().write(ctx.absPathFor(file.relPath), revert.tags, WRITE_ARGS);
    const after = statOf(ctx.absPathFor(file.relPath));
    ctx.store.transact(() => {
      if (after) ctx.store.updateFileSignature(file.id, after.sizeBytes, after.mtime);
      ctx.store.clearPersisted(file.id);
      ctx.store.appendOplog({
        fileId: file.id,
        action: 'revert-time',
        before: { localIso: localIsoForFile(file.kind, currentPayload(ctx, file)) },
        after: { localIso: revert.restoredLocalIso },
      });
    });
    return { ...base, ok: true, skipped: false, reason: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.store.appendOplog({ fileId: file.id, action: 'revert-time', ok: false, error: reason });
    return { ...base, ok: false, skipped: false, reason };
  }
}

function currentPayload(ctx: PersistContext, file: FileRecord): TimePayload {
  const line = ctx.timeline.byId.get(file.id);
  return {
    effectiveMs: line?.effectiveMs ?? 0,
    utcOffsetMinutes: line?.utcOffsetMinutes ?? 0,
    timeShiftSeconds: Math.round(line?.offsetSeconds ?? 0),
  };
}
