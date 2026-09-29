import type {
  FileRecord,
  PersistHalfKind,
  PersistPlan,
  PersistPlanEntry,
  PositionSource,
  TimelineFile,
} from '@geotagger/shared';
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
 *
 * Time and position resolve independently (SPEC §9.3): each half is either left alone
 * or written, and the first write of a half is the one that also stamps its preserved
 * originals — which nothing ever writes again.
 */

export interface ConfirmedPositionEdit {
  lat: number;
  lon: number;
  positionSource: string | null;
  uncertaintyM: number | null;
}

export interface PlanContext {
  files: readonly FileRecord[];
  timeline: Timeline;
  /** What GeoTagger last wrote to each file, keyed by file id. */
  applied: ReadonlyMap<number, AppliedState>;
  /** Confirmed positions, keyed by file id (SPEC §5.5) — the only positions ever persisted. */
  confirmedPositions: ReadonlyMap<number, ConfirmedPositionEdit>;
  /** Which halves have been persisted before, keyed by file id — SPEC §9.3's "first write" test. */
  persistedHalves: ReadonlyMap<number, { wroteTime: boolean; wroteGps: boolean }>;
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
    if (entry.timeKind === 'write') correctedTimestamps += 1;
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

  const applied = ctx.applied.get(file.id) ?? null;
  const persistedHalves = ctx.persistedHalves.get(file.id);

  const time = resolveTime(file, line, applied);
  const position = resolvePosition(file, ctx, applied);

  if (time.kind === 'none' && !time.writesUtcOffset && position.kind === 'none') return null;

  const currentSig = ctx.currentSig(file);
  return {
    fileId: file.id,
    relPath: file.relPath,
    oldLocalIso: time.oldLocalIso,
    oldUtcOffsetMinutes: time.oldUtcOffsetMinutes,
    newLocalIso: time.localIso,
    timeShiftSeconds: time.timeShiftSeconds,
    utcOffsetMinutes: time.writesUtcOffset ? time.utcOffsetMinutes : null,
    timeKind: time.kind,
    writesUtcOffset: time.writesUtcOffset,
    // The time half's first write is its first write whether it corrects the date or
    // only adds the offset §4.2 asks for: both are GeoTagger writing to the half, and
    // the preserved original has to be stamped before either of them lands.
    stampsOriginalTime: (time.kind === 'write' || time.writesUtcOffset) && !(persistedHalves?.wroteTime ?? false),
    oldLat: position.oldLat,
    oldLon: position.oldLon,
    newLat: position.lat,
    newLon: position.lon,
    positionSource: position.kind === 'none' ? null : position.source,
    positionUncertaintyM: position.uncertaintyM,
    positionKind: position.kind,
    stampsOriginalPosition: position.kind === 'write' && !(persistedHalves?.wroteGps ?? false),
    // A file that has gone missing counts as changed underneath the app, so the write
    // stops and asks rather than recreating it (SPEC §8.3).
    stale: currentSig === null || currentSig !== ctx.storedSig(file),
  };
}

interface TimeResolution {
  kind: PersistHalfKind;
  oldLocalIso: string | null;
  oldUtcOffsetMinutes: number | null;
  localIso: string | null;
  utcOffsetMinutes: number;
  timeShiftSeconds: number;
  writesUtcOffset: boolean;
}

function resolveTime(file: FileRecord, line: TimelineFile, applied: AppliedState | null): TimeResolution {
  const payload: TimePayload = {
    effectiveMs: line.effectiveMs as number,
    utcOffsetMinutes: line.utcOffsetMinutes,
    timeShiftSeconds: Math.round(line.offsetSeconds),
  };
  const derivedLocalIso = localIsoForFile(file.kind, payload);
  const currentLocalIso = applied?.localIso ?? file.captureTimeRaw;
  // An offset nothing established is a guess, and writing it would stamp UTC onto a
  // photo as though it were known. The file keeps its ambiguous local time instead,
  // which is what it already had — the UI asks for the offset rather than assuming one
  // (SPEC §4.2).
  const eligibleForOffset = writesUtcOffsetTag(file.kind) && line.utcOffsetSource !== 'assumed';
  const currentUtcOffsetMinutes = applied?.utcOffsetMinutes ?? file.captureUtcOffsetMinutes;

  // The date and the offset are independent concerns: a file can need only the offset
  // added (its wall clock is already right) or only the date corrected. `kind` tracks
  // the date alone, matching what `newLocalIso` means; `writesUtcOffset` is orthogonal.
  const timeChanges = derivedLocalIso !== currentLocalIso;
  const writesUtcOffset = eligibleForOffset && payload.utcOffsetMinutes !== currentUtcOffsetMinutes;

  return {
    kind: timeChanges ? 'write' : 'none',
    oldLocalIso: currentLocalIso,
    oldUtcOffsetMinutes: currentUtcOffsetMinutes,
    localIso: derivedLocalIso,
    utcOffsetMinutes: payload.utcOffsetMinutes,
    timeShiftSeconds: payload.timeShiftSeconds,
    writesUtcOffset,
  };
}

interface PositionResolution {
  kind: PersistHalfKind;
  oldLat: number | null;
  oldLon: number | null;
  lat: number | null;
  lon: number | null;
  source: PositionSource | null;
  uncertaintyM: number | null;
}

function nonePosition(oldLat: number | null, oldLon: number | null): PositionResolution {
  return { kind: 'none', oldLat, oldLon, lat: null, lon: null, source: null, uncertaintyM: null };
}

function resolvePosition(file: FileRecord, ctx: PlanContext, applied: AppliedState | null): PositionResolution {
  const confirmed = ctx.confirmedPositions.get(file.id);
  const currentLat = applied?.lat ?? (file.origGpsPresent ? file.origLat : null);
  const currentLon = applied?.lon ?? (file.origGpsPresent ? file.origLon : null);

  // Camera GPS, an unconfirmed estimate, or nothing at all — none of these are ever
  // persisted (SPEC §6.5's "eligible for persist" is confirmed-only).
  if (!confirmed) return nonePosition(currentLat, currentLon);

  const matchesCurrent = confirmed.lat === currentLat && confirmed.lon === currentLon;
  return {
    kind: matchesCurrent ? 'none' : 'write',
    oldLat: currentLat,
    oldLon: currentLon,
    lat: confirmed.lat,
    lon: confirmed.lon,
    source: matchesCurrent ? null : confirmed.positionSource === 'drag' ? 'manual' : 'confirmed',
    uncertaintyM: confirmed.uncertaintyM,
  };
}
