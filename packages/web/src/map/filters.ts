import { isAnchor, type ComputedPosition, type FileId } from '@geotagger/shared';

/** SPEC §6.3's status filter: exactly one is chosen. */
export type StatusFilter = 'all' | 'known' | 'interpolated' | 'unpersisted';

export const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'known', label: 'Known' },
  { id: 'interpolated', label: 'Interpolated' },
  { id: 'unpersisted', label: 'Unpersisted' },
];

/** SPEC §6.3's marker filters: groups hidden by the user, and the chosen status. */
export interface MapFilters {
  /** The files of the groups the user hid. */
  hiddenFileIds: ReadonlySet<FileId>;
  status: StatusFilter;
}

/** What the filters are judged against, from the server's latest responses. */
export interface FilterContext {
  /** Files whose confirmed position isn't written yet — the persist window's position changes. */
  unpersistedIds: ReadonlySet<FileId>;
}

/**
 * Whether a file's marker shows under `filters` (SPEC §6.3): its group must not be
 * hidden, and it must match the chosen status.
 *
 * A pending drag is judged by the file's own position underneath it: it shows exactly
 * when discarding the move would leave the file showing, so a dragged camera-GPS photo
 * stays under known and a dragged estimate under interpolated. A drag with nothing
 * underneath (placed from the tray) would go back to the tray, so only all shows it.
 * Unpersisted shows exactly what the persist window would write as a position — the
 * confirmation, never the drag — so a drag shows there only on top of a confirmed
 * position that isn't written yet.
 */
export function isShown(
  item: { file: { id: FileId }; position: ComputedPosition },
  context: FilterContext,
  filters: MapFilters,
): boolean {
  if (filters.hiddenFileIds.has(item.file.id)) return false;
  switch (filters.status) {
    case 'all':
      return true;
    case 'unpersisted':
      return context.unpersistedIds.has(item.file.id);
    case 'known':
      return isAnchor(item.position);
    case 'interpolated':
      return item.position.base?.source === 'estimate';
  }
}
