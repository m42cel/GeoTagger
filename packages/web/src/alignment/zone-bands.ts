import { formatUtcOffset, type UtcOffsetRule } from '@geotagger/shared';

/**
 * The trip's UTC offset periods, as bands to draw under the lanes (SPEC §4.2).
 *
 * The rules a scan derives are the periods GPS-bearing files actually *observed*, and
 * they deliberately do not tile the timeline: between the last fix in one zone and the
 * first fix in the next there is a gap where `ruleForNaiveReading` falls back to the
 * nearest rule. Drawing a hard boundary inside that gap would invent the one thing
 * nobody knows — where the border was actually crossed — so the gap stays a band in
 * its own right and is drawn as unobserved.
 */
export interface ZoneBand {
  fromMs: number;
  toMs: number;
  /** True inside a rule's own window: a GPS-bearing file put this zone here. */
  observed: boolean;
  /** The offset holding across the band, or null where its two sides disagree. */
  offsetMinutes: number | null;
  zone: string | null;
  /** The offsets either side of a crossing, when they differ. */
  crossing: { fromMinutes: number; toMinutes: number } | null;
}

/**
 * Bands covering the view.
 *
 * `folderOffsetMinutes` is the one-off answer of SPEC §4.2, which applies when the
 * folder holds no GPS-bearing file at all and so produced no rules; it covers the whole
 * view as a single unobserved band, because that is exactly what it is — an assertion,
 * not an observation.
 */
export function zoneBands(
  rules: readonly UtcOffsetRule[],
  view: { fromMs: number; toMs: number },
  folderOffsetMinutes: number | null,
): ZoneBand[] {
  if (rules.length === 0) {
    if (folderOffsetMinutes === null) return [];
    return [
      {
        fromMs: view.fromMs,
        toMs: view.toMs,
        observed: false,
        offsetMinutes: folderOffsetMinutes,
        zone: null,
        crossing: null,
      },
    ];
  }

  const sorted = [...rules].sort((a, b) => a.fromUtc - b.fromUtc);
  const first = sorted[0] as UtcOffsetRule;
  const last = sorted[sorted.length - 1] as UtcOffsetRule;
  const out: ZoneBand[] = [];

  // Before the first fix and after the last one, the nearest rule wins — so the
  // trip's first and last periods reach out to the edges of the view, unobserved.
  if (view.fromMs < first.fromUtc) out.push(unobserved(view.fromMs, first.fromUtc, first, first));

  for (let i = 0; i < sorted.length; i += 1) {
    const rule = sorted[i] as UtcOffsetRule;
    out.push({
      fromMs: rule.fromUtc,
      toMs: rule.toUtc,
      observed: true,
      offsetMinutes: rule.offsetMinutes,
      zone: rule.zone,
      crossing: null,
    });
    const next = sorted[i + 1];
    if (next && next.fromUtc > rule.toUtc) out.push(unobserved(rule.toUtc, next.fromUtc, rule, next));
  }

  if (view.toMs > last.toUtc) out.push(unobserved(last.toUtc, view.toMs, last, last));
  return out;
}

/**
 * A stretch no fix covers. Two rules that agree on the offset still leave it settled —
 * Paris to Madrid changes the zone without changing the clock — so only a genuine
 * disagreement becomes a crossing.
 */
function unobserved(fromMs: number, toMs: number, before: UtcOffsetRule, after: UtcOffsetRule): ZoneBand {
  const agree = before.offsetMinutes === after.offsetMinutes;
  return {
    fromMs,
    toMs,
    observed: false,
    offsetMinutes: agree ? before.offsetMinutes : null,
    zone: agree && before.zone === after.zone ? before.zone : null,
    crossing: agree ? null : { fromMinutes: before.offsetMinutes, toMinutes: after.offsetMinutes },
  };
}

/** `+02:00 Berlin`, or `+02:00 → +09:00` across a crossing. */
export function bandLabel(band: ZoneBand): string {
  if (band.crossing) {
    return `${formatUtcOffset(band.crossing.fromMinutes)} → ${formatUtcOffset(band.crossing.toMinutes)}`;
  }
  const offset = band.offsetMinutes === null ? '' : formatUtcOffset(band.offsetMinutes);
  return band.zone === null ? offset : `${offset} ${cityOf(band.zone)}`;
}

/** What survives when the band is too narrow for a zone name. */
export function bandShortLabel(band: ZoneBand): string {
  if (band.crossing) return '→';
  return band.offsetMinutes === null ? '' : formatUtcOffset(band.offsetMinutes);
}

/** The full story, for the hover: what the band is, and how firmly it is known. */
export function bandTitle(band: ZoneBand): string {
  if (band.crossing) {
    return (
      `${bandLabel(band)} — the clock changes somewhere in here.\n` +
      'No GPS fix pins the crossing, so each file takes the offset of whichever period it falls nearer to.'
    );
  }
  const what = band.zone === null ? bandLabel(band) : `${bandLabel(band)} (${band.zone})`;
  return band.observed
    ? `${what} — established here by files carrying GPS and a trustworthy clock.`
    : `${what} — no GPS fix covers this stretch; the nearest period applies.`;
}

/** `Europe/Berlin` reads as `Berlin` in an 18 px band; the full name is in the hover. */
function cityOf(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/** A stretch of the view the axis labels in one offset. */
export interface OffsetSegment {
  fromMs: number;
  toMs: number;
  offsetMinutes: number;
}

/**
 * The offset the axis reads in at each point of the view, as consecutive segments.
 *
 * A crossing is split at its midpoint: that is roughly where its files stop taking the
 * earlier period and start taking the later one, so labels and thumbnails agree on
 * either side of it. Without any bands the whole view reads in `fallbackMinutes`.
 */
export function offsetSegments(bands: readonly ZoneBand[], fallbackMinutes: number): OffsetSegment[] {
  const out: OffsetSegment[] = [];
  const push = (fromMs: number, toMs: number, offsetMinutes: number): void => {
    const prev = out[out.length - 1];
    if (prev && prev.offsetMinutes === offsetMinutes) prev.toMs = toMs;
    else out.push({ fromMs, toMs, offsetMinutes });
  };

  for (const band of bands) {
    if (band.crossing) {
      const mid = (band.fromMs + band.toMs) / 2;
      push(band.fromMs, mid, band.crossing.fromMinutes);
      push(mid, band.toMs, band.crossing.toMinutes);
    } else {
      push(band.fromMs, band.toMs, band.offsetMinutes ?? fallbackMinutes);
    }
  }
  if (out.length === 0) out.push({ fromMs: -Infinity, toMs: Infinity, offsetMinutes: fallbackMinutes });
  // Nearest-rule-wins holds past the view too, so the outer segments never end.
  (out[0] as OffsetSegment).fromMs = -Infinity;
  (out[out.length - 1] as OffsetSegment).toMs = Infinity;
  return out;
}
