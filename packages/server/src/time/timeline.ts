import type { FileRecord, StripRecord, TimelineFile, UtcOffsetRule } from '@geotagger/shared';
import { effectiveMs, naiveToMs, offsetSecondsAt } from '@geotagger/shared';
import { dominantOffsetMinutes, resolveUtcOffset } from './utc-offset.js';

/**
 * Puts every file on one absolute timeline, which is what the alignment view draws
 * and what phase 2's interpolation will read.
 *
 * Three things combine here, and the order matters: the file's own wall-clock reading,
 * the clock correction its strip applies (SPEC §4.3), and the UTC offset that turns the
 * corrected reading into an instant (SPEC §4.2). The correction is applied *before* the
 * offset is resolved, because a camera set two hours wrong would otherwise be placed in
 * the wrong period of the trip and inherit the wrong zone.
 */

export interface TimelineInput {
  files: readonly FileRecord[];
  strips: readonly StripRecord[];
  /** file id -> strip id. */
  assignments: Record<number, number>;
  rules: readonly UtcOffsetRule[];
  /** The answer to the one-off question of SPEC §4.2, or null if it was never asked. */
  folderUtcOffsetMinutes: number | null;
  /** Per-file offset overrides, from the edit store. */
  fileOverrides: ReadonlyMap<number, number>;
}

export interface Timeline {
  files: TimelineFile[];
  /** The same strips, with their bounds on the absolute timeline filled in. */
  strips: StripRecord[];
  displayUtcOffsetMinutes: number;
  byId: Map<number, TimelineFile>;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const stripsById = new Map(input.strips.map((s) => [s.id, s]));
  const out: TimelineFile[] = [];
  const spans = new Map<number, { first: number; last: number }>();
  const offsets: number[] = [];

  for (const file of input.files) {
    const stripId = input.assignments[file.id] ?? null;
    const strip = stripId === null ? null : stripsById.get(stripId) ?? null;
    const rawCaptureMs = naiveToMs(file.captureTimeRaw);
    const offsetSeconds = strip === null ? 0 : offsetSecondsAt(strip, rawCaptureMs);

    const correctedNaiveMs = rawCaptureMs === null ? null : rawCaptureMs + offsetSeconds * 1000;
    const resolved = resolveUtcOffset(file, correctedNaiveMs, input.rules, {
      file: input.fileOverrides.get(file.id) ?? null,
      strip: strip?.utcOffsetOverrideMinutes ?? null,
      folder: input.folderUtcOffsetMinutes,
    });

    const effective =
      rawCaptureMs === null ? null : effectiveMs(rawCaptureMs, offsetSeconds, resolved.minutes);

    if (rawCaptureMs !== null) offsets.push(resolved.minutes);
    if (effective !== null && stripId !== null) {
      const span = spans.get(stripId);
      if (!span) spans.set(stripId, { first: effective, last: effective });
      else {
        if (effective < span.first) span.first = effective;
        if (effective > span.last) span.last = effective;
      }
    }

    out.push({
      id: file.id,
      stripId,
      rawCaptureMs,
      utcOffsetMinutes: resolved.minutes,
      utcOffsetSource: resolved.source,
      offsetSeconds,
      effectiveMs: effective,
    });
  }

  const strips = input.strips.map((s) => {
    const span = spans.get(s.id);
    return {
      ...s,
      firstEffectiveMs: span?.first ?? null,
      lastEffectiveMs: span?.last ?? null,
    };
  });

  return {
    files: out,
    strips,
    displayUtcOffsetMinutes: dominantOffsetMinutes(offsets),
    byId: new Map(out.map((f) => [f.id, f])),
  };
}

/** Effective instants of a strip's files, ascending — what snapping and cutting need. */
export function effectiveInstantsOf(timeline: Timeline, stripId: number): number[] {
  const out: number[] = [];
  for (const f of timeline.files) {
    if (f.stripId === stripId && f.effectiveMs !== null) out.push(f.effectiveMs);
  }
  return out.sort((a, b) => a - b);
}
