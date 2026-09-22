import type {
  CorrelationObservation,
  FileRecord,
  GpsClockObservation,
  StripRecord,
  TimeObservation,
} from '@geotagger/shared';
import { naiveToMs } from '@geotagger/shared';
import type { Timeline } from '../time/timeline.js';
import { correlate } from './correlation.js';

/**
 * Builds the advisory panel of SPEC §4.5.
 *
 * Both analyses are computed against the *current* alignment rather than the raw
 * timestamps, so what they report is the shift still outstanding. That is what makes
 * them a check on the work rather than a second opinion about it: once a strip is
 * right, both read about zero.
 */

/** A strip needs at least this many files before it is worth correlating. */
const MIN_FILES_FOR_CORRELATION = 8;

export function buildObservations(
  files: readonly FileRecord[],
  strips: readonly StripRecord[],
  timeline: Timeline,
): TimeObservation[] {
  return [...gpsClockObservations(files, strips, timeline), ...correlationObservations(strips, timeline)];
}

/**
 * Satellite time against the camera's own clock.
 *
 * A file whose capture time *is* its GPS time carries no independent reading to
 * compare, so it is skipped — it would only ever report zero.
 */
function gpsClockObservations(
  files: readonly FileRecord[],
  strips: readonly StripRecord[],
  timeline: Timeline,
): GpsClockObservation[] {
  const samples = new Map<number, number[]>();

  for (const file of files) {
    if (file.gpsTimeUtc === null) continue;
    if (file.captureTimeSource === 'exif:GPSDateTime') continue;
    const entry = timeline.byId.get(file.id);
    if (!entry || entry.effectiveMs === null || entry.stripId === null) continue;
    const gpsInstant = naiveToMs(file.gpsTimeUtc);
    if (gpsInstant === null) continue;

    const bucket = samples.get(entry.stripId);
    const correction = (gpsInstant - entry.effectiveMs) / 1000;
    if (bucket) bucket.push(correction);
    else samples.set(entry.stripId, [correction]);
  }

  const out: GpsClockObservation[] = [];
  for (const strip of strips) {
    const values = samples.get(strip.id);
    if (!values || values.length === 0) continue;
    values.sort((a, b) => a - b);
    out.push({
      kind: 'gps-clock',
      stripId: strip.id,
      stripLabel: strip.label,
      sampleCount: values.length,
      medianOffsetSeconds: Math.round(median(values)),
      // A wide spread across a strip's own fixes is the signature of drift rather
      // than a constant error, which is what the stretch handles are for.
      spreadSeconds: Math.round((values[values.length - 1] as number) - (values[0] as number)),
    });
  }
  return out;
}

/**
 * Correlates every strip against one reference.
 *
 * A locked strip is the natural reference — locking is how the user says "this clock
 * is right" (SPEC §4.3) — and the largest strip otherwise, because the analysis needs
 * shots to work with. Comparing every pair would be n² readouts of which all but a few
 * are noise.
 */
function correlationObservations(strips: readonly StripRecord[], timeline: Timeline): CorrelationObservation[] {
  const instants = new Map<number, number[]>();
  for (const f of timeline.files) {
    if (f.stripId === null || f.effectiveMs === null) continue;
    const bucket = instants.get(f.stripId);
    if (bucket) bucket.push(f.effectiveMs);
    else instants.set(f.stripId, [f.effectiveMs]);
  }
  for (const list of instants.values()) list.sort((a, b) => a - b);

  const usable = strips.filter((s) => (instants.get(s.id)?.length ?? 0) >= MIN_FILES_FOR_CORRELATION);
  if (usable.length < 2) return [];

  const reference = pickReference(usable, instants);
  const referenceTimes = instants.get(reference.id) as number[];

  const out: CorrelationObservation[] = [];
  for (const strip of usable) {
    if (strip.id === reference.id) continue;
    const result = correlate(instants.get(strip.id) as number[], referenceTimes);
    out.push({
      kind: 'correlation',
      stripId: strip.id,
      stripLabel: strip.label,
      referenceStripId: reference.id,
      referenceStripLabel: reference.label,
      offsetSeconds: result.offsetSeconds,
      confidence: Number(result.confidence.toFixed(2)),
      support: result.support,
      note: result.note,
    });
  }
  return out;
}

function pickReference(strips: readonly StripRecord[], instants: ReadonlyMap<number, number[]>): StripRecord {
  const size = (s: StripRecord): number => instants.get(s.id)?.length ?? 0;
  const locked = strips.filter((s) => s.locked);
  const pool = locked.length > 0 ? locked : strips;
  return pool.reduce((best, s) => (size(s) > size(best) ? s : best), pool[0] as StripRecord);
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
