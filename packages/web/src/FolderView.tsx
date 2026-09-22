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

/** What an open folder shows once phase 0 has scanned it. */
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

  const regroup = useCallback(
    (mode: GroupingMode) => {
      api
        .regroup(mode)
        .then(setStrips)
        .catch((err: unknown) => setError(errorText(err)));
    },
    [],
  );

  const rescan = useCallback(() => {
    api.rescan().then(onSessionChange).catch((err: unknown) => setError(errorText(err)));
  }, [onSessionChange]);

  const files = data?.files ?? [];

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

      {/*
        The timestamp question of SPEC §6.1 belongs here, but both of its answers lead
        to views that do not exist yet — the alignment view is phase 1 and the map is
        phase 2 — so phase 0 shows the scan result instead of asking it.
      */}
      <div className="panels">
        <StripList
          strips={strips}
          devices={data?.devices ?? []}
          onRegroup={regroup}
        />
        <FileGrid files={files} assignments={strips?.assignments ?? {}} />
      </div>
    </section>
  );
}
