import { axisTicks, xOf, type TimeScale } from './scale.js';

/**
 * The shared axis under the lanes (SPEC §6.2). Labels read in the folder's display
 * offset, so the trip reads as the local time it happened in even though the axis
 * itself is absolute.
 */
export function TimeAxis({
  scale,
  displayUtcOffsetMinutes,
}: {
  scale: TimeScale;
  displayUtcOffsetMinutes: number;
}) {
  const ticks = axisTicks(scale, displayUtcOffsetMinutes);
  return (
    <div className="time-axis">
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
