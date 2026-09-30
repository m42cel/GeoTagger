/**
 * "Align strips to preview" (SPEC §6.2, issue #5).
 *
 * Finding two reference photos by hand means zooming far in on one, then the other,
 * then back out to drag the strips together. The two buttons between the preview
 * panes skip the zooming: whichever two photos are already sitting in the panes are
 * the reference pair, and a click shifts one strip's offset so that pair lines up
 * exactly, the same way a manual drag-to-snap would.
 */

/** What a preview pane needs of a strip and its photo to be a candidate for aligning. */
export interface AlignPreviewSlot {
  stripId: number;
  /** The pane's photo's position on the absolute timeline. */
  effectiveMs: number;
  /** The strip's current clock correction, seconds — what the new offset is computed from. */
  offsetSeconds: number;
  locked: boolean;
}

export interface AlignPreviewAction {
  stripId: number;
  offsetSeconds: number;
  /** The instant both photos land on once this offset is applied — what the view recentres on. */
  alignedMs: number;
}

/**
 * Shifts the top strip so its preview photo lands on the bottom photo's time, or
 * `null` when the move isn't possible: either pane empty (or its photo undated), or
 * the top strip locked.
 */
export function alignTopToBottom(top: AlignPreviewSlot | null, bottom: AlignPreviewSlot | null): AlignPreviewAction | null {
  if (top === null || bottom === null || top.locked) return null;
  return {
    stripId: top.stripId,
    offsetSeconds: top.offsetSeconds + Math.round((bottom.effectiveMs - top.effectiveMs) / 1000),
    alignedMs: bottom.effectiveMs,
  };
}

/** The mirror of {@link alignTopToBottom}: shifts the bottom strip onto the top photo's time. */
export function alignBottomToTop(top: AlignPreviewSlot | null, bottom: AlignPreviewSlot | null): AlignPreviewAction | null {
  if (top === null || bottom === null || bottom.locked) return null;
  return {
    stripId: bottom.stripId,
    offsetSeconds: bottom.offsetSeconds + Math.round((top.effectiveMs - bottom.effectiveMs) / 1000),
    alignedMs: top.effectiveMs,
  };
}

/** Why a button is disabled, for its tooltip — `null` once the corresponding action is available. */
export function alignDisabledReason(
  top: AlignPreviewSlot | null,
  bottom: AlignPreviewSlot | null,
  moving: 'top' | 'bottom',
): string | null {
  if (top === null || bottom === null) return 'Both preview panes need a picture with a known time.';
  if (moving === 'top' ? top.locked : bottom.locked) return `The ${moving} strip is locked.`;
  return null;
}
