/** Widest and tallest shape a map thumbnail takes (SPEC §6.3): anything beyond shows its centred 4:3 or 3:4 section. */
const MAX_RATIO = 4 / 3;

/**
 * A map thumbnail's `[width, height]` in pixels: the image's own aspect ratio,
 * clamped to 4:3 … 3:4, with the long side at `longSidePx`. `width` and `height`
 * are the file's display dimensions (orientation already applied); when either is
 * unknown the marker is square.
 */
export function markerSize(width: number | null, height: number | null, longSidePx: number): [number, number] {
  if (!width || !height || width <= 0 || height <= 0) return [longSidePx, longSidePx];
  const ratio = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, width / height));
  return ratio >= 1
    ? [longSidePx, Math.round(longSidePx / ratio)]
    : [Math.round(longSidePx * ratio), longSidePx];
}
