/**
 * Advisory analyses shown beside the alignment view (SPEC §4.5).
 *
 * Nothing here is ever applied automatically or pre-selected. They are readouts that
 * help the user judge an alignment they made; the app cannot know which device is the
 * wrong one, so it does not pretend to.
 */

/**
 * A satellite-versus-camera-clock comparison. A file with a GPS fix carries the exact
 * UTC of the moment it was taken, so the gap to its own clock is that camera's error
 * at that moment — free and exact, and useless for a camera without GPS hardware.
 */
export interface GpsClockObservation {
  kind: 'gps-clock';
  stripId: number;
  stripLabel: string;
  /** Files in the strip that carried both a GPS time and their own clock reading. */
  sampleCount: number;
  /** Median correction the strip would need, in seconds. */
  medianOffsetSeconds: number;
  /** Spread across the samples, in seconds — a large one means the clock also drifted. */
  spreadSeconds: number;
}

/**
 * A shot-density correlation between two strips (SPEC §4.5).
 *
 * The intervals inside one device's timeline survive a wrong absolute clock, so
 * sliding one strip's shot pattern across another's and looking for the peak recovers
 * the offset between them without any GPS at all.
 */
export interface CorrelationObservation {
  kind: 'correlation';
  /** The strip that would move. */
  stripId: number;
  stripLabel: string;
  /** The strip it was compared against. */
  referenceStripId: number;
  referenceStripLabel: string;
  /** The shift at the correlation peak, in seconds; null when there was no clear match. */
  offsetSeconds: number | null;
  /** 0–1, from the peak-to-runner-up ratio. */
  confidence: number;
  /** How many shot pairs supported the peak. */
  support: number;
  /** Why the result is weak, when it is; null when the match is clear. */
  note: string | null;
}

export type TimeObservation = GpsClockObservation | CorrelationObservation;

export interface TimeObservationsResponse {
  observations: TimeObservation[];
  /** Limits of the correlation analysis, stated in the UI rather than assumed known. */
  correlationLimits: string[];
  computedAt: number;
}

export const CORRELATION_LIMITS: string[] = [
  'It needs overlapping usage of both devices.',
  'It assumes one constant offset across the compared window.',
  'Sparse or very regular shooting can produce a wrong peak.',
];
