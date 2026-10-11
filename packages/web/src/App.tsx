import { useCallback, useEffect, useState } from 'react';
import { APP_VERSION, type SessionState } from '@geotagger/shared';
import { api } from './api.js';
import { FolderPicker } from './FolderPicker.js';
import { FolderView } from './FolderView.js';
import { ThemeToggle } from './ThemeToggle.js';

/**
 * The startup flow of SPEC §6.1: pick a folder, scan it, then work in it.
 */
export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

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

  const rescan = useCallback(() => {
    // Optimistic: blocks browsing immediately rather than waiting for the first SSE
    // update, so no stale content flashes before the scan stream reports 'walking'.
    setSession((s) => s && { ...s, scan: { ...s.scan, phase: 'walking' } });
    api
      .rescan()
      .then(setSession)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  return (
    <div className="app">
      <header className="app-bar">
        <span className="brand">
          <img src="/favicon.svg" alt="" />
          GeoTagger
        </span>
        {session && (
          <>
            <span className="crumb">{session.relPath === '' ? '(photo root)' : session.relPath}</span>
            <button type="button" className="ghost" disabled={scanning} onClick={rescan}>
              Rescan
            </button>
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
          <FolderView session={session} onSessionChange={setSession} onScanningChange={setScanning} />
        ) : (
          <FolderPicker onOpen={openFolder} />
        )}
      </main>

      <footer className="app-footer">
        <ThemeToggle />
        <span>GeoTagger {APP_VERSION}</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GeoTagger on GitHub" title="GeoTagger on GitHub">
          <GitHubMark />
        </a>
      </footer>
    </div>
  );
}

const REPO_URL = 'https://github.com/m42cel/GeoTagger';

/** GitHub's mark (Octicons `mark-github`), drawn in the text colour. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
