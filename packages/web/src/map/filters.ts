import type { ComputedPosition, FileId } from '@geotagger/shared';

/** SPEC §6.3's marker filters: groups hidden by the user, and which of the two statuses show. */
export interface MapFilters {
  hiddenStripIds: ReadonlySet<number>;
  showKnown: boolean;
  showInterpolated: boolean;
}

/**
 * Whether a file's marker shows under `filters` (SPEC §6.3): its group must not be
 * hidden, and its status must be shown. A pending drag has neither status and passes
 * the status filter either way, so an unconfirmed drag never disappears under the
 * user — but it stays in its group, so hiding the group hides it too. A file no strip
 * claims has no group to hide.
 */
export function isShown(
  item: { file: { id: FileId }; position: ComputedPosition },
  assignments: Readonly<Record<FileId, number>>,
  filters: MapFilters,
): boolean {
  const stripId = assignments[item.file.id];
  if (stripId !== undefined && filters.hiddenStripIds.has(stripId)) return false;
  if (item.position.pending !== null) return true;
  switch (item.position.base?.source) {
    case 'camera-gps':
    case 'confirmed':
      return filters.showKnown;
    case 'estimate':
      return filters.showInterpolated;
    default:
      return true;
  }
}
