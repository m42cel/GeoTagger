import type {
  FilesResponse,
  FolderEntry,
  FolderListing,
  GroupingMode,
  RecentFolder,
  ScanStatus,
  SessionState,
  StripsResponse,
} from '@geotagger/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  listFolders: (path: string) =>
    request<FolderListing>(`/api/folders?path=${encodeURIComponent(path)}`),
  folderSummary: (path: string) =>
    request<FolderEntry>(`/api/folders/summary?path=${encodeURIComponent(path)}`),
  recentFolders: () => request<RecentFolder[]>('/api/folders/recent'),
  session: () => request<SessionState | null>('/api/session'),
  open: (relPath: string) =>
    request<SessionState>('/api/session/open', {
      method: 'POST',
      body: JSON.stringify({ relPath }),
    }),
  rescan: () => request<SessionState>('/api/session/rescan', { method: 'POST' }),
  close: () => request<{ ok: boolean }>('/api/session/close', { method: 'POST' }),
  files: () => request<FilesResponse>('/api/files'),
  strips: () => request<StripsResponse>('/api/strips'),
  regroup: (mode: GroupingMode) =>
    request<StripsResponse>('/api/strips/regroup', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
};

/**
 * Subscribes to scan progress. Falls back to nothing if the stream drops — the
 * caller refetches on completion anyway, so a lost stream costs live progress
 * rather than correctness.
 */
export function subscribeScan(onStatus: (s: ScanStatus) => void): () => void {
  const source = new EventSource('/api/session/scan-stream');
  source.onmessage = (event) => {
    try {
      onStatus(JSON.parse(event.data as string) as ScanStatus);
    } catch {
      /* keepalive or partial frame */
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}
