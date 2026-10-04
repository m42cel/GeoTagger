import type { FileId } from '@geotagger/shared';

/**
 * "Align strips to preview" (SPEC §6.2, issue #5).
 *
 * Finding two reference photos by hand means zooming far in on one, then the other,
 * then back out to drag the strips together. The two buttons between the preview
 * panes skip the zooming: whichever two photos are already sitting in the panes are
 * the reference pair, and a click shifts one strip's offset so that pair lines up
 * exactly, the same way a manual drag-to-snap would.
 *
 * A strip with one pinned photo is stretched about that pin instead of shifted
 * (SPEC §4.3), and the button says so.
 */

/** What a preview pane needs of a strip and its photo to be a candidate for aligning. */
export interface AlignPreviewSlot {
  stripId: number;
  fileId: FileId;
  /** The pane's photo's position on the absolute timeline. */
  effectiveMs: number;
  /** The strip's current clock correction, seconds — what the new offset is computed from. */
  offsetSeconds: number;
  locked: boolean;
  pinnedFileIds: readonly FileId[];
}

export type AlignPreviewAction =
  | {
      kind: 'shift';
      stripId: number;
      offsetSeconds: number;
      /** The instant both photos land on once this offset is applied — what the view recentres on. */
      alignedMs: number;
    }
  | {
      kind: 'stretch';
      stripId: number;
      fileId: FileId;
      alignedMs: number;
    };

/** Whether aligning would shift the moving strip or stretch it about its pin. */
export function alignVerb(moving: AlignPreviewSlot | null): 'align' | 'stretch' {
  return moving !== null && moving.pinnedFileIds.length > 0 ? 'stretch' : 'align';
}

/**
 * Moves the top strip so its preview photo lands on the bottom photo's time, or
 * `null` when that isn't possible (see {@link alignDisabledReason}).
 */
export function alignTopToBottom(top: AlignPreviewSlot | null, bottom: AlignPreviewSlot | null): AlignPreviewAction | null {
  return align(top, bottom);
}

/** The mirror of {@link alignTopToBottom}: moves the bottom strip onto the top photo's time. */
export function alignBottomToTop(top: AlignPreviewSlot | null, bottom: AlignPreviewSlot | null): AlignPreviewAction | null {
  return align(bottom, top);
}

function align(moving: AlignPreviewSlot | null, onto: AlignPreviewSlot | null): AlignPreviewAction | null {
  if (moving === null || onto === null || blockedReason(moving) !== null) return null;
  if (moving.pinnedFileIds.length > 0) {
    return { kind: 'stretch', stripId: moving.stripId, fileId: moving.fileId, alignedMs: onto.effectiveMs };
  }
  return {
    kind: 'shift',
    stripId: moving.stripId,
    offsetSeconds: moving.offsetSeconds + Math.round((onto.effectiveMs - moving.effectiveMs) / 1000),
    alignedMs: onto.effectiveMs,
  };
}

/** Why a button is disabled, for its tooltip — `null` once the corresponding action is available. */
export function alignDisabledReason(
  top: AlignPreviewSlot | null,
  bottom: AlignPreviewSlot | null,
  moving: 'top' | 'bottom',
): string | null {
  if (top === null || bottom === null) return 'Both preview panes need a picture with a known time.';
  const reason = blockedReason(moving === 'top' ? top : bottom);
  return reason === null ? null : `The ${moving} ${reason}`;
}

/** What stops one strip from being moved onto the other's photo, finishing "The top …". */
function blockedReason(moving: AlignPreviewSlot): string | null {
  if (moving.locked) return 'strip is locked.';
  if (moving.pinnedFileIds.length > 1) return 'strip has two pinned photos, which fix it. Unpin one to stretch it.';
  if (moving.pinnedFileIds.includes(moving.fileId)) return 'photo is pinned, so it stays where it is. Unpin it to move it.';
  return null;
}
