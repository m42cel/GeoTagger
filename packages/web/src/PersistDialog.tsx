import { useEffect, useState } from 'react';
import type {
  PersistFieldChange,
  PersistFileResult,
  PersistPlan,
  PersistPlanEntry,
  PersistProgress,
  StalePolicy,
} from '@geotagger/shared';
import { formatUtcOffset, kindForExtension } from '@geotagger/shared';
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
  const changeCount = (plan?.entries ?? []).reduce((n, e) => n + fieldsFor(e, showRawExif).length, 0);

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
              <div className="persist-table-scroll">
                <table className="persist-table">
                  <colgroup>
                    <col className="persist-col-file" />
                    <col className="persist-col-tag" />
                    <col className="persist-col-value" />
                    <col className="persist-col-value" />
                    <col className="persist-col-status" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th></th>
                      <th>tag</th>
                      <th>old</th>
                      <th>new</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.entries.map((entry) => (
                      <EntryRows
                        key={entry.fileId}
                        entry={entry}
                        showThumbnail={showThumbnails}
                        rawExif={showRawExif}
                        result={resultByFileId.get(entry.fileId) ?? null}
                        active={progress !== null && !done && progress.currentPath === entry.relPath}
                      />
                    ))}
                  </tbody>
                </table>
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

/**
 * One row of a file's changes. The two modes produce disjoint sets of rows, so `label` is
 * whatever that mode names the row by: the tag in raw mode, the field in the readable one.
 */
interface Field {
  key: string;
  label: string;
  old: string;
  next: string;
}

/**
 * The rows for one file (SPEC §9.1).
 *
 * The two modes are two views of the same plan entry, not two computations: the
 * human-readable one shows the entry's per-field changes in the app's own units, the raw
 * one shows every tag the write touches, which is what the entry's `changes` already are.
 * The `geotagger:Original*` a first write preserves are raw-mode only — they mean nothing
 * in a view that talks about positions and timestamps.
 */
function fieldsFor(entry: PersistPlanEntry, rawExif: boolean): Field[] {
  if (!rawExif) return entry.fields.map(readableField);

  const rows = entry.changes.map((change) => ({
    key: `tag-${change.tag}`,
    label: change.tag,
    old: change.old ?? NA,
    next: change.next,
  }));

  return [...rows, ...originalRows(entry)];
}

/** One field's change as the app talks about it, rather than as its tags hold it. */
function readableField(change: PersistFieldChange): Field {
  if (change.field === 'timestamp') {
    return {
      key: 'timestamp',
      label: 'timestamp',
      old: formatLocalIso(change.oldLocalIso),
      next: formatLocalIso(change.newLocalIso),
    };
  }
  if (change.field === 'utcOffset') {
    return {
      key: 'utc-offset',
      label: 'UTC offset',
      old: formatOffsetValue(change.oldMinutes),
      next: formatOffsetValue(change.newMinutes),
    };
  }
  return {
    key: 'position',
    label: 'position',
    old: formatPosition(change.oldLat, change.oldLon),
    next: formatPosition(change.newLat, change.newLon),
  };
}

/** No such tag, on either side of a row: nothing there before, or nothing left after. */
const NA = '—';
/** The literal value the `geotagger` block uses for a tag the file did not have. */
const ABSENT = 'n/a';

/**
 * The `geotagger:Original*` tags this write preserves (SPEC §9.3).
 *
 * One per tag being written for the first time, holding what that tag says now — or `n/a`
 * when it says nothing at all. A tag GeoTagger has written before is absent from these
 * rows, because its original was preserved once and is never touched again.
 */
function originalRows(entry: PersistPlanEntry): Field[] {
  return entry.changes
    .filter((change) => change.stampsOriginal)
    .map((change) => ({
      key: `original-${change.tag}`,
      label: `geotagger:Original${originalNameFor(change.tag)}`,
      old: NA,
      next: change.old ?? ABSENT,
    }));
}

/**
 * The `Original*` name for a tag, mirroring the writer's own table: the bare tag name,
 * except that an `XMP:GPS*` tag keeps its group to stay distinct from the EXIF pair.
 */
function originalNameFor(tag: string): string {
  const [group, name] = tag.split(':');
  return group === 'XMP' ? `XMP${name}` : (name as string);
}

/**
 * One file's rows: thumbnail and filename in a cell spanning the full height of
 * however many fields it changes, then one row per field — the changed tag, the old
 * value, the new value (SPEC §9.1's "not a header row printed above them"). The
 * filename cell's content is a plain inline-flex `<span>`, not the `<td>` itself,
 * because overriding a table cell's own `display` breaks its participation in the
 * table's row/column grid — that was what sent a second field's row sliding under the
 * filename column before.
 */
function EntryRows({
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
  const fields = fieldsFor(entry, rawExif);

  return (
    <>
      {fields.map((field, i) => (
        <tr key={field.key} className={entry.stale ? 'stale' : undefined}>
          {i === 0 && (
            <td className="persist-file" rowSpan={fields.length}>
              <span className="persist-file-inner">
                {showThumbnail && <img className="persist-thumb" src={`/api/files/${entry.fileId}/thumb`} alt="" loading="lazy" />}
                <span>
                  {entry.relPath}
                  {entry.stale && <em className="weak"> · changed on disk</em>}
                </span>
              </span>
            </td>
          )}
          <td className="persist-label">{field.label}</td>
          <td className="persist-value">{field.old}</td>
          <td className="persist-value persist-value-new">{field.next}</td>
          {i === 0 && (
            <td className="persist-status" rowSpan={fields.length}>
              {active ? <em className="weak">writing…</em> : <Status result={result} />}
            </td>
          )}
        </tr>
      ))}
    </>
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
