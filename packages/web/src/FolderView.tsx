import { useCallback, useEffect, useState } from 'react';
import type {
  FilesResponse,
  GroupingMode,
  ScanStatus,
  SessionState,
  StripsResponse,
} from '@geotagger/shared';
import { api, subscribeScan } from './api.js';
import { errorText } from './App.js';
import { ScanProgress } from './ScanProgress.js';
import { FileGrid } from './FileGrid.js';
import { StripList } from './StripList.js';
import { TimestampQuestion } from './TimestampQuestion.js';
import { PersistDialog } from './PersistDialog.js';
import { AlignmentView } from './alignment/AlignmentView.js';

/**
 * What an open folder shows, following the startup flow of SPEC §6.1: the scan, then
 * the timestamp question, then the work.
 *
 * Phase 1 finishes at the alignment view; the map that the question's other answer
 * leads to is phase 2.
 */
type View = 'question' | 'files' | 'alignment';

export function FolderView({
  session,
  onSessionChange,
}: {
  session: SessionState;
  onSessionChange: (s: SessionState) => void;
}) {
  const [scan, setScan] = useState<ScanStatus>(session.scan);
  const [data, setData] = useState<FilesResponse | null>(null);
  const [strips, setStrips] = useState<StripsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(session.timestampQuestionPending ? 'question' : 'files');
  const [persisting, setPersisting] = useState(false);

  const refresh = useCallback(() => {
    Promise.all([api.files(), api.strips()])
      .then(([f, s]) => {
        setData(f);
        setStrips(s);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  // Live progress while scanning, and one refetch each time a scan settles.
  //
  // Keyed on the transition into a finished phase rather than a one-shot flag: the
  // same stream carries every later rescan too, and a flag would leave the file list
  // showing the results of the first scan only.
  useEffect(() => {
    let previousPhase: ScanStatus['phase'] | null = null;
    const unsubscribe = subscribeScan((status) => {
      setScan(status);
      const finished = status.phase === 'done' || status.phase === 'failed';
      if (finished && status.phase !== previousPhase) refresh();
      previousPhase = status.phase;
    });
    refresh();
    return unsubscribe;
  }, [refresh, session.folderId]);

  const answerQuestion = useCallback(
    (next: View) => {
      setView(next);
      // Recorded so reopening a folder whose clocks were sorted out weeks ago does
      // not ask again; the alignment view stays reachable either way.
      api.answerTimestampQuestion().then(onSessionChange).catch(() => undefined);
    },
    [onSessionChange],
  );

  const regroup = useCallback((mode: GroupingMode) => {
    api.regroup(mode).then(setStrips).catch((err: unknown) => setError(errorText(err)));
  }, []);

  const rescan = useCallback(() => {
    api.rescan().then(onSessionChange).catch((err: unknown) => setError(errorText(err)));
  }, [onSessionChange]);

  if (view === 'question') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} onRescan={rescan} />
        <TimestampQuestion
          onFixTimestamps={() => answerQuestion('alignment')}
          onSkip={() => answerQuestion('files')}
        />
      </section>
    );
  }

  if (view === 'alignment') {
    return (
      <section className="folder-view">
        {persisting && (
          <PersistDialog
            onClose={(wrote) => {
              setPersisting(false);
              if (wrote) refresh();
            }}
          />
        )}
        <AlignmentView onBack={() => setView('files')} onOpenPersist={() => setPersisting(true)} />
      </section>
    );
  }

  return (
    <section className="folder-view">
      <ScanProgress status={scan} onRescan={rescan} />
      {error && <div className="banner error">{error}</div>}

      {scan.summary && (
        <p className="summary">
          {scan.summary.known.toLocaleString()} known · {scan.summary.added.toLocaleString()} new ·{' '}
          {scan.summary.changed.toLocaleString()} changed · {scan.summary.missing.toLocaleString()} missing
        </p>
      )}

      <div className="view-actions">
        <button type="button" className="primary" onClick={() => setView('alignment')}>
          Fix timestamps
        </button>
        <button type="button" className="ghost" onClick={() => setPersisting(true)}>
          Persist changes…
        </button>
      </div>

      {persisting && (
        <PersistDialog
          onClose={(wrote) => {
            setPersisting(false);
            if (wrote) refresh();
          }}
        />
      )}

      <div className="panels">
        <StripList strips={strips} devices={data?.devices ?? []} onRegroup={regroup} />
        <FileGrid files={data?.files ?? []} assignments={strips?.assignments ?? {}} />
      </div>
    </section>
  );
}
