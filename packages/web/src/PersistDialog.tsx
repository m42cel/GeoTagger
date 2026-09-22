import { useEffect, useState } from 'react';
import type { PersistPlan, PersistProgress, StalePolicy } from '@geotagger/shared';
import { api, runPersist } from './api.js';
import { errorText } from './App.js';

/**
 * The persist step of SPEC §9.1.
 *
 * Nothing is written until this dialog is confirmed: it keeps metadata writes to a
 * minimum on slow storage, allows free experimentation, and makes the whole edit set
 * reviewable before it becomes permanent. A failure does not abort the run — the file
 * keeps its pending state and can be retried.
 */
export function PersistDialog({ onClose }: { onClose: (wrote: boolean) => void }) {
  const [plan, setPlan] = useState<PersistPlan | null>(null);
  const [progress, setProgress] = useState<PersistProgress | null>(null);
  const [stalePolicy, setStalePolicy] = useState<StalePolicy>('skip');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.persistPlan().then(setPlan).catch((err: unknown) => setError(errorText(err)));
  }, []);

  const write = (): void => {
    setProgress({
      phase: 'writing',
      total: plan?.entries.length ?? 0,
      completed: 0,
      currentPath: null,
      written: 0,
      skipped: 0,
      failed: 0,
      results: [],
      error: null,
    });
    runPersist({ stalePolicy }, setProgress).catch((err: unknown) => setError(errorText(err)));
  };

  const done = progress !== null && progress.phase !== 'writing';
  const failures = progress?.results.filter((r) => !r.ok) ?? [];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>Persist changes</h2>

        {error && <p className="error">{error}</p>}

        {plan === null ? (
          <p className="muted">Working out what would be written…</p>
        ) : progress === null ? (
          <>
            <ul className="persist-summary">
              <li>
                <b>{plan.correctedTimestamps.toLocaleString()}</b> corrected timestamps
              </li>
              <li>
                <b>{plan.utcOffsetsAdded.toLocaleString()}</b> UTC offsets added
              </li>
              {/* Positions arrive in phase 4; time and position then commit together
                  in one write per file (SPEC §9.1). */}
            </ul>

            {plan.staleCount > 0 && (
              <div className="banner warn">
                <p>
                  ⚠ {plan.staleCount} file{plan.staleCount === 1 ? ' has' : 's have'} changed on disk since
                  they were scanned.
                </p>
                <label>
                  <input
                    type="radio"
                    checked={stalePolicy === 'skip'}
                    onChange={() => setStalePolicy('skip')}
                  />
                  Skip them
                </label>
                <label>
                  <input
                    type="radio"
                    checked={stalePolicy === 'overwrite'}
                    onChange={() => setStalePolicy('overwrite')}
                  />
                  Overwrite anyway
                </label>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => onClose(false)}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={plan.entries.length === 0} onClick={write}>
                Write {plan.entries.length.toLocaleString()} file{plan.entries.length === 1 ? '' : 's'}
              </button>
            </div>
          </>
        ) : (
          <>
            <progress value={progress.completed} max={Math.max(progress.total, 1)} />
            <p className="muted">
              {done
                ? `✓ ${progress.written.toLocaleString()} written and verified`
                : `${progress.completed} of ${progress.total} · ${progress.currentPath ?? ''}`}
            </p>

            {done && (progress.failed > 0 || progress.skipped > 0) && (
              <ul className="persist-failures">
                {failures.map((f) => (
                  <li key={f.fileId} className={f.skipped ? 'weak' : 'error'}>
                    {f.skipped ? '⊘' : '✗'} {f.relPath} <em>{f.reason}</em>
                  </li>
                ))}
              </ul>
            )}

            <div className="modal-actions">
              <button type="button" className="primary" disabled={!done} onClick={() => onClose(true)}>
                {done ? 'Close' : 'Writing…'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
