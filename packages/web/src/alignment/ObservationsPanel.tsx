import type { TimeObservationsResponse } from '@geotagger/shared';
import { formatOffset } from '@geotagger/shared';

/**
 * The advisory panel of SPEC §4.5.
 *
 * Nothing here is applied automatically or pre-selected. Each reading offers to put
 * its number into the offset field, and the user decides — the app cannot know which
 * of two devices has the wrong clock.
 */
export function ObservationsPanel({
  data,
  stale,
  onApply,
  onRefresh,
}: {
  data: TimeObservationsResponse | null;
  /** True once a strip has moved since these were computed. */
  stale: boolean;
  onApply: (stripId: number, offsetSeconds: number) => void;
  onRefresh: () => void;
}) {
  return (
    <details className="panel observations" open>
      <summary>
        Observations
        <button
          type="button"
          className="link"
          onClick={(e) => {
            e.preventDefault();
            onRefresh();
          }}
        >
          refresh
        </button>
      </summary>

      {stale && data !== null && (
        <p className="weak">Strips have moved since these were worked out — refresh to see where they stand now.</p>
      )}

      {data === null ? (
        <p className="muted">Not computed yet.</p>
      ) : data.observations.length === 0 ? (
        <p className="muted">Nothing to report: no GPS times, and not enough overlap to correlate.</p>
      ) : (
        <ul className="observation-list">
          {data.observations.map((o) =>
            o.kind === 'gps-clock' ? (
              <li key={`gps-${o.stripId}`}>
                <strong>{o.stripLabel}</strong> · satellite time
                <p>
                  {o.sampleCount} file{o.sampleCount === 1 ? '' : 's'} with a GPS fix put this clock{' '}
                  <b>{formatOffset(o.medianOffsetSeconds)}</b> from satellite time.
                  {Math.abs(o.spreadSeconds) > 60 && (
                    <em> Spread {formatOffset(o.spreadSeconds)} — the clock also drifted.</em>
                  )}
                </p>
                {o.medianOffsetSeconds !== 0 && (
                  <button type="button" className="ghost" onClick={() => onApply(o.stripId, o.medianOffsetSeconds)}>
                    Shift this strip by {formatOffset(o.medianOffsetSeconds)}
                  </button>
                )}
              </li>
            ) : (
              <li key={`corr-${o.stripId}-${o.referenceStripId}`}>
                <strong>{o.stripLabel}</strong> · shot density against {o.referenceStripLabel}
                <p>
                  {o.offsetSeconds === null ? (
                    <span className="weak">{o.note ?? 'No clear match.'}</span>
                  ) : (
                    <>
                      Peak at <b>{formatOffset(o.offsetSeconds)}</b>, confidence{' '}
                      {(o.confidence * 100).toFixed(0)}% from {o.support} matching shots.
                      {o.note !== null && <em> {o.note}</em>}
                    </>
                  )}
                </p>
                {o.offsetSeconds !== null && (
                  <button type="button" className="ghost" onClick={() => onApply(o.stripId, o.offsetSeconds as number)}>
                    Shift this strip by {formatOffset(o.offsetSeconds)}
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {data !== null && (
        <ul className="limits">
          {data.correlationLimits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
