import type {
  AnswerGroupingQuestionRequest,
  FilesResponse,
  FolderEntry,
  FolderListing,
  GroupingMode,
  OplogEntry,
  PersistPlan,
  PersistProgress,
  PersistRequest,
  RecentFolder,
  ScanStatus,
  SessionState,
  StripsResponse,
  TimelineResponse,
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
  regroup: (mode: GroupingMode, fileIds?: number[], label?: string) =>
    post('/api/strips/regroup', { mode, fileIds, label }),

  // ---- alignment view (SPEC §4.3) ----------------------------------------

  timeline: () => request<TimelineResponse>('/api/timeline'),
  setOffset: (stripId: number, offsetSeconds: number) =>
    post(`/api/strips/${stripId}/offset`, { offsetSeconds }),
  cut: (stripId: number, atEffectiveMs: number) => post(`/api/strips/${stripId}/cut`, { atEffectiveMs }),
  merge: (leftStripId: number, rightStripId: number) =>
    post('/api/strips/merge', { leftStripId, rightStripId }),
  setLane: (stripId: number, lane: number) => post(`/api/strips/${stripId}/lane`, { lane }),
  setLocked: (stripId: number, locked: boolean) => post(`/api/strips/${stripId}/lock`, { locked }),
  resetStrip: (stripId: number) => post(`/api/strips/${stripId}/reset`, {}),
  resetAll: () => post('/api/strips/reset-all', {}),
  undoStrips: () => post('/api/strips/undo', {}),
  setStripUtcOffset: (stripId: number, utcOffsetMinutes: number | null) =>
    post(`/api/strips/${stripId}/utc-offset`, { utcOffsetMinutes }),
  pinTrueTime: (fileId: number, trueLocalIso: string) =>
    post('/api/strips/pin-true-time', { fileId, trueLocalIso }),
  setFolderUtcOffset: (utcOffsetMinutes: number) => post('/api/session/utc-offset', { utcOffsetMinutes }),
  answerTimestampQuestion: () =>
    request<SessionState>('/api/session/timestamp-question', { method: 'POST' }),
  answerGroupingQuestion: (mode: AnswerGroupingQuestionRequest['mode']) =>
    request<SessionState>('/api/session/grouping-question', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  // ---- writing (SPEC §9) -------------------------------------------------

  persistPlan: () => request<PersistPlan>('/api/persist/plan'),
  revertTime: (fileId: number) =>
    request<{ ok: boolean; reason: string | null }>(`/api/files/${fileId}/revert-time`, { method: 'POST' }),
  oplog: () => request<OplogEntry[]>('/api/oplog'),
};

/**
 * Every mutating strip call answers with the whole timeline, so one request is enough
 * to redraw: an offset change can move lanes and change which UTC offset a file
 * inherits, and asking again afterwards would show the view mid-update.
 */
function post(path: string, body: unknown): Promise<TimelineResponse> {
  return request<TimelineResponse>(path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Runs a persist and reports progress per file (SPEC §9.1).
 *
 * The response is a stream of events rather than one answer at the end, so the dialog
 * can name the file being written while a few hundred of them go past on slow storage.
 */
export async function runPersist(
  body: PersistRequest,
  onProgress: (progress: PersistProgress) => void,
): Promise<void> {
  const res = await fetch('/api/persist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || res.body === null) throw new Error(`Persist failed: ${res.status} ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Server-sent events are separated by a blank line; a partial one stays in the
    // buffer until the rest of it arrives.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        onProgress(JSON.parse(line.slice(6)) as PersistProgress);
      } catch {
        /* a frame split mid-object; the next one carries the full state anyway */
      }
    }
  }
}

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
