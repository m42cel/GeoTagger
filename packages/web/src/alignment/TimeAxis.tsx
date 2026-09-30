import type { UtcOffsetRule } from '@geotagger/shared';
import { axisTicks, endMs, xOf, type TimeScale } from './scale.js';
import { offsetSegments, zoneBands } from './zone-bands.js';

/**
 * The shared axis under the lanes (SPEC §6.2). Labels read in the offset that applies
 * at each instant, so every photo sits over its own local time even though the axis
 * itself is absolute. Where that offset changes, a seam marks the jump in the labels.
 */
export function TimeAxis({
  scale,
  rules,
  folderUtcOffsetMinutes,
  displayUtcOffsetMinutes,
}: {
  scale: TimeScale;
  rules: readonly UtcOffsetRule[];
  folderUtcOffsetMinutes: number | null;
  displayUtcOffsetMinutes: number;
}) {
  const viewTo = endMs(scale);
  const bands = zoneBands(rules, { fromMs: scale.startMs, toMs: viewTo }, folderUtcOffsetMinutes);
  const segments = offsetSegments(bands, displayUtcOffsetMinutes);
  const ticks = axisTicks(scale, segments);
  const seams = segments.slice(1).map((s) => s.fromMs).filter((ms) => ms > scale.startMs && ms < viewTo);
  return (
    <div className="time-axis">
      {seams.map((ms) => (
        <span key={`seam-${ms}`} className="axis-seam" style={{ left: xOf(scale, ms) }} />
      ))}
      {ticks.map((tick) => (
        <span
          key={tick.ms}
          className={`tick${tick.major ? ' major' : ''}`}
          style={{ left: xOf(scale, tick.ms) }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
