/**
 * The startup question of SPEC §6.1 step 4, always asked without pre-analysis.
 *
 * The app deliberately does not look at the timestamps first and decide for the user:
 * it cannot know which device was wrong, and a folder that looks fine may not be. Both
 * roads stay open — the alignment view is reachable at any time afterwards.
 */
export function TimestampQuestion({
  onFixTimestamps,
  onGoToMap,
}: {
  onFixTimestamps: () => void;
  onGoToMap: () => void;
}) {
  return (
    <div className="question-card">
      <h1>Do you need to adjust timestamps for this folder?</h1>
      <p className="muted">
        Correcting clocks first is worth it if any camera was set wrong — an interpolated position
        is only as good as the timestamp behind it. You can come back to it at any time.
      </p>
      <div className="question-actions">
        <button type="button" className="primary" onClick={onFixTimestamps}>
          Fix timestamps first
        </button>
        <button type="button" className="ghost" onClick={onGoToMap}>
          Go to map
        </button>
      </div>
    </div>
  );
}
