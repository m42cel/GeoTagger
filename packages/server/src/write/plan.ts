import type {
  FileId,
  FileRecord,
  PersistFieldChange,
  PersistPlan,
  PersistPlanEntry,
  PersistTagChange,
  PositionSource,
  TimelineFile,
} from '@geotagger/shared';
import { formatUtcOffset } from '@geotagger/shared';
import { parseOffset } from '../metadata/exif-parse.js';
import type { Timeline } from '../time/timeline.js';
import {
  coordsFromTags,
  desiredTagValues,
  formatCoord,
  fromExifDate,
  instantOfNaive,
  localIsoForFile,
  preservedTagsFor,
  writesUtcOffsetTag,
  type OriginalTagValues,
  type PositionIntent,
  type TimeIntent,
} from './tags.js';

/**
 * What a persist run would do (SPEC §9.1).
 *
 * One rule, applied to every tag GeoTagger writes: if what the file says differs from what
 * it should say, the tag is written. "What the file says" is the value GeoTagger last wrote
 * to that tag, or — for a tag it has never written — what the scan read. So re-persisting
 * after a further nudge writes only the tags that moved, and persisting twice with nothing
 * changed in between writes nothing at all.
 *
 * A tag GeoTagger has never written also gets its prior value preserved as
 * `geotagger:Original<tag>` on the way past (SPEC §9.3).
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
  /**
   * What GeoTagger last wrote to each file, tag by tag, keyed by file id. A tag present
   * here is one it has written before, which is also §9.3's "already preserved" test.
   */
  written: ReadonlyMap<FileId, OriginalTagValues>;
  /** Confirmed positions, keyed by file id (SPEC §5.5) — the only positions ever persisted. */
  confirmedPositions: ReadonlyMap<FileId, ConfirmedPositionEdit>;
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
    if (entry.fields.some((f) => f.field === 'timestamp')) correctedTimestamps += 1;
    // "Added" counts the files that had no offset of their own — the ones for which
    // writing it turns an ambiguous local time into an instant (SPEC §4.2).
    if (entry.fields.some((f) => f.field === 'utcOffset' && f.oldMinutes === null)) utcOffsetsAdded += 1;
    if (entry.stale) staleCount += 1;
  }

  return { entries, correctedTimestamps, utcOffsetsAdded, staleCount };
}

export function planEntryFor(file: FileRecord, ctx: PlanContext): PersistPlanEntry | null {
  const line = ctx.timeline.byId.get(file.id);
  if (!line || line.effectiveMs === null || line.rawCaptureMs === null) return null;

  const preserved = preservedTagsFor(file.kind);
  const current = tagValuesOnDisk(file, ctx.written.get(file.id) ?? {});
  const confirmed = ctx.confirmedPositions.get(file.id);

  // An offset nothing established is a guess, and writing it would stamp UTC onto a photo
  // as though it were known. The file keeps the ambiguous local time it already had — the
  // UI asks for the offset rather than assuming one (SPEC §4.2).
  const time: TimeIntent = {
    effectiveMs: line.effectiveMs,
    utcOffsetMinutes: line.utcOffsetMinutes,
    writeOffset: writesUtcOffsetTag(file.kind) && line.utcOffsetSource !== 'assumed',
  };
  // Camera GPS, an unconfirmed estimate, or nothing at all are never persisted (SPEC
  // §6.5's "eligible for persist" is confirmed-only), so they make no claim on the tags.
  const position: PositionIntent | null = confirmed ? { lat: confirmed.lat, lon: confirmed.lon } : null;
  const desired = desiredTagValues(file.kind, time, position);

  const changes: PersistTagChange[] = [];
  for (const { tag, field } of preserved) {
    const next = desired[tag];
    if (next === undefined) continue;
    const old = current[tag] ?? null;
    if (old === next) continue;
    changes.push({ tag, field, old, next, stampsOriginal: !(tag in (ctx.written.get(file.id) ?? {})) });
  }
  if (changes.length === 0) return null;

  const currentSig = ctx.currentSig(file);
  return {
    fileId: file.id,
    relPath: file.relPath,
    changes,
    fields: fieldChanges(file, changes, current, time, position),
    timeShiftSeconds: Math.round(line.offsetSeconds),
    positionSource: position === null ? null : confirmed?.positionSource === 'drag' ? 'manual' : 'confirmed',
    positionUncertaintyM: confirmed?.uncertaintyM ?? null,
    // A file that has gone missing counts as changed underneath the app, so the write
    // stops and asks rather than recreating it (SPEC §8.3).
    stale: currentSig === null || currentSig !== ctx.storedSig(file),
  };
}

/**
 * What each tag says now.
 *
 * The value GeoTagger last wrote wins, since that is what is in the file. A tag it has
 * never written falls back to the scan: the app's own reading of the file, formatted the
 * way GeoTagger would write it so the two are comparable.
 *
 * The fallback is derived rather than read per tag because the scan keeps the capture time
 * and position it resolved (SPEC §4.1), not every tag they came from — so a photo whose
 * `CreateDate` disagrees with its `DateTimeOriginal` reads as though both said the capture
 * time, and one that carried its position in EXIF only reads as carrying it in XMP too.
 * Either way the value is right and only its spread across tags is a guess: being wrong
 * here writes a tag that already said the right thing, or leaves one the file never had
 * as the file had it. It never writes a wrong value, and the first write of that field
 * corrects the record for good.
 */
export function tagValuesOnDisk(file: FileRecord, written: OriginalTagValues): OriginalTagValues {
  const scanned = desiredTagValues(
    file.kind,
    file.captureTimeRaw === null
      ? null
      : {
          effectiveMs: instantOfNaive(file.kind, file.captureTimeRaw, file.captureUtcOffsetMinutes ?? 0),
          utcOffsetMinutes: file.captureUtcOffsetMinutes ?? 0,
          writeOffset: file.captureUtcOffsetMinutes !== null,
        },
    file.origGpsPresent && file.origLat !== null && file.origLon !== null
      ? { lat: file.origLat, lon: file.origLon }
      : null,
  );

  const out: OriginalTagValues = {};
  for (const { tag } of preservedTagsFor(file.kind)) out[tag] = written[tag] ?? scanned[tag] ?? null;
  return out;
}

/**
 * The human-readable rows for the fields this write touches (SPEC §9.1): the app's own
 * units, taken from the tags rather than from what the app happens to remember.
 */
function fieldChanges(
  file: FileRecord,
  changes: readonly PersistTagChange[],
  current: OriginalTagValues,
  time: TimeIntent,
  position: PositionIntent | null,
): PersistFieldChange[] {
  const touched = new Set(changes.map((c) => c.field));
  const fields: PersistFieldChange[] = [];

  if (touched.has('timestamp')) {
    const dateTag = file.kind === 'video' ? 'QuickTime:CreateDate' : 'EXIF:DateTimeOriginal';
    const old = current[dateTag];
    fields.push({
      field: 'timestamp',
      oldLocalIso: old == null ? null : fromExifDate(old),
      newLocalIso: localIsoForFile(file.kind, time),
    });
  }

  if (touched.has('utcOffset')) {
    const old = current['EXIF:OffsetTimeOriginal'];
    fields.push({
      field: 'utcOffset',
      oldMinutes: old == null ? null : parseOffset(old),
      newMinutes: time.utcOffsetMinutes,
    });
  }

  if (touched.has('position') && position !== null) {
    const old = coordsFromTags(file.kind, current);
    fields.push({
      field: 'position',
      oldLat: old?.lat ?? null,
      oldLon: old?.lon ?? null,
      // The same rounding the tags get, so the row and the file agree to the digit.
      newLat: Number(formatCoord(position.lat)),
      newLon: Number(formatCoord(position.lon)),
    });
  }

  return fields;
}
