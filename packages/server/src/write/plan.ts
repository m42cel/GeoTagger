import type { FileRecord, PersistPlan, PersistPlanEntry } from '@geotagger/shared';
import type { Timeline } from '../time/timeline.js';
import { localIsoForFile, writesUtcOffsetTag, type AppliedState, type TimePayload } from './tags.js';

/**
 * What a persist run would do (SPEC §9.1).
 *
 * The plan is built from the difference between what a file says *now* and what the
 * alignment view says it should say — where "now" is the last thing GeoTagger wrote to
 * it, if it has written to it before. So re-persisting after a further nudge writes
 * only the difference, and persisting twice with nothing changed in between writes
 * nothing at all.
 */

export interface PlanContext {
  files: readonly FileRecord[];
  timeline: Timeline;
  /** What GeoTagger last wrote to each file, keyed by file id. */
  applied: ReadonlyMap<number, AppliedState>;
  /** Current size and mtime on disk, or null when the file has gone. */
  currentSig: (file: FileRecord) => string | null;
  /** The signature recorded at scan time. */
  storedSig: (file: FileRecord) => string;
}

export function buildPersistPlan(ctx: PlanContext): PersistPlan {
  const entries: PersistPlanEntry[] = [];
  let correctedTimestamps = 0;
  let utcOffsetsAdded = 0;
  let staleCount = 0;

  for (const file of ctx.files) {
    const entry = planEntryFor(file, ctx);
    if (entry === null) continue;
    entries.push(entry);
    if (entry.writesTime) correctedTimestamps += 1;
    // "Added" counts the files that had no offset of their own — the ones for which
    // writing it turns an ambiguous local time into an instant (SPEC §4.2).
    if (entry.writesUtcOffset && file.captureUtcOffsetMinutes === null) utcOffsetsAdded += 1;
    if (entry.stale) staleCount += 1;
  }

  return { entries, correctedTimestamps, utcOffsetsAdded, staleCount };
}

export function planEntryFor(file: FileRecord, ctx: PlanContext): PersistPlanEntry | null {
  const line = ctx.timeline.byId.get(file.id);
  if (!line || line.effectiveMs === null || line.rawCaptureMs === null) return null;

  const payload: TimePayload = {
    effectiveMs: line.effectiveMs,
    utcOffsetMinutes: line.utcOffsetMinutes,
    timeShiftSeconds: Math.round(line.offsetSeconds),
  };
  const intendedLocalIso = localIsoForFile(file.kind, payload);
  const applied = ctx.applied.get(file.id) ?? null;

  const currentLocalIso = applied?.localIso ?? file.captureTimeRaw;
  const currentUtcOffset = applied?.utcOffsetMinutes ?? file.captureUtcOffsetMinutes;

  const writesTime = intendedLocalIso !== currentLocalIso;
  // An offset nothing established is a guess, and writing it would stamp UTC onto a
  // photo as though it were known. The file keeps its ambiguous local time instead,
  // which is what it already had — the UI asks for the offset rather than assuming one
  // (SPEC §4.2).
  const writesUtcOffset =
    writesUtcOffsetTag(file.kind) &&
    line.utcOffsetSource !== 'assumed' &&
    payload.utcOffsetMinutes !== currentUtcOffset;
  if (!writesTime && !writesUtcOffset) return null;

  const currentSig = ctx.currentSig(file);
  return {
    fileId: file.id,
    relPath: file.relPath,
    newLocalIso: intendedLocalIso,
    timeShiftSeconds: payload.timeShiftSeconds,
    utcOffsetMinutes: writesUtcOffset ? payload.utcOffsetMinutes : null,
    writesTime,
    writesUtcOffset,
    // A file that has gone missing counts as changed underneath the app, so the write
    // stops and asks rather than recreating it (SPEC §8.3).
    stale: currentSig === null || currentSig !== ctx.storedSig(file),
  };
}
