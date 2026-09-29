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
  ORIGINAL_ABSENT,
  buildModifiedStamp,
  buildPositionWrite,
  buildTimeWrite,
  fromExifDate,
  preservedTagsFor,
  type AppliedState,
  type OriginalSnapshot,
  type OriginalTagValues,
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
 * Time and position are two independent halves (SPEC §9.3): the plan decides which of
 * them a file needs written, and this module turns that into tags, merging both halves
 * into the single ExifTool call §9.1 requires per file. A half's first write also stamps
 * its `geotagger:Original*` tags, which no later write touches again.
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
    if (row.appliedJson !== null) {
      try {
        applied.set(fileId, JSON.parse(row.appliedJson) as AppliedState);
      } catch {
        // A corrupt row means the plan falls back to what the file said at scan time,
        // which at worst rewrites a value that is already correct.
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
    confirmedPositions,
    persistedHalves,
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
  // currently says — nothing has touched it yet, so both halves' tags are read here even
  // if only one of them is being written. A later write reuses the stored snapshot: it
  // must never be replaced by what GeoTagger itself put there since.
  const original: OriginalSnapshot =
    previous?.originalSnapshotJson !== undefined && previous.originalSnapshotJson !== null
      ? (JSON.parse(previous.originalSnapshotJson) as OriginalSnapshot)
      : snapshotOf(file, await readPreservedTags(absPath, file.kind));

  const line = ctx.timeline.byId.get(file.id);
  const timeActive = entry.timeKind !== 'none' || entry.writesUtcOffset;
  const positionActive = entry.positionKind !== 'none';
  if (!timeActive && !positionActive) {
    return { ...base, ok: false, skipped: true, reason: 'Nothing to write.' };
  }
  if (timeActive && (!line || line.effectiveMs === null)) {
    return { ...base, ok: false, skipped: true, reason: 'The file has no timestamp to write.' };
  }

  const tags: Record<string, string | number | null> = {};
  let writtenLocalIso: string | null = null;
  let writtenLat: number | null = null;
  let writtenLon: number | null = null;
  let timeWasWritten = false;
  let positionWasWritten = false;

  if (timeActive && line && line.effectiveMs !== null) {
    const resolved: ResolvedTimeWrite = {
      localIso: entry.newLocalIso as string,
      utcOffsetMinutes: line.utcOffsetMinutes,
      writesUtcOffset: entry.writesUtcOffset,
      timeShiftSeconds: entry.timeShiftSeconds,
    };
    const w = buildTimeWrite(file, resolved, entry.stampsOriginalTime ? original.tags : null);
    Object.assign(tags, w.tags);
    writtenLocalIso = w.writtenLocalIso;
    timeWasWritten = true;
  }

  if (positionActive && entry.newLat !== null && entry.newLon !== null) {
    const payload: PositionPayload = {
      lat: entry.newLat,
      lon: entry.newLon,
      source: entry.positionSource === 'manual' ? 'manual' : 'interpolated-confirmed',
      uncertaintyM: entry.positionUncertaintyM,
    };
    const w = buildPositionWrite(file, payload, entry.stampsOriginalPosition ? original.tags : null);
    Object.assign(tags, w.tags);
    writtenLat = w.writtenLat;
    writtenLon = w.writtenLon;
    positionWasWritten = true;
  }

  // The shared stamp belongs to neither half (SPEC §9.3), so it is refreshed whichever
  // of them this write touched, and left alone on the half it did not.
  Object.assign(tags, buildModifiedStamp(ctx.appVersion));

  try {
    const result = await exiftool().write(absPath, tags, WRITE_ARGS);

    const verified = await verify(absPath, file, writtenLocalIso, writtenLat, writtenLon);
    if (!verified.ok) {
      return recordFailure(ctx, file, verified.reason ?? 'The file did not read back with the value written.');
    }

    const after = statOf(absPath);
    ctx.store.transact(() => {
      if (after) ctx.store.updateFileSignature(file.id, after.sizeBytes, after.mtime);

      // `recordPersisted` ORs the half flags into whatever the row already says, so a
      // write of one half never forgets that the other was persisted earlier — and the
      // stored snapshot is kept, never replaced by values GeoTagger itself wrote.
      ctx.store.recordPersisted({
        fileId: file.id,
        persistedAt: Date.now(),
        wroteGps: positionWasWritten,
        wroteTime: timeWasWritten,
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

      ctx.store.appendOplog({
        fileId: file.id,
        action: 'persist',
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

/**
 * What the file says right now, kept as its pre-GeoTagger record (SPEC §9.3).
 *
 * The four summary values come from the index — they are what the app planned against,
 * and a capture time can be resolved from a tag GeoTagger never writes (SPEC §4.1) —
 * while `tags` holds the literal tags, read from the file itself a moment before the
 * write, one per `Original*` stamped into it. Both describe the same untouched file: a
 * file that changed since it was scanned is refused above (SPEC §8.3) rather than
 * snapshotted.
 */
function snapshotOf(file: FileRecord, tags: OriginalTagValues): OriginalSnapshot {
  return {
    dateTimeOriginal: file.captureTimeRaw,
    offsetTimeOriginal:
      file.captureUtcOffsetMinutes === null ? null : formatOffsetTag(file.captureUtcOffsetMinutes),
    gpsLatitude: file.origGpsPresent ? file.origLat : null,
    gpsLongitude: file.origGpsPresent ? file.origLon : null,
    tags,
  };
}

/**
 * Reads the tags a write would overwrite, exactly as the file holds them.
 *
 * `-n` turns off ExifTool's print conversion, so coordinates come back as the signed
 * decimals and bare `N`/`E` refs that can be handed straight back to it — the whole
 * point being that the record holds the same characters the file had. Unlike the scan
 * (SPEC §10.1) this read cannot use `-fast2`: XMP can sit outside the header GeoTagger's
 * scan stops at, and a tag missed here would be recorded as absent when it was not. It
 * runs once per file, on the first write of either half.
 */
async function readPreservedTags(absPath: string, kind: FileRecord['kind']): Promise<OriginalTagValues> {
  const preserved = preservedTagsFor(kind);
  const raw = await exiftool().readRaw(absPath, [
    '-G0',
    '-n',
    '-charset',
    'filename=utf8',
    ...preserved.map((p) => `-${p.tag}`),
  ]);

  const values: OriginalTagValues = {};
  for (const { tag } of preserved) values[tag] = tagValueOf((raw as Record<string, unknown>)[tag]);
  return values;
}

/** One tag as the characters ExifTool would write back, or null when it is absent. */
function tagValueOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A date-shaped value comes back parsed; `rawValue` is what was in the file.
  const raw = typeof value === 'object' ? (value as { rawValue?: unknown }).rawValue : value;
  const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : String(value);
  // `n/a` is the sentinel for "there was no such tag", so a tag that literally says that
  // counts as absent — better than preserving a value the sentinel cannot express.
  return text === '' || text === ORIGINAL_ABSENT ? null : text;
}

function formatOffsetTag(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
