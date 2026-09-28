import fs from 'node:fs';
import type {
  FileRecord,
  PersistFileResult,
  PersistPlan,
  PersistPlanEntry,
  PersistProgress,
  PersistRequest,
  StalePolicy,
} from '@geotagger/shared';
import { contentSig, signatureOf, type FolderStore } from '../db/store.js';
import { exiftool, readRawTags } from '../metadata/reader.js';
import { collectDateCandidates, collectGps } from '../metadata/exif-parse.js';
import type { Timeline } from '../time/timeline.js';
import { buildPersistPlan, type ConfirmedPositionEdit, type PlanContext } from './plan.js';
import {
  buildModifiedStamp,
  buildPositionRestore,
  buildPositionWrite,
  buildTimeRestore,
  buildTimeWrite,
  clearModifiedStamp,
  fromExifDate,
  type AppliedState,
  type OriginalSnapshot,
  type PositionPayload,
  type ResolvedTimeWrite,
} from './tags.js';

/**
 * The persist step (SPEC §9.1).
 *
 * Nothing reaches a file until the user runs it; then each file is written once,
 * re-read, and compared against what was intended. A failure does not abort the run —
 * the file keeps its pending state and can be retried — and every write, successful or
 * not, is appended to the operation log.
 *
 * Time and position are two independent halves (SPEC §9.3, §9.4): each resolves to a
 * `write` or a `restore` in the plan, and this module turns that resolution into tags,
 * merging both halves into the single ExifTool call §9.1 requires per file.
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
  const originals = new Map<number, OriginalSnapshot>();
  for (const [fileId, row] of persisted) {
    if (row.appliedJson !== null) {
      try {
        applied.set(fileId, JSON.parse(row.appliedJson) as AppliedState);
      } catch {
        // A corrupt row means the plan falls back to what the file said at scan time,
        // which at worst rewrites a value that is already correct.
      }
    }
    if (row.originalSnapshotJson !== null) {
      try {
        originals.set(fileId, JSON.parse(row.originalSnapshotJson) as OriginalSnapshot);
      } catch {
        // Nothing to restore to if the stored snapshot can't be read.
      }
    }
  }

  const confirmedPositions = new Map<number, ConfirmedPositionEdit>();
  for (const [fileId, edit] of ctx.store.listConfirmedPositionEdits()) confirmedPositions.set(fileId, edit);

  const persistedHalves = new Map<number, { wroteTime: boolean; wroteGps: boolean }>();
  for (const [fileId, row] of persisted) persistedHalves.set(fileId, { wroteTime: row.wroteTime, wroteGps: row.wroteGps });

  return {
    files: ctx.store.listFiles(),
    timeline: ctx.timeline,
    applied,
    originals,
    confirmedPositions,
    persistedHalves,
    positionResetToOriginalFileIds: ctx.store.resetToOriginalPendingFileIds(),
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
      ? await writeOne(ctx, file, entry, stalePolicy)
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
  entry: PersistPlanEntry,
  stalePolicy: StalePolicy,
): Promise<PersistFileResult> {
  const absPath = ctx.absPathFor(file.relPath);
  const base = { fileId: file.id, relPath: file.relPath };

  // Re-checked immediately before the write, not only when the plan was built
  // (SPEC §8.3): the user may have spent minutes in the confirmation dialog.
  const stat = statOf(absPath);
  if (stat === null) {
    return recordFailure(ctx, file, 'The file is missing from disk.');
  }
  if (stat.sig !== contentSig(file.sizeBytes, file.mtime) && stalePolicy === 'skip') {
    ctx.store.appendOplog({ fileId: file.id, action: 'persist', ok: false, error: 'stale' });
    return { ...base, ok: false, skipped: true, reason: 'Changed on disk since it was scanned.' };
  }

  const previous = ctx.store.getPersisted(file.id);
  // The first time either half is ever persisted, the original is whatever the file
  // currently says — nothing has touched it yet. A later write reuses the stored one:
  // it must never be replaced by what GeoTagger itself put there since.
  const original: OriginalSnapshot =
    previous?.originalSnapshotJson !== undefined && previous.originalSnapshotJson !== null
      ? (JSON.parse(previous.originalSnapshotJson) as OriginalSnapshot)
      : snapshotOf(file);

  const line = ctx.timeline.byId.get(file.id);
  const timeActive = entry.timeKind !== 'none' || entry.writesUtcOffset;
  const positionActive = entry.positionKind !== 'none';
  if (!timeActive && !positionActive) {
    return { ...base, ok: false, skipped: true, reason: 'Nothing to write.' };
  }
  // An ordinary time write needs the timeline's own values (the offset in particular);
  // a restore does not, since it comes from the stored original instead.
  if (timeActive && entry.timeKind !== 'restore' && (!line || line.effectiveMs === null)) {
    return { ...base, ok: false, skipped: true, reason: 'The file has no timestamp to write.' };
  }

  const tags: Record<string, string | number | null> = {};
  let writtenLocalIso: string | null = null;
  let writtenLat: number | null = null;
  let writtenLon: number | null = null;
  let wroteTimeNow = previous?.wroteTime ?? false;
  let wroteGpsNow = previous?.wroteGps ?? false;
  let timeWasWritten = false;
  let positionWasWritten = false;

  if (entry.timeKind === 'restore') {
    const r = buildTimeRestore(file, original);
    Object.assign(tags, r.tags);
    writtenLocalIso = r.restoredLocalIso;
    wroteTimeNow = false;
  } else if (timeActive && line && line.effectiveMs !== null) {
    const resolved: ResolvedTimeWrite = {
      localIso: entry.newLocalIso as string,
      utcOffsetMinutes: line.utcOffsetMinutes,
      timeShiftSeconds: entry.timeShiftSeconds,
    };
    const stampOriginal = entry.stampsOriginalTime
      ? { dateTimeOriginal: original.dateTimeOriginal, offsetTimeOriginal: original.offsetTimeOriginal }
      : null;
    const w = buildTimeWrite(file, resolved, stampOriginal);
    Object.assign(tags, w.tags);
    writtenLocalIso = w.writtenLocalIso;
    wroteTimeNow = true;
    timeWasWritten = true;
  }

  if (entry.positionKind === 'restore') {
    const r = buildPositionRestore(file, original);
    Object.assign(tags, r.tags);
    writtenLat = r.restoredLat;
    writtenLon = r.restoredLon;
    wroteGpsNow = false;
  } else if (positionActive && entry.newLat !== null && entry.newLon !== null) {
    const payload: PositionPayload = {
      lat: entry.newLat,
      lon: entry.newLon,
      source: entry.positionSource === 'manual' ? 'manual' : 'interpolated-confirmed',
      uncertaintyM: entry.positionUncertaintyM,
    };
    const stampOriginal = entry.stampsOriginalPosition
      ? { gpsPresent: original.gpsPresent, gpsLatitude: original.gpsLatitude, gpsLongitude: original.gpsLongitude }
      : null;
    const w = buildPositionWrite(file, payload, stampOriginal);
    Object.assign(tags, w.tags);
    writtenLat = w.writtenLat;
    writtenLon = w.writtenLon;
    wroteGpsNow = true;
    positionWasWritten = true;
  }

  // The shared stamp belongs to neither half (SPEC §9.3): refreshed on any fresh
  // write, removed once neither half remains, left alone when an untouched half from
  // an earlier persist is still active.
  if (timeWasWritten || positionWasWritten) {
    Object.assign(tags, buildModifiedStamp(ctx.appVersion));
  } else if (!wroteTimeNow && !wroteGpsNow) {
    Object.assign(tags, clearModifiedStamp());
  }

  try {
    const result = await exiftool().write(absPath, tags, WRITE_ARGS);

    const verified = await verify(absPath, file, writtenLocalIso, writtenLat, writtenLon);
    if (!verified.ok) {
      return recordFailure(ctx, file, verified.reason ?? 'The file did not read back with the value written.');
    }

    const after = statOf(absPath);
    ctx.store.transact(() => {
      if (after) ctx.store.updateFileSignature(file.id, after.sizeBytes, after.mtime);

      if (!wroteTimeNow && !wroteGpsNow) {
        ctx.store.clearPersistedTime(file.id);
        ctx.store.clearPersistedGps(file.id);
      } else {
        if (!wroteTimeNow && previous?.wroteTime) ctx.store.clearPersistedTime(file.id);
        if (!wroteGpsNow && previous?.wroteGps) ctx.store.clearPersistedGps(file.id);
        if (wroteTimeNow || wroteGpsNow) {
          ctx.store.recordPersisted({
            fileId: file.id,
            persistedAt: Date.now(),
            wroteGps: wroteGpsNow,
            wroteTime: wroteTimeNow,
            originalSnapshotJson: JSON.stringify(original),
            appliedJson: JSON.stringify({
              localIso: writtenLocalIso,
              utcOffsetMinutes: line?.utcOffsetMinutes ?? null,
              timeShiftSeconds: entry.timeShiftSeconds,
              lat: writtenLat,
              lon: writtenLon,
              positionSource: positionWasWritten ? (entry.positionSource === 'manual' ? 'manual' : 'interpolated-confirmed') : null,
              positionUncertaintyM: positionWasWritten ? entry.positionUncertaintyM : null,
            } satisfies AppliedState),
            exiftoolResult: JSON.stringify({ updated: result.updated, warnings: result.warnings ?? [] }),
          });
        }
      }

      ctx.store.appendOplog({
        fileId: file.id,
        action: timeWasWritten || positionWasWritten ? 'persist' : 'reset-to-original',
        before: { localIso: file.captureTimeRaw, lat: file.origLat, lon: file.origLon },
        after: { localIso: writtenLocalIso, lat: writtenLat, lon: writtenLon },
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
  expectedLocalIso: string | null,
  expectedLat: number | null,
  expectedLon: number | null,
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const tags = await readRawTags(absPath, file.kind);

    if (expectedLocalIso !== null) {
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
    }

    if (expectedLat !== null && expectedLon !== null) {
      const gps = collectGps(tags);
      if (gps === null) {
        return { ok: false, reason: 'No position could be read back after writing.' };
      }
      if (Math.abs(gps.lat - expectedLat) > 0.0001 || Math.abs(gps.lon - expectedLon) > 0.0001) {
        return { ok: false, reason: `Read back ${gps.lat}, ${gps.lon}, expected ${expectedLat}, ${expectedLon}.` };
      }
    }

    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function recordFailure(ctx: PersistContext, file: FileRecord, reason: string): PersistFileResult {
  ctx.store.appendOplog({ fileId: file.id, action: 'persist', ok: false, error: reason });
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
