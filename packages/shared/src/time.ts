/**
 * The arithmetic that turns what a file says about itself into a point on one
 * absolute timeline (SPEC §4.2, §4.3).
 *
 * It lives in the shared package because both sides need it: the server resolves
 * and stores it, and the browser recomputes it on every pointer move while a strip
 * is being dragged, where a round trip per frame is not an option.
 */

/** Minute, hour and day in milliseconds — the units the alignment view works in. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * A naive wall-clock ISO string ("2024-07-12T14:32:10") to epoch ms, read as if it
 * were UTC.
 *
 * The result is not an instant — it is a wall-clock reading expressed as a number so
 * that it can be ordered and subtracted. Turning it into an instant needs the UTC
 * offset, which is exactly what §4.2 is about.
 */
export function naiveToMs(localIso: string | null): number | null {
  if (!localIso) return null;
  const ms = Date.parse(`${localIso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The inverse of `naiveToMs`: epoch ms back to a naive "YYYY-MM-DDTHH:MM:SS". */
export function msToNaive(ms: number): string {
  return new Date(Math.round(ms)).toISOString().slice(0, 19);
}

/** The part of a strip needed to compute a correction; the full record has more. */
export interface OffsetRamp {
  offsetStartSeconds: number;
  offsetEndSeconds: number;
  /** Bounds over the strip's *uncorrected* capture times, epoch ms. */
  firstCaptureMs: number | null;
  lastCaptureMs: number | null;
}

/**
 * The clock correction a strip applies to one of its files (SPEC §4.3).
 *
 * ```
 * offset(f) = o_start + (o_end - o_start) × (t_f - t0) / (t1 - t0)
 * ```
 *
 * where `t0`/`t1` are the strip's first and last raw capture times. With
 * `o_end == o_start` this is a constant shift, which is the normal case; a difference
 * between the two is linear clock drift.
 *
 * A strip whose files all share one timestamp has no span for a ramp to run over, so
 * the start offset applies throughout — which is why the stretch handles are disabled
 * on such a strip rather than producing a division by zero.
 */
export function offsetSecondsAt(ramp: OffsetRamp, rawCaptureMs: number | null): number {
  const { offsetStartSeconds: o0, offsetEndSeconds: o1, firstCaptureMs: t0, lastCaptureMs: t1 } = ramp;
  if (o0 === o1) return o0;
  if (rawCaptureMs === null || t0 === null || t1 === null || t1 === t0) return o0;
  const fraction = clamp01((rawCaptureMs - t0) / (t1 - t0));
  return o0 + (o1 - o0) * fraction;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** True when the strip's files span no time at all, so a ramp is undefined. */
export function rampIsDefined(ramp: OffsetRamp): boolean {
  return (
    ramp.firstCaptureMs !== null &&
    ramp.lastCaptureMs !== null &&
    ramp.lastCaptureMs > ramp.firstCaptureMs
  );
}

/**
 * The absolute instant a file sits at, in epoch ms.
 *
 * The raw reading is a wall clock in the file's own zone (UTC for video), so the
 * resolved offset is subtracted to reach UTC, and the strip's correction is added on
 * top. This is `effective(f) = t_f + offset(f) + utc_offset_resolution` from §4.3,
 * with the sign of the last term made explicit.
 */
export function effectiveMs(
  rawCaptureMs: number,
  offsetSeconds: number,
  utcOffsetMinutes: number,
): number {
  return rawCaptureMs - utcOffsetMinutes * MINUTE_MS + offsetSeconds * 1000;
}

/** Drift in seconds per hour across a stretched strip; 0 when it is not stretched. */
export function driftSecondsPerHour(ramp: OffsetRamp): number {
  if (!rampIsDefined(ramp)) return 0;
  const hours = ((ramp.lastCaptureMs as number) - (ramp.firstCaptureMs as number)) / HOUR_MS;
  if (hours <= 0) return 0;
  return (ramp.offsetEndSeconds - ramp.offsetStartSeconds) / hours;
}

/**
 * An offset as the alignment view writes it: `+1h 02m 12s`, `-45m 00s`, `0`.
 *
 * Minutes and seconds are zero-padded once a larger unit is present so a live readout
 * during a drag does not jitter in width as the digits change.
 */
export function formatOffset(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded === 0) return '0';
  const sign = rounded < 0 ? '-' : '+';
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (h > 0) return `${sign}${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${sign}${m}m ${pad(s)}s`;
  return `${sign}${s}s`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Reads back what `formatOffset` writes, and rather more besides — the offset field is
 * typed into by hand, so `1:02:12`, `+1h2m`, `-90m` and `3600` all have to work.
 *
 * Returns null when nothing sensible can be made of the input, so the caller can leave
 * the previous value in place rather than silently resetting a correction to zero.
 */
export function parseOffsetSeconds(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;
  if (text === '0') return 0;

  const sign = text.startsWith('-') ? -1 : 1;
  const body = text.replace(/^[+-]/, '').trim();

  // 1:02:12 or 02:12
  const colon = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(body);
  if (colon) {
    const a = Number(colon[1]);
    const b = Number(colon[2]);
    const c = colon[3] === undefined ? null : Number(colon[3]);
    const seconds = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return sign * seconds;
  }

  // 1h 02m 12s, 90m, 45s, and any subset in that order
  const unit = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/.exec(body);
  if (unit && (unit[1] ?? unit[2] ?? unit[3]) !== undefined) {
    const h = Number(unit[1] ?? 0);
    const m = Number(unit[2] ?? 0);
    const s = Number(unit[3] ?? 0);
    return Math.round(sign * (h * 3600 + m * 60 + s));
  }

  // A bare number is seconds.
  const bare = /^\d+(?:\.\d+)?$/.exec(body);
  if (bare) return Math.round(sign * Number(body));

  return null;
}

/** `+02:00` / `-05:30`, the form EXIF `OffsetTimeOriginal` takes. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Reads `+02:00`, `-0530`, `Z`, `+2`, `120` as minutes east of UTC. */
export function parseUtcOffsetMinutes(input: string): number | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^z$/i.test(text)) return 0;
  const m = /^([+-])?(\d{1,2}):?(\d{2})$/.exec(text);
  if (m) {
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    if (Number(m[3]) > 59) return null;
    return m[1] === '-' ? -minutes : minutes;
  }
  const hours = /^([+-])?(\d{1,2})(?:\.(\d+))?$/.exec(text);
  if (hours) {
    const value = Number(`${hours[2]}.${hours[3] ?? 0}`) * 60;
    return Math.round(hours[1] === '-' ? -value : value);
  }
  return null;
}

/**
 * Formats an instant as a wall clock in a chosen offset.
 *
 * The alignment view's axis is absolute UTC, but the labels on it have to read as the
 * local time the user remembers the trip in, so every label goes through here with the
 * folder's display offset.
 */
export function formatInstant(ms: number, utcOffsetMinutes: number, opts: { seconds?: boolean; date?: boolean } = {}): string {
  const shifted = new Date(ms + utcOffsetMinutes * MINUTE_MS);
  const iso = shifted.toISOString();
  const time = opts.seconds === true ? iso.slice(11, 19) : iso.slice(11, 16);
  return opts.date === true ? `${iso.slice(0, 10)} ${time}` : time;
}
