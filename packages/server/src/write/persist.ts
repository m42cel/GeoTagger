import fs from 'node:fs';
import type {
  FileRecord,
  PersistFileResult,
  PersistTagChange,
  PersistPlan,
  PersistPlanEntry,
  PersistProgress,
  PersistRequest,
  StalePolicy,
} from '@geotagger/shared';
import { contentSig, signatureOf, type FolderStore, type PersistedRow } from '../db/store.js';
import { exiftool, readRawTags } from '../metadata/reader.js';
import { collectDateCandidates, collectGps } from '../metadata/exif-parse.js';
import type { Timeline } from '../time/timeline.js';
import { GEOTAGGER_GROUP } from './exiftool-config.js';
import { buildPersistPlan, type ConfirmedPositionEdit, type PlanContext } from './plan.js';
import {
  ORIGINAL_ABSENT,
  buildWrite,
  fromExifDate,
  preservedTagsFor,
  type OriginalSnapshot,
  type OriginalTagValues,
  type Provenance,
} from './tags.js';

/**
 * The persist step (SPEC §9.1).
 *
 * Nothing reaches a file until the user runs it; then each file is written once,
 * re-read, and compared against what was intended. A failure does not abort the run —
 * the file keeps its pending state and can be retried — and every write, successful or
 * not, is appended to the operation log.
 *
 * The plan has already decided this file's write tag by tag, so the work here is to read
 * the file's own values first when anything is being preserved for the first time, hand
 * ExifTool one command, verify, and record what was written so the next plan can diff
 * against it.
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
  const written = new Map<number, OriginalTagValues>();
  for (const [fileId, row] of ctx.store.listPersisted()) {
    const values = writtenTagsOf(row);
    if (values !== null) written.set(fileId, values);
  }

  const confirmedPositions = new Map<number, ConfirmedPositionEdit>();
  for (const [fileId, edit] of ctx.store.listConfirmedPositionEdits()) confirmedPositions.set(fileId, edit);

  return {
    files: ctx.store.listFiles(),
    timeline: ctx.timeline,
    written,
    confirmedPositions,
    currentSig: (file) => statOf(ctx.absPathFor(file.relPath))?.sig ?? null,
    storedSig: (file) => contentSig(file.sizeBytes, file.mtime),
  };
}

/**
 * The tags GeoTagger has written to one file, as its row records them.
 *
 * A corrupt record means the plan falls back to what the scan read, which at worst
 * rewrites a value that is already correct.
 */
export function writtenTagsOf(row: PersistedRow): OriginalTagValues | null {
  if (row.writtenTagsJson === null) return null;
  try {
    return JSON.parse(row.writtenTagsJson) as OriginalTagValues;
  } catch {
    return null;
  }
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
  const previousWritten = previous === null ? null : writtenTagsOf(previous);

  // The plan's `stampsOriginal` is only a cheap DB-backed guess, good enough for the
  // review dialog's preview but not trusted here (SPEC §9.3's "written exactly once and
  // never touched again" is a promise about the file, not about the DB's record of it).
  // The file's own `geotagger:Original*` block is asked directly, every write: present
  // means already preserved, so this write leaves it alone no matter what the plan or a
  // stale/missing DB row believed.
  const fileState = await readFileOriginalState(absPath, file.kind);
  const changes: readonly PersistTagChange[] = entry.changes.map((change) => ({
    ...change,
    stampsOriginal: !fileState.alreadyStamped.has(change.tag),
  }));
  const originalTags: OriginalTagValues = {};
  for (const { tag } of preservedTagsFor(file.kind)) {
    originalTags[tag] = fileState.alreadyStamped.has(tag)
      ? (fileState.alreadyStamped.get(tag) ?? null)
      : (fileState.values[tag] ?? null);
  }

  // The four summary fields describe what the app itself derived at first scan, not any
  // one file tag, so they still come from the stored snapshot once one exists; `tags` is
  // always the fresh, file-verified read above.
  const original: OriginalSnapshot =
    previous?.originalSnapshotJson !== undefined && previous.originalSnapshotJson !== null
      ? { ...(JSON.parse(previous.originalSnapshotJson) as OriginalSnapshot), tags: originalTags }
      : snapshotOf(file, originalTags);

  const tags = buildWrite(file, changes, original.tags, {
    timeShiftSeconds: entry.timeShiftSeconds,
    positionSource: entry.positionSource === null ? null : entry.positionSource === 'manual' ? 'manual' : 'interpolated-confirmed',
    positionUncertaintyM: entry.positionUncertaintyM,
    appVersion: ctx.appVersion,
  } satisfies Provenance);

  // What the file will say once the write lands, for verification and for the next plan's
  // diff: the tags this write touches, merged over the ones earlier writes touched. Merged
  // per tag, so a write of one field never forgets what another field wrote.
  const writtenTags: OriginalTagValues = { ...(previousWritten ?? {}) };
  for (const change of changes) writtenTags[change.tag] = change.next;
  const expected = expectedValues(entry);

  try {
    const result = await exiftool().write(absPath, tags, WRITE_ARGS);

    const verified = await verify(absPath, file, expected);
    if (!verified.ok) {
      return recordFailure(ctx, file, verified.reason ?? 'The file did not read back with the value written.');
    }

    const after = statOf(absPath);
    ctx.store.transact(() => {
      if (after) ctx.store.updateFileSignature(file.id, after.sizeBytes, after.mtime);

      // The stored snapshot is written once and kept: a later write must never replace it
      // with values GeoTagger itself put there (SPEC §9.3).
      ctx.store.recordPersisted({
        fileId: file.id,
        persistedAt: Date.now(),
        originalSnapshotJson: JSON.stringify(original),
        writtenTagsJson: JSON.stringify(writtenTags),
        exiftoolResult: JSON.stringify({ updated: result.updated, warnings: result.warnings ?? [] }),
      });

      ctx.store.appendOplog({
        fileId: file.id,
        action: 'persist',
        before: { tags: Object.fromEntries(entry.changes.map((c) => [c.tag, c.old])) },
        after: { tags: Object.fromEntries(entry.changes.map((c) => [c.tag, c.next])) },
      });
    });

    return { ...base, ok: true, skipped: false, reason: null };
  } catch (err) {
    return recordFailure(ctx, file, err instanceof Error ? err.message : String(err));
  }
}

/** The timestamp and position the file should read back with, in the app's own units. */
interface ExpectedValues {
  localIso: string | null;
  lat: number | null;
  lon: number | null;
}

/**
 * What a successful write means for the two values the app actually reasons about.
 *
 * Taken from the plan's own per-field changes rather than reassembled from the tags: a
 * value can be spread across tags the write does not touch — a coordinate's `GPSLatitudeRef`
 * is left alone when the hemisphere does not change — so a tag map of just this write is
 * missing the sign, and expecting a positive longitude of a file that correctly wrote a
 * negative one fails a write that was perfectly good.
 *
 * Verification is also deliberately not a tag-by-tag string comparison: ExifTool
 * normalises some of what it is given (a coordinate becomes a rational, `GPSCoordinates`
 * is reformatted), so comparing characters would fail on correct writes too. The timestamp
 * and the position are read back through the same parser the scan uses, which is the
 * reading everything downstream depends on anyway.
 */
function expectedValues(entry: PersistPlanEntry): ExpectedValues {
  const expected: ExpectedValues = { localIso: null, lat: null, lon: null };
  for (const field of entry.fields) {
    if (field.field === 'timestamp') expected.localIso = field.newLocalIso;
    if (field.field === 'position') {
      expected.lat = field.newLat;
      expected.lon = field.newLon;
    }
  }
  return expected;
}

/**
 * Reads the file back and compares it with what was written (SPEC §9.1).
 *
 * Reading the file again rather than trusting ExifTool's exit status is the point:
 * a container that silently refuses a tag, or a filesystem that dropped the write,
 * both report success.
 */
async function verify(absPath: string, file: FileRecord, expected: ExpectedValues): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const tags = await readRawTags(absPath, file.kind);

    if (expected.localIso !== null) {
      const candidates = collectDateCandidates(tags);
      const written =
        file.kind === 'video'
          ? candidates['quicktime:CreateDate']?.localIso
          : candidates['exif:DateTimeOriginal']?.localIso;
      if (written === undefined) {
        return { ok: false, reason: 'No timestamp could be read back after writing.' };
      }
      const normalised = fromExifDate(written) ?? written;
      if (normalised !== expected.localIso) {
        return { ok: false, reason: `Read back ${normalised}, expected ${expected.localIso}.` };
      }
    }

    if (expected.lat !== null && expected.lon !== null) {
      const gps = collectGps(tags);
      if (gps === null) {
        return { ok: false, reason: 'No position could be read back after writing.' };
      }
      if (Math.abs(gps.lat - expected.lat) > 0.0001 || Math.abs(gps.lon - expected.lon) > 0.0001) {
        return { ok: false, reason: `Read back ${gps.lat}, ${gps.lon}, expected ${expected.lat}, ${expected.lon}.` };
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

/** What a live read of the file says about the tags GeoTagger preserves (SPEC §9.3). */
interface FileOriginalState {
  /** Each tag's current value, exactly as the file holds it. */
  values: OriginalTagValues;
  /**
   * The tags whose `geotagger:Original*` is already in the file, mapped to that
   * companion's own recorded value — `null` when it records an absence, never omitted
   * for a tag that is genuinely present.
   */
  alreadyStamped: Map<string, string | null>;
}

/**
 * Reads a tag's current value and its `geotagger:Original*` companion together, exactly
 * as the file holds them.
 *
 * The companion's presence, not any DB record, is what decides whether this write may
 * stamp a tag (SPEC §9.3's "written exactly once and never touched again" is a promise
 * about the file). `-n` turns off ExifTool's print conversion, so coordinates come back
 * as the signed decimals and bare `N`/`E` refs that can be handed straight back to it —
 * the whole point being that the record holds the same characters the file had. Unlike
 * the scan (SPEC §10.1) this read cannot use `-fast2`: XMP can sit outside the header
 * GeoTagger's scan stops at, and a tag missed here would be recorded as absent when it
 * was not. It runs on every write, not only the first, because a write that skips it has
 * nothing but the DB's word for whether a tag was ever stamped.
 */
async function readFileOriginalState(absPath: string, kind: FileRecord['kind']): Promise<FileOriginalState> {
  const preserved = preservedTagsFor(kind);
  const charsetArgs = ['-n', '-charset', 'filename=utf8'];

  // Two reads, not one: `geotagger` is a family-1 group, so its tags have to be read
  // under `-G1` to come back keyed by that group rather than by the family-0 group
  // (`XMP`) the config also declares — the same reason the roundtrip tests read them
  // back with `-G1` rather than the `-G0` the tags themselves are read with below.
  const [raw, rawOriginals] = await Promise.all([
    exiftool().readRaw(absPath, ['-G0', ...charsetArgs, ...preserved.map((p) => `-${p.tag}`)]) as Promise<
      Record<string, unknown>
    >,
    exiftool().readRaw(absPath, [
      '-G1',
      ...charsetArgs,
      ...preserved.map((p) => `-${GEOTAGGER_GROUP}:${p.original}`),
    ]) as Promise<Record<string, unknown>>,
  ]);

  const values: OriginalTagValues = {};
  const alreadyStamped = new Map<string, string | null>();
  for (const { tag, original } of preserved) {
    values[tag] = tagValueOf(raw[tag]);
    const originalKey = `${GEOTAGGER_GROUP}:${original}`;
    if (rawOriginals[originalKey] !== undefined) alreadyStamped.set(tag, tagValueOf(rawOriginals[originalKey]));
  }
  return { values, alreadyStamped };
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
