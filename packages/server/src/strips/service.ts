import type {
  DeviceRecord,
  FileRecord,
  GroupingMode,
  StripRecord,
  StripsResponse,
  TimelineResponse,
} from '@geotagger/shared';
import { MINUTE_MS, naiveToMs, originId } from '@geotagger/shared';
import type { FolderStore } from '../db/store.js';
import { buildTimeline, type Timeline } from '../time/timeline.js';
import { buildUtcOffsetRules } from '../time/utc-offset.js';
import { buildStrips } from './grouping.js';
import { arrangeLanes, laneAccepts, type LanePlacement } from './lanes.js';
import { planCut, planMerge, planPin, type SegmentMember } from './segments.js';

/**
 * A refused strip operation. Carries a status code because every one of these is a
 * user-level "no" — a locked strip, a cut that lands outside a strip, two segments
 * that are not adjacent — rather than a fault.
 */
export class StripOperationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = 'StripOperationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** How many strip edits back the user can step. */
const UNDO_DEPTH = 50;

/**
 * Everything the alignment view does to strips (SPEC §4.3, §4.4).
 *
 * It sits between the routes and the store because almost every operation needs the
 * same three things around it: the timeline, so a gesture expressed in effective time
 * can be turned into membership and offsets; the lane layout, which has to be settled
 * again afterwards; and an undo snapshot, because the spec makes every one of these
 * changes undoable.
 */
export class StripService {
  private readonly undoStack: string[] = [];

  constructor(private readonly store: FolderStore) {}

  // ---- reading -----------------------------------------------------------

  /**
   * Recomputes the UTC offset periods from the files that know theirs (SPEC §4.2).
   *
   * Called after a scan rather than on every read: it is a timezone lookup per
   * GPS-bearing file, and nothing but new files can change the answer.
   */
  refreshUtcOffsetRules(files?: readonly FileRecord[]): void {
    this.store.replaceUtcOffsetRules(buildUtcOffsetRules(files ?? this.store.listFiles()));
  }

  timeline(): Timeline {
    return buildTimeline({
      files: this.store.listFiles(),
      strips: this.store.listStrips(),
      assignments: this.store.stripAssignments(),
      rules: this.store.listUtcOffsetRules(),
      folderUtcOffsetMinutes: this.store.folderUtcOffsetMinutes,
      fileOverrides: this.store.fileUtcOffsetOverrides(),
    });
  }

  strips(): StripsResponse {
    const timeline = this.timeline();
    return {
      groupingMode: this.store.groupingMode,
      strips: timeline.strips,
      assignments: this.store.stripAssignments(),
      canUndo: this.undoStack.length > 0,
    };
  }

  timelineResponse(): TimelineResponse {
    const timeline = this.timeline();
    const rules = this.store.listUtcOffsetRules();
    return {
      groupingMode: this.store.groupingMode,
      strips: timeline.strips,
      assignments: this.store.stripAssignments(),
      canUndo: this.undoStack.length > 0,
      files: timeline.files,
      utcOffsetRules: rules,
      displayUtcOffsetMinutes: timeline.displayUtcOffsetMinutes,
      // Nothing to inherit from and nothing typed in: the offset has to be asked for
      // once, or every local time in the folder is silently treated as UTC.
      needsUtcOffsetAnswer:
        rules.length === 0 &&
        this.store.folderUtcOffsetMinutes === null &&
        timeline.files.some((f) => f.rawCaptureMs !== null && f.utcOffsetSource === 'assumed'),
      folderUtcOffsetMinutes: this.store.folderUtcOffsetMinutes,
    };
  }

  // ---- grouping (SPEC §4.4) ----------------------------------------------

  /**
   * Rebuilds every strip from a grouping mode, discarding cuts, offsets and locks.
   * The UI warns first; this is also what "reset all" runs.
   */
  regroup(mode: GroupingMode, options: { fileIds?: readonly number[]; label?: string } = {}): void {
    this.pushUndo();
    this.rebuild(mode, options);
  }

  /**
   * The same rebuild without an undo entry, for bringing strips up to date after a
   * scan — there is nothing there for the user to undo *to*, since the strips being
   * replaced do not yet cover the files that were just found.
   */
  rebuildAfterScan(mode: GroupingMode): void {
    this.rebuild(mode);
  }

  private rebuild(mode: GroupingMode, options: { fileIds?: readonly number[]; label?: string } = {}): void {
    if (mode === 'manual') {
      this.makeManualStrip(options.fileIds ?? [], options.label);
      return;
    }
    const built = buildStrips(mode, this.store.listFiles(), this.store.listDevices());
    this.store.replaceStrips(mode, built);
  }

  /**
   * Makes one strip out of a hand-picked selection (SPEC §4.4, "Manual").
   *
   * The files come out of whatever strips they were in, so a camera whose EXIF names
   * no device can be assembled by hand; strips left empty are removed, and the lanes
   * are settled again around the new one.
   */
  private makeManualStrip(fileIds: readonly number[], label?: string): void {
    this.store.groupingMode = 'manual';
    if (fileIds.length === 0) return;
    this.store.transact(() => {
      const lanes = this.store.listStrips().map((s) => s.lane);
      const id = this.store.createStrip(
        {
          label: label?.trim() || `Selection of ${fileIds.length}`,
          lane: lanes.length === 0 ? 0 : Math.max(...lanes) + 1,
          ordinal: 0,
          groupingSource: 'manual',
        },
        fileIds,
      );
      this.dropEmptyStrips(id);
    });
    this.settleLanes();
  }

  private dropEmptyStrips(exceptId?: number): void {
    for (const strip of this.store.listStrips()) {
      if (strip.id !== exceptId && strip.fileCount === 0) this.store.deleteStrip(strip.id);
    }
  }

  // ---- offsets, locking, reset -------------------------------------------

  setOffset(id: number, seconds: number): void {
    const strip = this.requireUnlocked(id);
    this.pushUndo();
    this.store.setStripOffset(id, seconds);
    this.settleLanes(strip.id);
  }

  /**
   * Locking freezes a strip against every change, and against nothing else: it stays
   * selectable, inspectable and — crucially — a snap target, so the device whose clock
   * is already right goes on anchoring the ones that are not (SPEC §4.3).
   */
  setLocked(id: number, locked: boolean): void {
    this.requireStrip(id);
    this.pushUndo();
    this.store.setStripLocked(id, locked);
  }

  /** Back to zero offset. Cuts are structure, and survive (SPEC §4.3). */
  reset(id: number): void {
    this.requireUnlocked(id);
    this.pushUndo();
    this.store.setStripOffset(id, 0);
    this.settleLanes(id);
  }

  /** Rebuilds every strip from the current grouping mode, discarding everything. */
  resetAll(): void {
    const mode = this.store.groupingMode;
    this.regroup(mode === 'manual' ? 'device' : mode);
  }

  setUtcOffsetOverride(id: number, minutes: number | null): void {
    this.requireUnlocked(id);
    this.pushUndo();
    this.store.setStripUtcOffsetOverride(id, minutes);
    this.settleLanes(id);
  }

  // ---- cutting and merging (SPEC §4.3) -----------------------------------

  /**
   * Splits a strip at a point on the axis.
   *
   * The parent's row becomes the left segment rather than being replaced by two new
   * ones. That keeps the lock state and the lane in place, and — because the family
   * link is a real foreign key — it keeps the row every sibling points at alive: the
   * origin of a family is never deleted by cutting or merging.
   */
  cut(id: number, atEffectiveMs: number): { leftId: number; rightId: number } {
    const strip = this.requireUnlocked(id);
    const timeline = this.timeline();
    const plan = planCut(strip, this.membersOf(timeline, id), atEffectiveMs);
    if (plan === null) {
      throw new StripOperationError(
        'cut_outside_strip',
        'A cut there would leave one side empty; put it between two files of the strip.',
        400,
      );
    }

    this.pushUndo();
    const rightId = this.store.transact(() => {
      this.store.setStripOffset(strip.id, plan.left.offsetSeconds);
      // Assigning a file to the new segment moves it out of the old one by itself:
      // every file belongs to exactly one strip (SPEC §8.2).
      return this.store.createStrip(
        {
          label: strip.label,
          lane: strip.lane,
          ordinal: strip.ordinal + 1,
          groupingSource: strip.groupingSource,
          parentStripId: originId(strip),
          offsetSeconds: plan.right.offsetSeconds,
          utcOffsetOverrideMinutes: strip.utcOffsetOverrideMinutes,
        },
        plan.right.fileIds,
      );
    });
    this.settleLanes();
    return { leftId: strip.id, rightId };
  }

  /**
   * Merges two adjacent segments of the same origin (SPEC §4.3). The result takes the
   * left segment's offset.
   */
  merge(leftId: number, rightId: number): number {
    const left = this.requireUnlocked(leftId);
    const right = this.requireUnlocked(rightId);
    if (leftId === rightId) {
      throw new StripOperationError('same_strip', 'A strip cannot be merged with itself.', 400);
    }
    if (originId(left) !== originId(right)) {
      throw new StripOperationError('not_same_origin', 'Only two segments cut from the same strip can be merged.');
    }

    const timeline = this.timeline();
    const withSpans = new Map(timeline.strips.map((s) => [s.id, s]));
    const [first, second] = orderByStart(
      withSpans.get(leftId) as StripRecord,
      withSpans.get(rightId) as StripRecord,
    );
    if (!this.areAdjacent(timeline.strips, first, second)) {
      throw new StripOperationError('not_adjacent', 'Those two segments have another segment between them.');
    }

    const plan = planMerge(
      {
        fileIds: this.membersOf(timeline, first.id).map((m) => m.fileId),
        offsetSeconds: first.offsetSeconds,
      },
      { fileIds: this.membersOf(timeline, second.id).map((m) => m.fileId) },
    );

    // Whichever of the two is the family's origin has to be the row that survives, or
    // the segments still pointing at it would lose the link that lets them be merged.
    const keep = second.parentStripId === null ? second : first;
    const drop = keep.id === first.id ? second : first;

    this.pushUndo();
    this.store.transact(() => {
      this.store.setStripOffset(keep.id, plan.offsetSeconds);
      this.store.assignFilesToStrip(keep.id, plan.fileIds);
      this.store.setStripLabel(keep.id, first.label);
      this.store.applyLaneLayout([{ id: keep.id, lane: first.lane, ordinal: first.ordinal }]);
      this.store.deleteStrip(drop.id);
    });
    this.settleLanes();
    return keep.id;
  }

  /** True when no third segment of the same family sits between the two. */
  private areAdjacent(strips: readonly StripRecord[], first: StripRecord, second: StripRecord): boolean {
    const family = strips
      .filter((s) => originId(s) === originId(first))
      .sort((a, b) => (a.firstEffectiveMs ?? Number.POSITIVE_INFINITY) - (b.firstEffectiveMs ?? Number.POSITIVE_INFINITY));
    const i = family.findIndex((s) => s.id === first.id);
    return i >= 0 && family[i + 1]?.id === second.id;
  }

  // ---- lanes -------------------------------------------------------------

  /**
   * Moves a strip to a lane the user dropped it in. A drop onto a strip it overlaps is
   * not honoured silently — `arrangeLanes` promotes it to a lane of its own instead.
   */
  moveToLane(id: number, lane: number): void {
    this.requireUnlocked(id);
    this.pushUndo();
    const placements = this.placements();
    const strip = placements.find((p) => p.id === id) as LanePlacement;
    const target = Math.max(0, Math.round(lane));
    strip.lane = laneAccepts(placements, strip, target) ? target : strip.lane;
    this.store.applyLaneLayout(arrangeLanes(placements, id));
  }

  /** Re-derives lanes and ordinals after anything that can have moved a strip. */
  private settleLanes(movedId: number | null = null): void {
    this.store.applyLaneLayout(arrangeLanes(this.placements(), movedId));
  }

  private placements(): LanePlacement[] {
    return this.timeline().strips.map((s) => ({
      id: s.id,
      lane: s.lane,
      ordinal: s.ordinal,
      firstMs: s.firstEffectiveMs,
      lastMs: s.lastEffectiveMs,
    }));
  }

  // ---- pinning (SPEC §4.3) -----------------------------------------------

  /**
   * Shifts a file's whole strip so that file lands on a time read off a clock in the
   * shot. `trueLocalIso` is a wall clock in the display offset, which is the one the
   * axis is labelled in and therefore the one the user just read.
   */
  pinTrueTime(fileId: number, trueLocalIso: string, displayUtcOffsetMinutes: number): void {
    const timeline = this.timeline();
    const file = timeline.byId.get(fileId);
    if (!file || file.effectiveMs === null) {
      throw new StripOperationError('no_such_file', 'That file has no timestamp to pin.', 400);
    }
    if (file.stripId === null) {
      throw new StripOperationError('no_strip', 'That file is not in a strip.', 400);
    }
    const target = naiveToMs(trueLocalIso);
    if (target === null) {
      throw new StripOperationError('bad_time', `Could not read "${trueLocalIso}" as a time.`, 400);
    }
    const strip = this.requireUnlocked(file.stripId);
    const pinned = planPin(strip, file.effectiveMs, target - displayUtcOffsetMinutes * MINUTE_MS);

    this.pushUndo();
    this.store.setStripOffset(strip.id, pinned);
    this.settleLanes(strip.id);
  }

  // ---- undo --------------------------------------------------------------

  private pushUndo(): void {
    this.undoStack.push(this.store.snapshotStrips());
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return false;
    this.store.restoreStrips(snapshot);
    return true;
  }

  // ---- helpers -----------------------------------------------------------

  private requireStrip(id: number): StripRecord {
    const strip = this.store.getStrip(id);
    if (!strip) throw new StripOperationError('no_such_strip', `No strip ${id}`, 404);
    return strip;
  }

  private requireUnlocked(id: number): StripRecord {
    const strip = this.requireStrip(id);
    if (strip.locked) {
      throw new StripOperationError('strip_locked', `${strip.label} is locked. Unlock it first.`);
    }
    return strip;
  }

  private membersOf(timeline: Timeline, stripId: number): SegmentMember[] {
    return timeline.files
      .filter((f) => f.stripId === stripId)
      .map((f) => ({ fileId: f.id, effectiveMs: f.effectiveMs }));
  }
}

function orderByStart(a: StripRecord, b: StripRecord): [StripRecord, StripRecord] {
  const av = a.firstEffectiveMs ?? Number.POSITIVE_INFINITY;
  const bv = b.firstEffectiveMs ?? Number.POSITIVE_INFINITY;
  return av <= bv ? [a, b] : [b, a];
}

/** Devices are re-exported for the routes that list them beside the strips. */
export type { DeviceRecord };
