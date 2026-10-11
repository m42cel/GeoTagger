import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FileId,
  FilesResponse,
  GroupingMode,
  ScanStatus,
  SessionState,
  StripsResponse,
} from '@geotagger/shared';
import { api, subscribeScan } from './api.js';
import { errorText } from './App.js';
import { ScanProgress } from './ScanProgress.js';
import { FileDetail, FileGrid } from './FileGrid.js';
import { laneGroups } from './lane-groups.js';
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
  onScanningChange,
}: {
  session: SessionState;
  onSessionChange: (s: SessionState) => void;
  /** Whether a scan is in flight, for the app bar's Rescan button. */
  onScanningChange: (scanning: boolean) => void;
}) {
  const [scan, setScan] = useState<ScanStatus>(session.scan);
  const scanning = scan.phase !== 'done' && scan.phase !== 'failed' && scan.phase !== 'idle';
  useEffect(() => onScanningChange(scanning), [scanning, onScanningChange]);
  const [data, setData] = useState<FilesResponse | null>(null);
  const [strips, setStrips] = useState<StripsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => initialView(session));
  const [persisting, setPersisting] = useState(false);
  /** Bumped by every write, so the map and alignment view refetch what it changed. */
  const [writeCount, setWriteCount] = useState(0);
  // Held here rather than in the grid so it survives a trip to the map or the alignment
  // view, which unmounts the grid; a reload starts with every group expanded again.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<number | null>>(() => new Set());
  const [selectedFileId, setSelectedFileId] = useState<FileId | null>(null);
  /** The file the map or alignment view opens on, when opened from a file's details. */
  const [focusFileId, setFocusFileId] = useState<FileId | null>(null);
  const openView = (next: 'alignment' | 'map', focus: FileId | null = null): void => {
    setFocusFileId(focus);
    setView(next);
  };

  // Kept current across renders so the scan-stream effect below — which only resubscribes
  // on a folder change, not on every session update — can still see the latest answer when
  // a later rescan settles.
  const groupingQuestionPending = useRef(session.groupingQuestionPending);
  groupingQuestionPending.current = session.groupingQuestionPending;
  const timestampQuestionPending = useRef(session.timestampQuestionPending);
  timestampQuestionPending.current = session.timestampQuestionPending;

  // A rescan is started from the app bar, which hands the new scan down through the session.
  useEffect(() => setScan(session.scan), [session.scan]);

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
    (mode: GroupingMode) => {
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

  // The scan, including thumbnail generation, is a precondition for everything past
  // it (SPEC §6.1 step 2) — the question, the file grid, the alignment view all wait
  // behind it, and a rescan hides them again the same way.
  if (scan.phase !== 'done') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} />
        {error && <div className="banner error">{error}</div>}
      </section>
    );
  }

  if (view === 'grouping') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} />
        <GroupingQuestion files={data?.files ?? []} devices={data?.devices ?? []} onChoose={chooseGrouping} />
      </section>
    );
  }

  if (view === 'question') {
    return (
      <section className="folder-view">
        <ScanProgress status={scan} />
        <TimestampQuestion
          onFixTimestamps={() => answerQuestion('alignment')}
          onGoToMap={() => answerQuestion('map')}
        />
      </section>
    );
  }

  const persistDialog = persisting && (
    <PersistDialog
      onClose={(wrote) => {
        setPersisting(false);
        if (!wrote) return;
        refresh();
        setWriteCount((n) => n + 1);
      }}
    />
  );

  // The other views' edits change what is pending, so the overview's copy is refetched.
  const backToOverview = (): void => {
    refresh();
    setView('files');
  };

  if (view === 'map') {
    return (
      <section className="folder-view">
        {persistDialog}
        <MapView
          focusFileId={focusFileId}
          writeCount={writeCount}
          onBack={backToOverview}
          onOpenAlignment={() => openView('alignment')}
          onOpenPersist={() => setPersisting(true)}
        />
      </section>
    );
  }

  if (view === 'alignment') {
    return (
      <section className="folder-view">
        {persistDialog}
        <AlignmentView
          focusFileId={focusFileId}
          writeCount={writeCount}
          onBack={backToOverview}
          onOpenPersist={() => setPersisting(true)}
          onOpenMap={() => openView('map')}
        />
      </section>
    );
  }

  // Looked up by id so a refetch after a rescan or a write shows the file's new state,
  // and a file the rescan dropped simply stops being selected.
  const selectedFile = data?.files.find((f) => f.id === selectedFileId) ?? null;
  const selectedStripId = selectedFile === null ? undefined : strips?.assignments[selectedFile.id];
  const selectedGroup =
    selectedStripId === undefined
      ? null
      : (laneGroups(strips?.strips ?? []).find((g) => g.stripIds.includes(selectedStripId))?.label ?? null);

  return (
    <section className="folder-view">
      <ScanProgress status={scan} />
      {error && <div className="banner error">{error}</div>}

      <div className="view-actions">
        <button type="button" className="primary" onClick={() => openView('map')}>
          Open map
        </button>
        <button type="button" className="ghost" onClick={() => openView('alignment')}>
          Fix timestamps
        </button>
        <button
          type="button"
          className="persist-button"
          disabled={!data?.hasPendingChanges}
          onClick={() => setPersisting(true)}
        >
          Persist changes
        </button>
      </div>

      {persistDialog}

      <div className="panels">
        <div className="side-column">
          <StripList strips={strips} files={data?.files ?? []} devices={data?.devices ?? []} onRegroup={regroup} />
          {selectedFile && (
            <FileDetail
              file={selectedFile}
              group={selectedGroup}
              onShowInAlignment={() => openView('alignment', selectedFile.id)}
              onShowOnMap={() => openView('map', selectedFile.id)}
            />
          )}
        </div>
        <FileGrid
          files={data?.files ?? []}
          strips={strips}
          collapsed={collapsedGroups}
          onToggle={(lane) =>
            setCollapsedGroups((current) => {
              const next = new Set(current);
              if (!next.delete(lane)) next.add(lane);
              return next;
            })
          }
          selectedId={selectedFile?.id ?? null}
          onSelect={setSelectedFileId}
        />
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
