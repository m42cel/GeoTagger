import { useEffect, useState } from 'react';
import type { FolderEntry, FolderListing, RecentFolder } from '@geotagger/shared';
import { api } from './api.js';
import { errorText } from './App.js';

/**
 * The server-side folder browser of SPEC §6.1, with media counts and a recent list.
 * It browses the NAS from the NAS, which is why there is no native file dialog.
 */
export function FolderPicker({ onOpen }: { onOpen: (relPath: string) => void }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [current, setCurrent] = useState<FolderEntry | null>(null);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([api.listFolders(path), api.folderSummary(path)])
      .then(([l, c]) => {
        if (cancelled) return;
        setListing(l);
        setCurrent(c);
      })
      .catch((err: unknown) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    api.recentFolders().then(setRecent).catch(() => setRecent([]));
  }, []);

  return (
    <section className="picker">
      <h1>Choose a photo folder</h1>

      {recent.length > 0 && (
        <div className="recent">
          <h2>Recent</h2>
          <ul>
            {recent.map((r) => (
              <li key={r.relPath}>
                <button type="button" className="link" onClick={() => onOpen(r.relPath)}>
                  {r.relPath === '' ? '(photo root)' : r.relPath}
                </button>
                <span className="muted"> · {r.fileCount.toLocaleString()} files</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <div className="browser">
        <div className="browser-head">
          <span className="crumb">{path === '' ? '(photo root)' : path}</span>
          {listing?.parentRelPath !== null && listing !== null && (
            <button type="button" className="ghost" onClick={() => setPath(listing.parentRelPath ?? '')}>
              ↑ Up
            </button>
          )}
          {current && (
            <button type="button" className="primary" onClick={() => onOpen(path)}>
              Open this folder{current.mediaCount > 0 ? ` (${formatCount(current)})` : ''}
            </button>
          )}
        </div>

        {listing && listing.entries.length === 0 ? (
          <p className="muted">No subfolders here.</p>
        ) : (
          <ul className="folder-list">
            {listing?.entries.map((entry) => (
              <li key={entry.relPath}>
                <button type="button" className="folder-row" onClick={() => setPath(entry.relPath)}>
                  <span className="folder-name">{entry.name}</span>
                  <span className="muted">
                    {entry.mediaCount > 0 ? formatCount(entry) : 'no media'}
                    {entry.hasSubfolders ? ' · has subfolders' : ''}
                    {entry.known ? ' · opened before' : ''}
                  </span>
                </button>
                <button type="button" className="ghost" onClick={() => onOpen(entry.relPath)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** A capped count is a floor, so it is shown as "500+" rather than as exact. */
function formatCount(entry: { mediaCount: number; mediaCountCapped: boolean }): string {
  const n = entry.mediaCount.toLocaleString();
  return `${n}${entry.mediaCountCapped ? '+' : ''} media`;
}
