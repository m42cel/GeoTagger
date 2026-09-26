import type { UtcOffsetRule } from '@geotagger/shared';
import { clampToViewport, endMs, xOf, type TimeScale } from './scale.js';
import { bandLabel, bandShortLabel, bandTitle, zoneBands } from './zone-bands.js';

/**
 * The trip's UTC offset periods, drawn as one ribbon between the lanes and the axis
 * (SPEC §4.2).
 *
 * It belongs to the axis rather than to any lane, because a timezone is a property of
 * *where the trip was*, not of which camera was carried: one ribbon under every lane
 * says that, where a marking per strip would imply each device had a zone of its own.
 *
 * Periods are told apart by alternating tint rather than by a palette of their own.
 * The offset is the information, and it is written in the band; hue would add a second
 * thing to learn and a second thing to keep legible in both themes, for no more meaning
 * than the label already carries. What the drawing does encode is **confidence**:
 * observed periods are solid, and the stretches where the answer is merely the nearest
 * rule are hatched, so a crossing reads as the interval it actually is.
 */
/**
 * Whether a label fits the room a band has.
 *
 * Estimated from the text rather than compared against one width for every band: a
 * fixed threshold has to be set for the longest label a band might carry, and then a
 * crossing — the shortest label and the one most worth reading — loses its offsets to
 * a bare arrow in a band with room to spare.
 */
function fits(text: string, availablePx: number): boolean {
  return text !== '' && availablePx >= text.length * 6 + 14;
}

export function ZoneRibbon({
  scale,
  rules,
  folderUtcOffsetMinutes,
}: {
  scale: TimeScale;
  rules: readonly UtcOffsetRule[];
  folderUtcOffsetMinutes: number | null;
}) {
  const viewTo = endMs(scale);
  const bands = zoneBands(rules, { fromMs: scale.startMs, toMs: viewTo }, folderUtcOffsetMinutes);
  if (bands.length === 0) return null;

  let observedSoFar = 0;
  return (
    <div className="zone-ribbon">
      {bands.map((band, i) => {
        const alt = band.observed && observedSoFar++ % 2 === 1;
        if (band.toMs < scale.startMs || band.fromMs > viewTo) return null;

        const left = xOf(scale, band.fromMs);
        const right = xOf(scale, band.toMs);
        // How much of the band the viewport can actually show, which is what decides
        // whether its name fits — a period running off both edges has the whole width.
        const visible = Math.min(right, scale.widthPx) - Math.max(left, 0);

        // A band can run for real days while the viewport shows seconds of it; at a
        // deep enough zoom that turns into a `left`/`width` past what a browser will
        // reliably render, so the box itself is clamped to a margin around the
        // viewport. `visible` above still reflects the band's true extent.
        const domLeft = clampToViewport(left, scale.widthPx);
        // A period established by a single GPS fix has no width at all; it is still
        // the only thing known about that instant, so it keeps a hairline.
        const width = Math.max(3, clampToViewport(right, scale.widthPx) - domLeft);

        const kind = band.observed ? 'observed' : band.crossing ? 'crossing' : 'inferred';
        const full = bandLabel(band);
        const short = bandShortLabel(band);
        const label = fits(full, visible) ? full : fits(short, visible) ? short : '';
        return (
          <div
            key={`${band.fromMs}-${band.toMs}-${i}`}
            className={`zone-band ${kind}${alt ? ' alt' : ''}`}
            style={{ left: domLeft, width }}
            title={bandTitle(band)}
          >
            {label !== '' && (
              // Slides with the viewport so a period wider than the screen keeps its
              // name on show instead of leaving it off the left edge.
              <span className="zone-label" style={{ marginLeft: Math.max(0, -domLeft) }}>
                {label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
