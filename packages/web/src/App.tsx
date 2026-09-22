import { useCallback, useEffect, useState } from 'react';
import type { SessionState } from '@geotagger/shared';
import { api } from './api.js';
import { FolderPicker } from './FolderPicker.js';
import { FolderView } from './FolderView.js';

/**
 * The startup flow of SPEC §6.1: pick a folder, scan it, then work in it.
 *
 * Phase 0 stops at the scan result — the timestamp question and the alignment view
 * it leads to arrive in phase 1, and the map in phase 2.
 */
export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A reload mid-scan should land back in the open folder, not at the picker.
  useEffect(() => {
    api
      .session()
      .then(setSession)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, []);

  const openFolder = useCallback((relPath: string) => {
    setError(null);
    setLoading(true);
    api
      .open(relPath)
      .then(setSession)
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, []);

  const closeFolder = useCallback(() => {
    void api.close().finally(() => setSession(null));
  }, []);

  return (
    <div className="app">
      <header className="app-bar">
        <span className="brand">GeoTagger</span>
        {session && (
          <>
            <span className="crumb">{session.relPath === '' ? '(photo root)' : session.relPath}</span>
            <button type="button" className="ghost" onClick={closeFolder}>
              Choose another folder
            </button>
          </>
        )}
      </header>

      {error && <div className="banner error">{error}</div>}

      <main>
        {loading && !session ? (
          <p className="muted">Loading…</p>
        ) : session ? (
          <FolderView session={session} onSessionChange={setSession} />
        ) : (
          <FolderPicker onOpen={openFolder} />
        )}
      </main>
    </div>
  );
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
