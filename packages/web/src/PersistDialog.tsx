import { useEffect, useState } from 'react';
import type { PersistFileResult, PersistPlan, PersistPlanEntry, PersistProgress, StalePolicy } from '@geotagger/shared';
import { formatUtcOffset } from '@geotagger/shared';
import { api, runPersist } from './api.js';
import { errorText } from './App.js';

/**
 * The persist step (SPEC §9.1): one scrollable, per-file review list — there is no
 * separate summary-counts screen and no separate post-write report. Rows are grouped
 * by file, with one sub-row per changed field (position, timestamp, UTC offset); a
 * file lists only the fields it actually changes. Nothing is written until Write is
 * pressed; once it is, the same rows fill in a ✓/✗ status as ExifTool finishes each
 * file, turning the reviewed list into the report.
 */
export function PersistDialog({ onClose }: { onClose: (wrote: boolean) => void }) {
  const [plan, setPlan] = useState<PersistPlan | null>(null);
  const [progress, setProgress] = useState<PersistProgress | null>(null);
  const [stalePolicy, setStalePolicy] = useState<StalePolicy>('skip');
  const [error, setError] = useState<string | null>(null);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [showRawExif, setShowRawExif] = useState(false);

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
  const resultByFileId = new Map((progress?.results ?? []).map((r) => [r.fileId, r]));
  const changeCount = (plan?.entries ?? []).reduce((n, e) => n + fieldsFor(e).length, 0);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal persist-modal">
        <div className="persist-header">
          <h2>Persist changes</h2>
          <div className="persist-toggles">
            <label className="map-toggle">
              <input type="checkbox" checked={showThumbnails} onChange={(e) => setShowThumbnails(e.target.checked)} />
              thumbnails
            </label>
            <label className="map-toggle">
              <input type="checkbox" checked={showRawExif} onChange={(e) => setShowRawExif(e.target.checked)} />
              raw EXIF values
            </label>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        {plan === null ? (
          <p className="muted">Working out what would be written…</p>
        ) : (
          <>
            {plan.entries.length === 0 ? (
              <p className="muted">Nothing to persist.</p>
            ) : (
              <div className="persist-entries">
                {plan.entries.map((entry) => (
                  <PersistEntry
                    key={entry.fileId}
                    entry={entry}
                    showThumbnail={showThumbnails}
                    rawExif={showRawExif}
                    result={resultByFileId.get(entry.fileId) ?? null}
                    active={progress !== null && !done && progress.currentPath === entry.relPath}
                  />
                ))}
              </div>
            )}

            {progress === null && plan.staleCount > 0 && (
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

            {progress !== null && <progress value={progress.completed} max={Math.max(progress.total, 1)} />}

            <div className="modal-actions">
              {progress === null ? (
                <>
                  <span className="muted persist-count">
                    {changeCount.toLocaleString()} change{changeCount === 1 ? '' : 's'} across{' '}
                    {plan.entries.length.toLocaleString()} file{plan.entries.length === 1 ? '' : 's'}
                  </span>
                  <button type="button" className="ghost" onClick={() => onClose(false)}>
                    Cancel
                  </button>
                  <button type="button" className="primary" disabled={plan.entries.length === 0} onClick={write}>
                    Write {plan.entries.length.toLocaleString()} file{plan.entries.length === 1 ? '' : 's'}
                  </button>
                </>
              ) : (
                <>
                  <span className="muted persist-count">
                    {done
                      ? `✓ ${progress.written.toLocaleString()} written and verified`
                      : `${progress.completed} of ${progress.total} · ${progress.currentPath ?? ''}`}
                  </span>
                  <button type="button" className="primary" disabled={!done} onClick={() => onClose(true)}>
                    {done ? 'Close' : 'Writing…'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface Field {
  key: string;
  label: string;
  old: string;
  next: string;
}

/** One row per field a file actually changes (SPEC §9.1) — position, timestamp, UTC offset. */
function fieldsFor(entry: PersistPlanEntry): Field[] {
  const fields: Field[] = [];
  if (entry.positionKind !== 'none') {
    fields.push({
      key: 'position',
      label: 'position',
      old: formatPosition(entry.oldLat, entry.oldLon),
      next: formatPosition(entry.newLat, entry.newLon),
    });
  }
  if (entry.timeKind !== 'none') {
    fields.push({
      key: 'timestamp',
      label: 'timestamp',
      old: formatLocalIso(entry.oldLocalIso),
      next: formatLocalIso(entry.newLocalIso),
    });
  }
  if (entry.writesUtcOffset) {
    fields.push({
      key: 'utc-offset',
      label: 'UTC offset',
      old: formatOffsetValue(entry.oldUtcOffsetMinutes),
      next: formatOffsetValue(entry.utcOffsetMinutes),
    });
  }
  return fields;
}

/**
 * One file's group: thumbnail and filename on the left, spanning the full height of
 * however many fields it changes; those fields stack as separate lines to the right
 * of it, not in a shared grid with the filename column (SPEC §9.1 — "not a header row
 * printed above them").
 */
function PersistEntry({
  entry,
  showThumbnail,
  rawExif,
  result,
  active,
}: {
  entry: PersistPlanEntry;
  showThumbnail: boolean;
  rawExif: boolean;
  result: PersistFileResult | null;
  active: boolean;
}) {
  // planEntryFor never produces an entry with nothing to write, so this always has
  // at least one field.
  const fields = fieldsFor(entry);

  return (
    <div className={`persist-entry${entry.stale ? ' stale' : ''}`}>
      <div className="persist-file">
        {showThumbnail && <img className="persist-thumb" src={`/api/files/${entry.fileId}/thumb`} alt="" loading="lazy" />}
        <span>
          {entry.relPath}
          {entry.stale && <em className="weak"> · changed on disk</em>}
        </span>
      </div>
      <div className="persist-fields">
        {fields.map((field) => (
          <div className="persist-field-row" key={field.key}>
            <span className="persist-label">{field.label}</span>
            <span className="persist-value">{rawExif ? rawValue(entry, field.key, field.old) : field.old}</span>
            <span className="persist-value persist-value-new">
              → {rawExif ? rawValue(entry, field.key, field.next) : field.next}
            </span>
          </div>
        ))}
      </div>
      <div className="persist-status">{active ? <em className="weak">writing…</em> : <Status result={result} />}</div>
    </div>
  );
}

function Status({ result }: { result: PersistFileResult | null }) {
  if (result === null) return null;
  if (result.skipped) return <span className="weak" title={result.reason ?? undefined}>⊘</span>;
  if (!result.ok) return <span className="error" title={result.reason ?? undefined}>✗ {result.reason}</span>;
  return <span className="persist-ok">✓</span>;
}

function formatPosition(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '—';
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function formatLocalIso(iso: string | null): string {
  return iso === null ? '—' : iso.replace('T', ' ');
}

function formatOffsetValue(minutes: number | null): string {
  return minutes === null ? '—' : formatUtcOffset(minutes);
}

/** The literal tag values ExifTool will write, for the raw-EXIF toggle (SPEC §9.1). */
function rawValue(entry: PersistPlanEntry, field: string, humanValue: string): string {
  if (humanValue === '—') return '—';
  if (field === 'timestamp') {
    const iso = humanValue.replace(' ', 'T');
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
    return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}` : humanValue;
  }
  if (field === 'position') {
    const isOld = humanValue === formatPosition(entry.oldLat, entry.oldLon);
    const lat = isOld ? entry.oldLat : entry.newLat;
    const lon = isOld ? entry.oldLon : entry.newLon;
    if (lat === null || lon === null) return '—';
    const latRef = lat >= 0 ? 'N' : 'S';
    const lonRef = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat)}${latRef}, ${Math.abs(lon)}${lonRef}`;
  }
  return humanValue;
}
