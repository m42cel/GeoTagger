import { useCallback, useEffect, useRef, useState } from 'react';
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
import { GroupingQuestion } from './GroupingQuestion.js';
import { TimestampQuestion } from './TimestampQuestion.js';
import { PersistDialog } from './PersistDialog.js';
import { AlignmentView } from './alignment/AlignmentView.js';
import { MapView } from './map/MapView.js';

/**
 * What an open folder shows, following the startup flow of SPEC §6.1: the scan, then
 * the grouping question, then the timestamp question, then the work.
 */
type View = 'grouping' | 'question' | 'files' | 'alignment' | 'map';

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
  const [view, setView] = useState<View>(() => initialView(session));
  const [persisting, setPersisting] = useState(false);

  // Kept current across renders so the scan-stream effect below — which only resubscribes
  // on a folder change, not on every session update — can still see the latest answer when
  // a later rescan settles.
  const groupingQuestionPending = useRef(session.groupingQuestionPending);
  groupingQuestionPending.current = session.groupingQuestionPending;
  const timestampQuestionPending = useRef(session.timestampQuestionPending);
  timestampQuestionPending.current = session.timestampQuestionPending;

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
  //
  // The scan (thumbnails included) is a precondition for browsing: whenever it settles
  // into 'done', land back at the front of the funnel rather than wherever the view
  // happened to be pointed before it started — this is also what makes a rescan hide
  // the pictures again, since the render below blocks on `scan.phase` directly.
  useEffect(() => {
    let previousPhase: ScanStatus['phase'] | null = null;
    const unsubscribe = subscribeScan((status) => {
      setScan(status);
      if (status.phase === 'done' && previousPhase !== 'done') {
        refresh();
        setView(nextView(groupingQuestionPending.current, timestampQuestionPending.current));
      }
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

  const chooseGrouping = useCallback(
    (mode: Exclude<GroupingMode, 'manual'>) => {
      api
        .answerGroupingQuestion(mode)
        .then((s) => {
          onSessionChange(s);
          setView(nextView(false, timestampQuestionPending.current));
          refresh();
        })
        .catch((err: unknown) => setError(errorText(err)));
    },
    [onSessionChange, refresh],
  );

  const rescan = useCallback(() => {
    // Optimistic: blocks browsing immediately rather than waiting for the first SSE
    // update, so no stale content flashes before the scan stream reports 'walking'.
    setScan((s) => ({ ...s, phase: 'walking' }));
    api.rescan().then(onSessionChange).catch((err: unknown) => setError(errorText(err)));
  }, [onSessionChange]);

  // The scan, including thumbnail generation, is a precondition for everything past
  // it (SPEC §6.1 step 2) — the question, the file grid, the alignment view all wait
  // behind it, and a rescan hides them again the same way.
  if (scan.phase !== 'done') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} onRescan={rescan} />
        {error && <div className="banner error">{error}</div>}
      </section>
    );
  }

  if (view === 'grouping') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} onRescan={rescan} />
        <GroupingQuestion files={data?.files ?? []} devices={data?.devices ?? []} onChoose={chooseGrouping} />
      </section>
    );
  }

  if (view === 'question') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} onRescan={rescan} />
        <TimestampQuestion
          onFixTimestamps={() => answerQuestion('alignment')}
          onGoToMap={() => answerQuestion('map')}
        />
      </section>
    );
  }

  if (view === 'map') {
    return (
      <section className="folder-view">
        <MapView onBack={() => setView('files')} />
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
        <button type="button" className="primary" onClick={() => setView('map')}>
          Open map
        </button>
        <button type="button" className="ghost" onClick={() => setView('alignment')}>
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

function initialView(session: SessionState): View {
  return nextView(session.groupingQuestionPending, session.timestampQuestionPending);
}

function nextView(groupingPending: boolean, timestampPending: boolean): View {
  if (groupingPending) return 'grouping';
  return timestampPending ? 'question' : 'files';
}
