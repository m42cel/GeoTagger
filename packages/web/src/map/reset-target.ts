import { isAnchor, type ComputedPosition, type FileId, type FileRecord, type TimelineFile } from '@geotagger/shared';

/** What resetting a confirmed file (SPEC §6.5) falls back to — the Reset button names it. */
export type ResetTarget = 'camera-gps' | 'estimate' | 'none';

/**
 * Camera GPS when the file has it; otherwise the estimate it would get, which needs a
 * capture time and two anchors besides itself (SPEC §5.4); otherwise nothing, and the
 * file goes to the tray.
 */
export function resetTarget(
  file: FileRecord,
  timelineFile: TimelineFile | null,
  items: readonly { file: { id: FileId }; position: ComputedPosition; timelineFile: TimelineFile | null }[],
): ResetTarget {
  if (file.origGpsPresent && file.origLat !== null && file.origLon !== null) return 'camera-gps';
  if (timelineFile?.effectiveMs === null || timelineFile?.effectiveMs === undefined) return 'none';
  let otherAnchors = 0;
  for (const item of items) {
    if (item.file.id === file.id || !isAnchor(item.position)) continue;
    if (item.timelineFile?.effectiveMs === null || item.timelineFile?.effectiveMs === undefined) continue;
    if (++otherAnchors >= 2) return 'estimate';
  }
  return 'none';
}

export const RESET_LABEL: Record<ResetTarget, string> = {
  'camera-gps': 'Reset to camera GPS',
  estimate: 'Reset to interpolated position',
  none: 'Reset to no position',
};
