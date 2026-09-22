import { useEffect, useRef } from 'react';
import { endMs, type TimeScale } from './scale.js';

/**
 * A real horizontal scrollbar under the lanes (SPEC §6.2).
 *
 * Panning otherwise means dragging the background, which runs out of room, or zooming
 * out and back in somewhere else, which throws the zoom away. This is a native
 * scrollbar over a proxy element whose scrollable width is the whole trip in pixels at
 * the current zoom: the thumb's size says how much of the trip is in view, and dragging
 * it moves the axis at a fixed scale.
 */
export function TimeScrollbar({
  scale,
  bounds,
  onScrollToMs,
}: {
  scale: TimeScale;
  bounds: { fromMs: number; toMs: number } | null;
  onScrollToMs: (startMs: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const range = scrollRange(scale, bounds);
  const contentPx = (range.toMs - range.fromMs) / scale.msPerPx;
  const offsetPx = (scale.startMs - range.fromMs) / scale.msPerPx;

  // The scroll position is derived from the scale, never the other way round: with one
  // source of truth the bar and a wheel zoom cannot chase each other.
  useEffect(() => {
    const element = ref.current;
    if (element && Math.abs(element.scrollLeft - offsetPx) > 0.5) element.scrollLeft = offsetPx;
  }, [offsetPx]);

  return (
    <div
      className="time-scrollbar"
      ref={ref}
      onScroll={(e) => {
        const startMs = range.fromMs + e.currentTarget.scrollLeft * scale.msPerPx;
        // Ignore the echo of the correction above; a scroll the user made is always
        // worth more than one pixel.
        if (Math.abs(startMs - scale.startMs) > scale.msPerPx) onScrollToMs(startMs);
      }}
    >
      <div className="time-scroll-content" style={{ width: Math.max(contentPx, 1) }} />
    </div>
  );
}

/**
 * How far the bar travels: the whole trip, plus half a screen either side so the first
 * and last shots can be pulled away from the edge — and never less than the view
 * itself, which a drag may have taken outside the trip entirely.
 */
function scrollRange(scale: TimeScale, bounds: { fromMs: number; toMs: number } | null) {
  const pad = (scale.msPerPx * scale.widthPx) / 2;
  return {
    fromMs: Math.min((bounds?.fromMs ?? scale.startMs) - pad, scale.startMs),
    toMs: Math.max((bounds?.toMs ?? endMs(scale)) + pad, endMs(scale)),
  };
}
