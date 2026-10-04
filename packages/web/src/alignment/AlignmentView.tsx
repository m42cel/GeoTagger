import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClockCorrection,
  FileId,
  FileRecord,
  GroupingMode,
  StripRecord,
  TimelineFile,
  TimelineResponse,
} from '@geotagger/shared';
import {
  computeSnap,
  computeStretchSnap,
  formatDrift,
  formatOffset,
  MAX_DRIFT,
  rebaseCorrection,
  shiftSecondsAt,
  stretchAbout,
  msToNaive,
  nudgeSeconds,
  originId,
  sampleInstants,
  snapToleranceMs,
  MINUTE_MS,
  type SnapKind,
} from '@geotagger/shared';
import { api } from '../api.js';
import { errorText } from '../App.js';
import {
  alignBottomToTop,
  alignDisabledReason,
  alignTopToBottom,
  alignVerb,
  type AlignPreviewAction,
  type AlignPreviewSlot,
} from './align-preview.js';
import { PreviewPane } from './PreviewPane.js';
import { SelectionPanel, type StripUtcSummary } from './SelectionPanel.js';
import { TimeAxis } from './TimeAxis.js';
import { TimeScrollbar } from './TimeScrollbar.js';
import { UtcOffsetPrompt } from './UtcOffsetPrompt.js';
import { ZoneRibbon } from './ZoneRibbon.js';
import { buildStripFiles, StripBody, STRIP_LANE_ROW_PX, STRIP_THUMB_HALF_PX, type StripFiles } from './StripBody.js';
import {
  clampToViewport,
  endMs,
  lowerBound,
  msAt,
  panBy,
  scaleForSpan,
  scaleForZoom,
  xOf,
  zoomAbout,
  type TimeScale,
  type ZoomLevel,
} from './scale.js';
import { nextWheelAxis, normaliseWheelDelta, wheelZoomFactor, type WheelGestureState } from './wheel-gesture.js';

/**
 * The alignment view (SPEC §4.3, §6.2).
 *
 * Clock corrections are made by dragging strips on a shared, proportional time axis
 * until the devices' patterns of activity line up — the same sunset, the same dinner,
 * the same walk. Photo content stays visible throughout, so recognising a shared
 * moment happens naturally rather than through a separate pairing screen.
 *
 * Nothing here touches a file. Offsets live in the edit store from the moment they
 * change and reach the files only on persist (SPEC §6.2).
 */

/**
 * Padding either side of a strip so its end thumbnails are inside its frame and its
 * drag area. Derived from the frame width rather than guessed: the two went out of
 * step the moment the thumbnails grew, and the end frames hung outside the strip.
 */
const STRIP_PAD_PX = STRIP_THUMB_HALF_PX + 6;

type Drag =
  | {
      kind: 'body';
      stripId: number;
      pointerId: number;
      startX: number;
      startY: number;
      baseOffset: number;
      lane: number;
      /** Pixels the strip has been moved horizontally, after snapping. */
      shiftPx: number;
      deltaSeconds: number;
      targetLane: number;
      snap: SnapKind;
    }
  | {
      /**
       * Dragging a stretch handle of a one-pin strip (SPEC §4.3): the pin stays put and
       * the file under the handle follows the pointer, everything else in proportion.
       */
      kind: 'stretch';
      stripId: number;
      pointerId: number;
      startX: number;
      handle: StretchHandle;
      /** The strip's correction rebased onto the pin, so only `drift` changes. */
      base: ClockCorrection;
      drift: number;
      snapped: boolean;
    }
  | { kind: 'pan'; pointerId: number; startX: number; startMs: number }
  | null;

/** One end of a one-pin strip, where a stretch handle sits. */
interface StretchHandle {
  side: 'start' | 'end';
  fileId: FileId;
  rawMs: number;
  /** Where the file sits now, before the drag. */
  effectiveMs: number;
  pivotRawMs: number;
}

export function AlignmentView({
  onBack,
  onOpenPersist,
  onOpenMap,
}: {
  onBack: () => void;
  onOpenPersist: () => void;
  onOpenMap: () => void;
}) {
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Width starts at zero rather than at a guess: every guess is wrong, and the fit
  // below waits for a real measurement instead of laying the trip out over a width
  // the canvas never had.
  const [scale, setScale] = useState<TimeScale>({ startMs: Date.now(), msPerPx: 60_000, widthPx: 0 });
  const [selectedStripId, setSelectedStripId] = useState<number | null>(null);
  /** Multi-select, for building a strip by hand (SPEC §4.4 "Manual"). */
  const [selectedFileIds, setSelectedFileIds] = useState<ReadonlySet<FileId>>(() => new Set());
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  /**
   * Where the last click landed, and so where the next cut goes. It stays put and
   * stays drawn: reaching the cut button means moving the pointer off the strip, so a
   * cut point that died with the hover could never be used (SPEC §4.3).
   */
  const [markMs, setMarkMs] = useState<number | null>(null);
  /**
   * The last two distinct strips clicked, each holding that strip's most recently
   * clicked photo, for the compare pane. Clicking another photo in an already-tracked
   * strip updates that entry in place rather than adding a second one, so the two panes
   * never hold two photos from the same strip; clicking a third strip evicts whichever
   * of the two is least recently touched. Which strip's photo is "upper" and which is
   * "lower" is a property of where the strips sit, not of this order (see
   * `previewSlots` below).
   */
  const [recentStrips, setRecentStrips] = useState<readonly { stripId: number; fileId: FileId }[]>([]);
  const previewLoadTokenRef = useRef(0);
  const [drag, setDrag] = useState<Drag>(null);
  const [snapDisabled, setSnapDisabled] = useState(false);
  /**
   * Keeps a dropped strip drawn at its new spot while the save round-trips, instead of
   * falling back to the still-stale `strip.offsetSeconds`/`lane` for one round trip and
   * flinging back then forward once the response lands. Cleared in the same state
   * update as the fresh timeline, so success never has a visible extra frame; on
   * failure it is cleared with nothing to replace it, and the strip lands back where
   * it started, which is the only case it should move at all.
   */
  const [pendingMove, setPendingMove] = useState<{
    stripId: number;
    lane: number;
    targetLane: number;
    shiftPx: number;
  } | null>(null);
  /** The same for a dropped stretch: drawn at its new drift until the save lands. */
  const [pendingStretch, setPendingStretch] = useState<{ stripId: number; correction: ClockCorrection } | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const widthObserverRef = useRef<ResizeObserver | null>(null);
  const fittedRef = useRef(false);
  /** Which axis the current trackpad/wheel gesture is locked to; see wheel-gesture.ts. */
  const wheelGestureRef = useRef<WheelGestureState | null>(null);

  useEffect(() => {
    Promise.all([api.timeline(), api.files()])
      .then(([t, f]) => {
        setTimeline(t);
        setFiles(f.files);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const run = useCallback((promise: Promise<TimelineResponse>) => {
    // Mutating calls answer with the whole timeline, so one response redraws
    // everything a strip change can touch: lanes, ordinals and inherited offsets.
    promise.then(setTimeline).catch((err: unknown) => setError(errorText(err)));
  }, []);

  // ---- geometry ----------------------------------------------------------

  /**
   * React registers its delegated `wheel` listener as passive, so `preventDefault`
   * inside a JSX `onWheel` handler is silently ignored and the page scrolls right
   * along with the zoom/pan underneath. Attaching the listener to the DOM node
   * ourselves with `passive: false` is the only way to actually stop that scroll.
   */
  const onWheelNative = useCallback((e: WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    // Shift-wheel always pans. Otherwise a gesture locks onto whichever axis it
    // started on — horizontal pans, vertical zooms — and holds that until the wheel
    // events pause, so a trackpad swipe that isn't perfectly straight doesn't flicker
    // into a zoom partway through (wheel-gesture.ts).
    if (e.shiftKey) {
      setScale((s) => panBy(s, normaliseWheelDelta(e.deltaY, e.deltaMode)));
      return;
    }
    const deltaX = normaliseWheelDelta(e.deltaX, e.deltaMode);
    const deltaY = normaliseWheelDelta(e.deltaY, e.deltaMode);
    const gesture = nextWheelAxis(wheelGestureRef.current, deltaX, deltaY, e.timeStamp);
    wheelGestureRef.current = gesture;
    if (gesture.axis === 'horizontal') setScale((s) => panBy(s, deltaX));
    else setScale((s) => zoomAbout(s, e.clientX - rect.left, wheelZoomFactor(deltaY)));
  }, []);

  /**
   * Measures the canvas as a ref callback rather than in an effect, because the canvas
   * is not in the DOM on the first render — the view is still loading the timeline —
   * and an effect that runs then observes nothing and never runs again. That is how
   * the width got stuck at its initial guess, culling every thumbnail beyond it.
   */
  const attachCanvas = useCallback(
    (element: HTMLDivElement | null) => {
      canvasRef.current?.removeEventListener('wheel', onWheelNative);
      canvasRef.current = element;
      widthObserverRef.current?.disconnect();
      widthObserverRef.current = null;
      if (element === null) return;
      element.addEventListener('wheel', onWheelNative, { passive: false });
      const measure = (): void =>
        setScale((s) => (s.widthPx === element.clientWidth ? s : { ...s, widthPx: element.clientWidth }));
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      widthObserverRef.current = observer;
      measure();
    },
    [onWheelNative],
  );

  const bounds = useMemo(() => boundsOf(timeline), [timeline]);

  // The first render with real data fits the whole trip; after that the user's zoom
  // is theirs to keep, and reloading strips must not throw it away.
  useEffect(() => {
    if (fittedRef.current || bounds === null || scale.widthPx < 50) return;
    fittedRef.current = true;
    setScale((s) => scaleForSpan(bounds, s.widthPx));
  }, [bounds, scale.widthPx]);

  const stripFiles = useMemo(() => buildStripFiles(timeline?.files ?? []), [timeline]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const lanes = useMemo(() => groupByLane(timeline?.strips ?? []), [timeline]);
  const selectedStrip = timeline?.strips.find((s) => s.id === selectedStripId) ?? null;

  /**
   * Every file's instant, across every strip, ascending — what "jump to next/previous
   * photo" searches. At a high zoom the view can sit over a long empty stretch between
   * two bursts; panning across it by hand is slow, so the jump lands on whatever photo
   * is nearest outside the current window instead of deforming the axis to hide the gap.
   */
  const allInstants = useMemo(() => {
    const out: number[] = [];
    for (const f of timeline?.files ?? []) {
      if (f.effectiveMs !== null) out.push(f.effectiveMs);
    }
    out.sort((a, b) => a - b);
    return out;
  }, [timeline]);
  const nextPhotoIdx = lowerBound(allInstants, endMs(scale));
  const prevPhotoIdx = lowerBound(allInstants, scale.startMs) - 1;

  const jumpToPhoto = (idx: number): void => {
    const targetMs = allInstants[idx];
    if (targetMs === undefined) return;
    const span = scale.msPerPx * scale.widthPx;
    setScale((s) => ({ ...s, startMs: targetMs - span / 2 }));
  };

  /** A strip's lane — what the compare pane sorts the two previews by. */
  const laneByStripId = useMemo(() => new Map((timeline?.strips ?? []).map((s) => [s.id, s.lane])), [timeline]);

  /**
   * The two tracked strips' photos, ordered by lane: the upper slot always shows the
   * higher strip, so a photo can jump from one slot to the other as new clicks change
   * which strip is the higher of the current pair.
   */
  const previewSlots = useMemo((): [FileId | null, FileId | null] => {
    const sorted = [...recentStrips].sort(
      (a, b) => (laneByStripId.get(a.stripId) ?? Infinity) - (laneByStripId.get(b.stripId) ?? Infinity),
    );
    return [sorted[0]?.fileId ?? null, sorted[1]?.fileId ?? null];
  }, [recentStrips, laneByStripId]);

  /**
   * What the preview panes' "align" buttons need of each slot's strip: its current
   * offset, whether it's locked, and where its photo actually sits — `null` for an
   * empty pane or one whose photo has no effective time, which the align functions
   * below treat as "can't align" (SPEC §6.2, issue #5).
   */
  const previewSlotFor = (fileId: FileId | null): AlignPreviewSlot | null => {
    if (fileId === null || timeline === null) return null;
    const line = timeline.files.find((f) => f.id === fileId);
    if (!line || line.effectiveMs === null || line.stripId === null) return null;
    const strip = timeline.strips.find((s) => s.id === line.stripId);
    if (!strip) return null;
    return {
      stripId: strip.id,
      fileId,
      effectiveMs: line.effectiveMs,
      offsetSeconds: strip.offsetSeconds,
      locked: strip.locked,
      pinnedFileIds: strip.pinnedFileIds,
    };
  };
  const topPreviewSlot = useMemo(() => previewSlotFor(previewSlots[0]), [previewSlots, timeline]);
  const bottomPreviewSlot = useMemo(() => previewSlotFor(previewSlots[1]), [previewSlots, timeline]);
  const alignTopAction = useMemo(
    () => alignTopToBottom(topPreviewSlot, bottomPreviewSlot),
    [topPreviewSlot, bottomPreviewSlot],
  );
  const alignBottomAction = useMemo(
    () => alignBottomToTop(topPreviewSlot, bottomPreviewSlot),
    [topPreviewSlot, bottomPreviewSlot],
  );
  const alignTitle = (action: AlignPreviewAction | null, moving: 'top' | 'bottom'): string => {
    const other = moving === 'top' ? 'bottom' : 'top';
    if (action === null) return alignDisabledReason(topPreviewSlot, bottomPreviewSlot, moving) ?? '';
    return action.kind === 'stretch'
      ? `Stretch the ${moving} strip about its pinned photo so this photo lines up with the ${other} one`
      : `Shift the ${moving} strip so this photo lines up with the ${other} one`;
  };

  /**
   * Runs an align-buttons action: sets the moved strip's offset through the normal
   * `setOffset` path (so undo covers it exactly like a drag or the offset field), or
   * stretches it about its pin when it has one (SPEC §4.3), then
   * recentres the view on the instant the two preview photos now share, keeping the
   * current zoom.
   */
  const applyAlign = (action: AlignPreviewAction | null): void => {
    if (action === null) return;
    const call =
      action.kind === 'stretch'
        ? api.stretch(action.stripId, action.fileId, action.alignedMs)
        : api.setOffset(action.stripId, action.offsetSeconds);
    call
      .then((next) => {
        setTimeline(next);
        const span = scale.msPerPx * scale.widthPx;
        setScale((s) => ({ ...s, startMs: action.alignedMs - span / 2 }));
      })
      .catch((err: unknown) => setError(errorText(err)));
  };

  /** Instants of every file outside the dragged strip: what snapping pulls towards. */
  const draggedStripId = drag?.kind === 'body' || drag?.kind === 'stretch' ? drag.stripId : null;
  const snapTargets = useMemo(() => {
    if (draggedStripId === null) return [];
    const out: number[] = [];
    for (const f of timeline?.files ?? []) {
      if (f.stripId !== draggedStripId && f.effectiveMs !== null) out.push(f.effectiveMs);
    }
    return out.sort((a, b) => a - b);
  }, [draggedStripId, timeline]);

  /** Where a stretched strip's files are drawn mid-drag or mid-save; see `StripBody`. */
  const stretchPreview = useMemo((): { stripId: number; instants: number[] } | null => {
    const shown =
      drag?.kind === 'stretch'
        ? { stripId: drag.stripId, correction: { ...drag.base, drift: drag.drift } }
        : pendingStretch;
    if (shown === null) return null;
    const files = stripFiles.get(shown.stripId);
    return files ? { stripId: shown.stripId, instants: restretched(files, shown.correction) } : null;
  }, [drag, pendingStretch, stripFiles]);

  // ---- dragging ----------------------------------------------------------

  const startBodyDrag = (e: React.PointerEvent, strip: StripRecord): void => {
    e.stopPropagation();
    setSelectedStripId(strip.id);
    // Keyboard nudging reaches precision the mouse cannot (SPEC §4.3), and it only
    // works if the canvas has focus — which a click on a plain element does not
    // reliably give it.
    canvasRef.current?.focus();
    // A pinned strip's body stays put; one pin moves it by its stretch handles instead
    // (SPEC §4.3).
    if (strip.locked || strip.pinnedFileIds.length > 0 || pendingMove?.stripId === strip.id) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      kind: 'body',
      stripId: strip.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseOffset: strip.offsetSeconds,
      lane: strip.lane,
      shiftPx: 0,
      deltaSeconds: 0,
      targetLane: strip.lane,
      snap: 'none',
    });
  };

  const startStretch = (e: React.PointerEvent, strip: StripRecord, handle: StretchHandle): void => {
    e.stopPropagation();
    setSelectedStripId(strip.id);
    canvasRef.current?.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = rebaseCorrection(strip, handle.pivotRawMs);
    setDrag({
      kind: 'stretch',
      stripId: strip.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      handle,
      base,
      drift: base.drift,
      snapped: false,
    });
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) setCursorMs(msAt(scale, e.clientX - rect.left));

    // A second finger or pen landing mid-drag must not steer the one in progress.
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;

    if (drag.kind === 'pan') {
      setScale((s) => ({ ...s, startMs: drag.startMs - dx * s.msPerPx }));
      return;
    }

    if (drag.kind === 'stretch') {
      // The file under the handle follows the pointer; the pin does not move.
      const { handle, base } = drag;
      const candidate = stretchAbout(base, handle.pivotRawMs, handle.rawMs, (dx * scale.msPerPx) / 1000);
      if (candidate === null) return;
      const files = stripFiles.get(drag.stripId);
      const moving = files === undefined ? [] : sampleStretched(files, candidate, 200);
      const snap = computeStretchSnap({
        candidateDrift: candidate.drift,
        pivotRawMs: handle.pivotRawMs,
        handleRawMs: handle.rawMs,
        moving,
        targetMs: snapTargets,
        toleranceMs: snapToleranceMs(scale.msPerPx),
        enabled: !snapDisabled && !e.altKey,
      });
      // Held inside what the server accepts, so the preview never shows a stretch that
      // would be refused on drop.
      const drift = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, snap.drift));
      setDrag({ ...drag, drift, snapped: snap.snapped && drift === snap.drift });
      return;
    }

    // Body drag: one constant shift for every file in the strip, with magnetic
    // snapping unless Alt is held (SPEC §4.3).
    const rawDelta = (dx * scale.msPerPx) / 1000;
    const candidate = drag.baseOffset + rawDelta;
    const moving = sampleInstants(shiftedInstants(stripFiles.get(drag.stripId)?.instants ?? [], rawDelta), 200);
    const snap = computeSnap({
      candidateOffsetSeconds: candidate,
      movingMs: moving,
      targetMs: snapTargets,
      toleranceMs: snapToleranceMs(scale.msPerPx),
      enabled: !snapDisabled && !e.altKey,
    });
    const deltaSeconds = snap.offsetSeconds - drag.baseOffset;
    const dy = e.clientY - drag.startY;
    setDrag({
      ...drag,
      deltaSeconds,
      shiftPx: (deltaSeconds * 1000) / scale.msPerPx,
      targetLane: Math.max(0, drag.lane + Math.round(dy / STRIP_LANE_ROW_PX)),
      snap: snap.kind,
    });
  };

  const endDrag = (e: React.PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const finished = drag;
    setDrag(null);
    if (finished.kind === 'pan') return;

    if (finished.kind === 'stretch') {
      if (finished.drift === finished.base.drift) return;
      const correction = { ...finished.base, drift: finished.drift };
      const { handle } = finished;
      const targetMs = handle.effectiveMs + (shiftSecondsAt(correction, handle.rawMs) - shiftSecondsAt(finished.base, handle.rawMs)) * 1000;
      setPendingStretch({ stripId: finished.stripId, correction });
      api
        .stretch(finished.stripId, handle.fileId, targetMs)
        .then((next) => {
          setTimeline(next);
          setPendingStretch(null);
        })
        .catch((err: unknown) => {
          setError(errorText(err));
          setPendingStretch(null);
        });
      return;
    }

    const moved = Math.round(finished.deltaSeconds) !== 0;
    const laneChanged = finished.targetLane !== finished.lane;
    if (!moved && !laneChanged) return;

    setPendingMove({
      stripId: finished.stripId,
      lane: finished.lane,
      targetLane: finished.targetLane,
      shiftPx: finished.shiftPx,
    });

    // A drag can be both a shift and a lane move; the offset goes first, because the
    // lane the strip is allowed to land in depends on where it now sits in time.
    const offsetCall = moved
      ? api.setOffset(finished.stripId, Math.round(finished.baseOffset + finished.deltaSeconds))
      : Promise.resolve(null);

    offsetCall
      .then((afterOffset) =>
        laneChanged ? api.setLane(finished.stripId, finished.targetLane) : (afterOffset ?? api.timeline()),
      )
      .then((next) => {
        setTimeline(next);
        setPendingMove(null);
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        setPendingMove(null);
      });
  };

  // ---- keyboard ----------------------------------------------------------

  /** Cuts the selected strip, and takes focus back so `c` keeps working afterwards. */
  const cutAt = (atMs: number): void => {
    if (selectedStrip === null || selectedStrip.locked) return;
    run(api.cut(selectedStrip.id, atMs));
    canvasRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Alt') setSnapDisabled(true);
    if (selectedStrip === null || selectedStrip.locked) return;

    // `c` cuts where the pointer is, without the round trip to the button that made
    // the pointer leave the strip in the first place.
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (markMs === null) return;
      e.preventDefault();
      cutAt(markMs);
      return;
    }

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // A pinned strip does not shift (SPEC §4.3).
    if (selectedStrip.pinnedFileIds.length > 0) return;
    const step = nudgeSeconds({ shift: e.shiftKey, ctrlOrMeta: e.ctrlKey || e.metaKey });
    const delta = e.key === 'ArrowLeft' ? -step : step;
    run(api.setOffset(selectedStrip.id, selectedStrip.offsetSeconds + delta));
  };

  // ---- actions -----------------------------------------------------------

  const regroup = (mode: GroupingMode): void => {
    if (
      (timeline?.strips.length ?? 0) > 0 &&
      !window.confirm(
        'Switching grouping mode rebuilds every strip from scratch, discarding cuts and clock offsets. Continue?',
      )
    ) {
      return;
    }
    run(api.regroup(mode));
  };

  /** Dragging the empty background pans the axis; strips stop this from firing. */
  const startPan = (e: React.PointerEvent): void => {
    if (e.target !== e.currentTarget) return;
    canvasRef.current?.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: 'pan', pointerId: e.pointerId, startX: e.clientX, startMs: scale.startMs });
  };

  const selectFile = (fileId: FileId, stripId: number, additive: boolean): void => {
    setSelectedStripId(stripId);

    // A browser holds an <img>'s previous frame on screen until its new src finishes
    // loading. Committing the compare pane straight away would, whenever that src isn't
    // cached yet, briefly show the strip a photo is moving away from with that same old
    // photo in both slots — one slot mid-load and still showing it, the other freshly
    // arrived at it. Loading first and only then updating state means both slots always
    // reach their new photo at once; the token lets a newer click cancel a slower older
    // one instead of having it land after the fact.
    const token = ++previewLoadTokenRef.current;
    const preload = new Image();
    preload.onload = preload.onerror = () => {
      if (previewLoadTokenRef.current !== token) return;
      setRecentStrips((current) => {
        const next = [...current.filter((e) => e.stripId !== stripId), { stripId, fileId }];
        return next.length > 2 ? next.slice(-2) : next;
      });
    };
    preload.src = `/api/files/${fileId}/preview`;

    setSelectedFileIds((current) => {
      if (!additive) return new Set([fileId]);
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const makeManualStrip = (): void => {
    const ids = [...selectedFileIds];
    if (ids.length === 0) return;
    const label = window.prompt(`Name this strip of ${ids.length} file${ids.length === 1 ? '' : 's'}`, 'Selection');
    if (label === null) return;
    run(api.regroup('manual', ids, label));
    setSelectedFileIds(new Set());
  };

  const setTrueTime = (fileId: FileId): void => {
    const line = timeline?.files.find((f) => f.id === fileId);
    if (!line || line.effectiveMs === null || timeline === null) return;
    const strip = timeline.strips.find((s) => s.id === line.stripId);
    const current = msToNaive(line.effectiveMs + line.utcOffsetMinutes * MINUTE_MS).replace('T', ' ');
    const answer = window.prompt(
      `What time was ${fileById.get(fileId)?.filename ?? 'this file'} really taken?\n` +
        (strip !== undefined && strip.pinnedFileIds.length > 0
          ? 'Its strip will stretch about the pinned photo so it lands there.'
          : 'Its whole strip will shift so it lands there.'),
      current,
    );
    if (answer === null) return;
    run(api.setTrueTime(fileId, answer.trim().replace(' ', 'T')));
  };

  const mergeTargetId = useMemo(() => nextSegmentId(timeline?.strips ?? [], selectedStrip), [timeline, selectedStrip]);
  const utcSummary = useMemo(
    () => stripUtcSummary(timeline?.files ?? [], selectedStripId),
    [timeline, selectedStripId],
  );
  // The detail block describes one file; with several picked, it is the last one.
  const selectedFileId = selectedFileIds.size === 0 ? null : ([...selectedFileIds].pop() as FileId);
  const selectedLine = timeline?.files.find((f) => f.id === selectedFileId) ?? null;

  if (timeline === null) {
    return <p className="muted">{error ?? 'Loading the timeline…'}</p>;
  }

  return (
    <section className="alignment">
      <div className="align-toolbar">
        <label>
          grouping
          <select
            value={timeline.groupingMode}
            onChange={(e) => regroup(e.target.value as GroupingMode)}
          >
            <option value="device">by device</option>
            <option value="subfolder">by subfolder</option>
            <option value="manual">manual</option>
          </select>
        </label>

        <span className="zoom">
          zoom
          {(['trip', 'day', 'hour', 'minute'] as ZoomLevel[]).map((level) => (
            <button
              key={level}
              type="button"
              className="ghost"
              onClick={() => bounds && setScale((s) => scaleForZoom(s, level, bounds))}
            >
              {level}
            </button>
          ))}
        </span>

        <span className="zoom">
          jump
          <button
            type="button"
            className="ghost"
            disabled={prevPhotoIdx < 0}
            title="Jump to the previous photo outside the current view"
            onClick={() => jumpToPhoto(prevPhotoIdx)}
          >
            ‹ previous
          </button>
          <button
            type="button"
            className="ghost"
            disabled={nextPhotoIdx >= allInstants.length}
            title="Jump to the next photo outside the current view"
            onClick={() => jumpToPhoto(nextPhotoIdx)}
          >
            next ›
          </button>
        </span>

        <button
          type="button"
          className="ghost"
          disabled={selectedFileIds.size === 0}
          title="Make one strip out of the files picked with Ctrl-click"
          onClick={makeManualStrip}
        >
          {selectedFileIds.size === 0 ? 'strip from selection' : `strip from ${selectedFileIds.size} files`}
        </button>
        <button type="button" className="ghost" disabled={!timeline.canUndo} onClick={() => run(api.undoStrips())}>
          undo
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            if (window.confirm('Rebuild every strip from the grouping mode, discarding cuts, offsets and locks?')) {
              run(api.resetAll());
            }
          }}
        >
          reset all
        </button>
        <button type="button" className="primary" onClick={onOpenMap}>
          Open map
        </button>
        <button type="button" className="ghost" onClick={onBack}>
          Back to files
        </button>
        <button type="button" className="ghost" onClick={onOpenPersist}>
          Persist changes…
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {timeline.needsUtcOffsetAnswer && (
        <UtcOffsetPrompt
          onAnswer={(minutes) =>
            api.setFolderUtcOffset(minutes).then(setTimeline).catch((err: unknown) => setError(errorText(err)))
          }
        />
      )}

      <div className="align-body">
        <div className="align-grid">
          <div className="lane-headers">
            {lanes.map((lane, i) => (
              <div className="lane-header" key={i} style={{ height: STRIP_LANE_ROW_PX }}>
                <span className="lane-label" title={lane.map((s) => s.label).join(' · ')}>
                  {lane[0]?.label ?? ''}
                  {lane.length > 1 && <em> ·{lane.length} segments</em>}
                </span>
                <span className="lane-controls">
                  {lane.map((strip, segment) => (
                    <span key={strip.id}>
                      {lane.length > 1 && <em className="segment-no">{segment + 1}</em>}
                      <button
                        type="button"
                        className={`chip${strip.locked ? ' on' : ''}`}
                        title={strip.locked ? 'Unlock' : 'Lock: freeze this clock, keep it as a snap target'}
                        onClick={() => run(api.setLocked(strip.id, !strip.locked))}
                      >
                        {strip.locked ? 'locked' : 'lock'}
                      </button>
                      <button
                        type="button"
                        className="chip"
                        disabled={strip.locked}
                        title="Back to zero offset"
                        onClick={() => run(api.resetStrip(strip.id))}
                      >
                        reset
                      </button>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <div
            className="lane-canvas"
            ref={attachCanvas}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => e.key === 'Alt' && setSnapDisabled(false)}
            onPointerDownCapture={(e) => {
              const rect = canvasRef.current?.getBoundingClientRect();
              if (rect) setMarkMs(msAt(scale, e.clientX - rect.left));
            }}
            onPointerDown={startPan}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setCursorMs(null)}
          >
            {lanes.map((lane, laneIndex) => (
              <div className="lane-row" key={laneIndex} style={{ height: STRIP_LANE_ROW_PX }}>
                {lane.map((strip) => {
                  const dragging = drag?.kind === 'body' && drag.stripId === strip.id ? drag : null;
                  const stretched = stretchPreview?.stripId === strip.id ? stretchPreview.instants : undefined;
                  // Only on the selected strip, so a stray grab never starts a stretch.
                  const handles =
                    selectedStripId === strip.id ? stretchHandles(strip, stripFiles.get(strip.id), timeline.files) : [];
                  const pending = pendingMove?.stripId === strip.id ? pendingMove : null;
                  const active = dragging ?? pending;
                  const shiftPx = active?.shiftPx ?? 0;
                  const laneShift = active === null ? 0 : (active.targetLane - active.lane) * STRIP_LANE_ROW_PX;
                  return (
                    <div
                      key={strip.id}
                      className={`strip-layer${selectedStripId === strip.id ? ' selected' : ''}${strip.locked ? ' locked' : ''}${strip.pinnedFileIds.length > 0 ? ' pinned' : ''}${pending ? ' pending' : ''}`}
                      style={{ transform: `translate(${shiftPx}px, ${laneShift}px)` }}
                    >
                      <div
                        className="strip-hit"
                        style={hitStyle(strip, scale, stretched)}
                        onPointerDown={(e) => startBodyDrag(e, strip)}
                        onClick={() => setSelectedStripId(strip.id)}
                      />
                      {pendingStretch === null &&
                        handles.map((handle) => (
                          <button
                            type="button"
                            key={handle.side}
                            className="stretch-handle"
                            style={handleStyle(handle, scale, stretched)}
                            title="Stretch about the pinned photo (Alt: no snapping)"
                            onPointerDown={(e) => startStretch(e, strip, handle)}
                          />
                        ))}
                      <StripBody
                        stripFiles={stripFiles.get(strip.id)}
                        stretchedInstants={stretched}
                        scale={scale}
                        fileById={fileById}
                        selectedFileIds={selectedFileIds}
                        pinnedFileIds={strip.pinnedFileIds}
                        onSelectFile={(id, additive) => selectFile(id, strip.id, additive)}
                        onSetTrueTime={setTrueTime}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            {markMs !== null && <div className="cut-marker" style={{ left: xOf(scale, markMs) }} />}
            {cursorMs !== null && <div className="cursor-line" style={{ left: xOf(scale, cursorMs) }} />}

            {drag?.kind === 'stretch' && (
              <div
                className="drag-readout"
                style={{ left: clamp(xOf(scale, cursorMs ?? scale.startMs), 90, scale.widthPx - 90) }}
              >
                drift {formatDrift(drag.drift)}
                {drag.snapped && <em> snapped to a photo</em>}
              </div>
            )}

            {drag?.kind === 'body' && (
              <div
                className="drag-readout"
                // Clamped away from both edges: the readout is the only exact feedback
                // during a drag, and half of it clipped is worse than none.
                style={{ left: clamp(xOf(scale, cursorMs ?? scale.startMs), 90, scale.widthPx - 90) }}
              >
                {formatOffset(drag.baseOffset + drag.deltaSeconds)}
                {drag.snap !== 'none' && <em> snapped to {drag.snap === 'photo' ? 'a photo' : `the ${drag.snap}`}</em>}
              </div>
            )}

            <ZoneRibbon
              scale={scale}
              rules={timeline.utcOffsetRules}
              folderUtcOffsetMinutes={timeline.folderUtcOffsetMinutes}
            />
            <TimeAxis
              scale={scale}
              rules={timeline.utcOffsetRules}
              folderUtcOffsetMinutes={timeline.folderUtcOffsetMinutes}
              displayUtcOffsetMinutes={timeline.displayUtcOffsetMinutes}
            />
          </div>

          <TimeScrollbar
            scale={scale}
            bounds={bounds}
            onScrollToMs={(startMs) => setScale((s) => ({ ...s, startMs }))}
          />
        </div>

        <PreviewPane
          top={previewSlots[0] === null ? null : (fileById.get(previewSlots[0]) ?? null)}
          bottom={previewSlots[1] === null ? null : (fileById.get(previewSlots[1]) ?? null)}
          topVerb={alignVerb(topPreviewSlot)}
          bottomVerb={alignVerb(bottomPreviewSlot)}
          onAlignTopToBottom={() => applyAlign(alignTopAction)}
          topAlignDisabled={alignTopAction === null}
          topAlignTitle={alignTitle(alignTopAction, 'top')}
          onAlignBottomToTop={() => applyAlign(alignBottomAction)}
          bottomAlignDisabled={alignBottomAction === null}
          bottomAlignTitle={alignTitle(alignBottomAction, 'bottom')}
        />
      </div>

      <SelectionPanel
        strip={selectedStrip}
        fileCountLabel={`${selectedStrip?.fileCount.toLocaleString() ?? 0} files`}
        mergeTargetId={mergeTargetId}
        cutAtMs={markMs}
        selectedFile={selectedFileId === null ? null : fileById.get(selectedFileId) ?? null}
        selectedLine={selectedLine}
        onSetOffset={(seconds) => selectedStrip && run(api.setOffset(selectedStrip.id, seconds))}
        onCut={cutAt}
        onMerge={(rightId) => selectedStrip && run(api.merge(selectedStrip.id, rightId))}
        onReset={() => selectedStrip && run(api.resetStrip(selectedStrip.id))}
        utcSummary={utcSummary}
        onSetUtcOffset={(minutes) => selectedStrip && run(api.setStripUtcOffset(selectedStrip.id, minutes))}
        onSetTrueTime={() => selectedFileId !== null && setTrueTime(selectedFileId)}
        onTogglePin={() =>
          selectedFileId !== null &&
          selectedStrip !== null &&
          run(api.setPinned(selectedFileId, !selectedStrip.pinnedFileIds.includes(selectedFileId)))
        }
      />
    </section>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v;
}

function hitStyle(strip: StripRecord, scale: TimeScale, stretched?: readonly number[]): React.CSSProperties {
  const first = stretched?.[0] ?? strip.firstEffectiveMs;
  const last = stretched?.[stretched.length - 1] ?? strip.lastEffectiveMs;
  if (first === null || last === null) {
    return { display: 'none' };
  }
  const left = clampToViewport(xOf(scale, first), scale.widthPx) - STRIP_PAD_PX;
  const right = clampToViewport(xOf(scale, last), scale.widthPx) + STRIP_PAD_PX;
  return { left, width: Math.max(8, right - left) };
}

const HANDLE_PX = 8;

/**
 * The stretch handles a strip shows: one at each end, but only on a strip with exactly
 * one pinned photo, and never on the pin itself (SPEC §4.3).
 */
function stretchHandles(
  strip: StripRecord,
  files: StripFiles | undefined,
  lines: readonly TimelineFile[],
): StretchHandle[] {
  if (strip.locked || strip.pinnedFileIds.length !== 1 || files === undefined) return [];
  const pinId = strip.pinnedFileIds[0];
  const pivotRawMs = lines.find((f) => f.id === pinId)?.rawCaptureMs ?? null;
  if (pivotRawMs === null) return [];
  const ends: [StretchHandle['side'], TimelineFile | undefined][] = [
    ['start', files.files[0]],
    ['end', files.files[files.files.length - 1]],
  ];
  const out: StretchHandle[] = [];
  for (const [side, file] of ends) {
    if (file === undefined || file.id === pinId || file.rawCaptureMs === null || file.effectiveMs === null) continue;
    if (file.rawCaptureMs === pivotRawMs) continue;
    out.push({ side, fileId: file.id, rawMs: file.rawCaptureMs, effectiveMs: file.effectiveMs, pivotRawMs });
  }
  return out;
}

/** A handle sits just outside its end file's frame, inside the strip's padding. */
function handleStyle(handle: StretchHandle, scale: TimeScale, stretched?: readonly number[]): React.CSSProperties {
  const ms = stretched === undefined ? handle.effectiveMs : handle.side === 'start' ? stretched[0] : stretched[stretched.length - 1];
  const x = xOf(scale, ms ?? handle.effectiveMs);
  return { left: handle.side === 'start' ? x - STRIP_PAD_PX : x + STRIP_PAD_PX - HANDLE_PX };
}

/**
 * Where a strip's files land under a different correction, in the same order: each
 * moves by the change in its own shift, its UTC offset left as it was.
 */
function restretched(files: StripFiles, correction: ClockCorrection): number[] {
  return files.files.map((f) =>
    f.rawCaptureMs === null
      ? (f.effectiveMs as number)
      : (f.effectiveMs as number) + (shiftSecondsAt(correction, f.rawCaptureMs) - f.offsetSeconds) * 1000,
  );
}

/** An even sample of a strip's files under a candidate stretch, for snapping. */
function sampleStretched(files: StripFiles, correction: ClockCorrection, max: number): { rawMs: number; ms: number }[] {
  const step = Math.max(1, files.files.length / max);
  const out: { rawMs: number; ms: number }[] = [];
  for (let i = 0; i < files.files.length; i += step) {
    const f = files.files[Math.floor(i)] as TimelineFile;
    if (f.rawCaptureMs === null || f.effectiveMs === null) continue;
    out.push({ rawMs: f.rawCaptureMs, ms: f.effectiveMs + (shiftSecondsAt(correction, f.rawCaptureMs) - f.offsetSeconds) * 1000 });
  }
  return out;
}

function boundsOf(timeline: TimelineResponse | null): { fromMs: number; toMs: number } | null {
  if (timeline === null) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const f of timeline.files) {
    if (f.effectiveMs === null) continue;
    if (f.effectiveMs < from) from = f.effectiveMs;
    if (f.effectiveMs > to) to = f.effectiveMs;
  }
  return Number.isFinite(from) ? { fromMs: from, toMs: to } : null;
}

function groupByLane(strips: readonly StripRecord[]): StripRecord[][] {
  const lanes: StripRecord[][] = [];
  for (const strip of strips) {
    while (lanes.length <= strip.lane) lanes.push([]);
    (lanes[strip.lane] as StripRecord[]).push(strip);
  }
  for (const lane of lanes) lane.sort((a, b) => a.ordinal - b.ordinal);
  return lanes;
}

/**
 * What UTC offsets a strip's files actually resolve to, in time order.
 *
 * Worth stating next to the field that overrides it, because the two are easy to
 * confuse: the field holds what was *typed*, usually nothing, while this is what §4.2
 * settled on. A strip that crossed a border while nobody cut it shows two offsets here
 * — which is correct, and invisible anywhere else.
 */
function stripUtcSummary(files: readonly TimelineFile[], stripId: number | null): StripUtcSummary | null {
  if (stripId === null) return null;
  const lines = files
    .filter((f) => f.stripId === stripId && f.effectiveMs !== null)
    .sort((a, b) => (a.effectiveMs as number) - (b.effectiveMs as number));
  if (lines.length === 0) return null;

  const offsets: number[] = [];
  const sources = new Set<TimelineFile['utcOffsetSource']>();
  for (const line of lines) {
    if (offsets[offsets.length - 1] !== line.utcOffsetMinutes) offsets.push(line.utcOffsetMinutes);
    sources.add(line.utcOffsetSource);
  }
  return { offsets, source: sources.size === 1 ? (lines[0] as TimelineFile).utcOffsetSource : null };
}

/** The segment immediately after this one in its family — the one `merge` accepts. */
function nextSegmentId(strips: readonly StripRecord[], strip: StripRecord | null): number | null {
  if (strip === null) return null;
  const family = strips
    .filter((s) => originId(s) === originId(strip))
    .sort((a, b) => (a.firstEffectiveMs ?? Infinity) - (b.firstEffectiveMs ?? Infinity));
  const i = family.findIndex((s) => s.id === strip.id);
  return i >= 0 ? family[i + 1]?.id ?? null : null;
}

function shiftedInstants(instants: readonly number[], deltaSeconds: number): number[] {
  const shift = deltaSeconds * 1000;
  return instants.map((ms) => ms + shift);
}
