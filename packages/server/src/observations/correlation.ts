/**
 * Shot-density correlation (SPEC §4.5).
 *
 * Two cameras on the same trip shoot the same things: the same sunset, the same
 * dinner, the same walk. The *intervals* inside one camera's timeline survive a wrong
 * absolute clock untouched, so sliding one strip's pattern of shots across another's
 * and looking for the peak recovers the offset between them — no GPS needed.
 *
 * It is a readout, never a button that moves strips. The app cannot know which of two
 * devices is the wrong one, and a sparse or very regular shooting pattern can put the
 * peak in the wrong place; both are stated in the UI alongside the number.
 */

/** The window searched, and the resolution it is searched at (SPEC §4.5). */
export const SEARCH_RANGE_MS = 48 * 3_600_000;
export const STEP_MS = 60_000;

/** Beyond this, thinning the input changes nothing but the time it takes. */
const MAX_SAMPLES = 2000;

/** A peak has to beat everything outside this window to count as distinct. */
const RUNNER_UP_EXCLUSION_STEPS = 30;

/** Fewer shots than this on either side and the pattern is not a pattern. */
const MIN_SHOTS = 8;

export interface CorrelationResult {
  /** The shift at the peak, in seconds, or null when there was no clear match. */
  offsetSeconds: number | null;
  /** 0–1, from the peak-to-runner-up ratio. */
  confidence: number;
  /** Shot pairs supporting the peak. */
  support: number;
  note: string | null;
}

export interface CorrelationOptions {
  /** Below this the result is reported as "no clear match". */
  minConfidence?: number;
}

/**
 * The shift that best aligns `moving` onto `reference`, both as ascending instants.
 *
 * A positive result means the moving strip has to go forwards in time by that many
 * seconds — the same sign convention as a strip's offset, so the number can be typed
 * straight into the offset field if the user decides to trust it.
 */
export function correlate(
  moving: readonly number[],
  reference: readonly number[],
  options: CorrelationOptions = {},
): CorrelationResult {
  const minConfidence = options.minConfidence ?? 0.25;
  const a = thin(moving);
  const b = thin(reference);

  if (a.length < MIN_SHOTS || b.length < MIN_SHOTS) {
    return { offsetSeconds: null, confidence: 0, support: 0, note: 'Too few shots to compare.' };
  }

  const steps = Math.round(SEARCH_RANGE_MS / STEP_MS);
  const histogram = new Float64Array(steps * 2 + 1);

  // Both lists ascend, so the window of reference shots within ±48 h of the current
  // moving shot only ever moves forwards: the pairs are found in one pass rather than
  // by comparing every shot with every other.
  let lo = 0;
  let hi = 0;
  for (const t of a) {
    while (lo < b.length && (b[lo] as number) < t - SEARCH_RANGE_MS) lo += 1;
    if (hi < lo) hi = lo;
    while (hi < b.length && (b[hi] as number) <= t + SEARCH_RANGE_MS) hi += 1;
    for (let j = lo; j < hi; j += 1) {
      const index = Math.round(((b[j] as number) - t) / STEP_MS) + steps;
      if (index >= 0 && index < histogram.length) histogram[index] = (histogram[index] as number) + 1;
    }
  }

  // A shared moment lands a minute or two apart on two cameras, so a raw bucket count
  // understates a real match; a narrow triangular blur puts those neighbours together
  // without smearing two genuinely distinct peaks into one.
  const smoothed = smooth(histogram);

  let peakIndex = 0;
  for (let i = 1; i < smoothed.length; i += 1) {
    if ((smoothed[i] as number) > (smoothed[peakIndex] as number)) peakIndex = i;
  }
  const peak = smoothed[peakIndex] as number;
  if (peak <= 0) {
    return { offsetSeconds: null, confidence: 0, support: 0, note: 'The two devices were never in use at the same time.' };
  }

  let runnerUp = 0;
  for (let i = 0; i < smoothed.length; i += 1) {
    if (Math.abs(i - peakIndex) <= RUNNER_UP_EXCLUSION_STEPS) continue;
    if ((smoothed[i] as number) > runnerUp) runnerUp = smoothed[i] as number;
  }

  const confidence = clamp01(1 - runnerUp / peak);
  const offsetSeconds = ((peakIndex - steps) * STEP_MS) / 1000;
  const support = Math.round(histogram[peakIndex] as number);

  if (confidence < minConfidence) {
    return {
      offsetSeconds: null,
      confidence,
      support,
      note: 'No clear match — several shifts fit about equally well.',
    };
  }
  if (support < 4) {
    return {
      offsetSeconds,
      confidence,
      support,
      note: 'Only a handful of shots support this; treat it as a hint.',
    };
  }
  return { offsetSeconds, confidence, support, note: null };
}

function smooth(histogram: Float64Array): Float64Array {
  const kernel = [0.5, 0.8, 1, 0.8, 0.5];
  const out = new Float64Array(histogram.length);
  const radius = (kernel.length - 1) / 2;
  for (let i = 0; i < histogram.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k += 1) {
      const j = i + k - radius;
      if (j >= 0 && j < histogram.length) sum += (histogram[j] as number) * (kernel[k] as number);
    }
    out[i] = sum;
  }
  return out;
}

function thin(instants: readonly number[]): number[] {
  const sorted = [...instants].sort((x, y) => x - y);
  if (sorted.length <= MAX_SAMPLES) return sorted;
  const step = sorted.length / MAX_SAMPLES;
  const out: number[] = [];
  for (let i = 0; i < MAX_SAMPLES; i += 1) out.push(sorted[Math.floor(i * step)] as number);
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
