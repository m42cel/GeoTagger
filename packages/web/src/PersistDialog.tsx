import { useEffect, useState } from 'react';
import type { PersistFileResult, PersistPlan, PersistPlanEntry, PersistProgress, StalePolicy } from '@geotagger/shared';
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

interface Field {
  key: string;
  label: string;
  rawLabel: string;
  old: string;
  next: string;
}

/**
 * One row per field a file actually changes (SPEC §9.1) — position, timestamp, UTC
 * offset. In raw-EXIF mode, latitude and longitude split into their own rows (they're
 * separate tags for a photo), and the `geotagger:Original*` preservation tags this
 * write would stamp or clear (SPEC §9.3) are appended too — both are specific to raw
 * mode, since neither means anything in the human-readable view.
 */
function fieldsFor(entry: PersistPlanEntry, rawExif: boolean): Field[] {
  const kind = kindForExtension(entry.relPath.split('.').pop() ?? '') ?? 'image';
  const fields: Field[] = [];

  if (entry.positionKind !== 'none') {
    if (rawExif && kind === 'image') {
      fields.push(
        { key: 'position-lat', label: 'position', rawLabel: 'EXIF:GPSLatitude', old: rawLat(entry.oldLat), next: rawLat(entry.newLat) },
        { key: 'position-lon', label: 'position', rawLabel: 'EXIF:GPSLongitude', old: rawLon(entry.oldLon), next: rawLon(entry.newLon) },
      );
    } else {
      fields.push({
        key: 'position',
        label: 'position',
        rawLabel: kind === 'video' ? 'QuickTime:GPSCoordinates' : 'EXIF:GPSLatitude/GPSLongitude',
        old: formatPosition(entry.oldLat, entry.oldLon),
        next: formatPosition(entry.newLat, entry.newLon),
      });
    }
  }

  if (entry.timeKind !== 'none') {
    fields.push({
      key: 'timestamp',
      label: 'timestamp',
      rawLabel: kind === 'video' ? 'QuickTime:CreateDate' : 'EXIF:DateTimeOriginal',
      old: rawExif ? rawExifDate(entry.oldLocalIso) : formatLocalIso(entry.oldLocalIso),
      next: rawExif ? rawExifDate(entry.newLocalIso) : formatLocalIso(entry.newLocalIso),
    });
  }

  if (entry.writesUtcOffset) {
    fields.push({
      key: 'utc-offset',
      label: 'UTC offset',
      rawLabel: 'EXIF:OffsetTimeOriginal',
      old: formatOffsetValue(entry.oldUtcOffsetMinutes),
      next: formatOffsetValue(entry.utcOffsetMinutes),
    });
  }

  if (rawExif) fields.push(...geotaggerFieldsFor(entry));

  return fields;
}

/** No such tag, on either side of a row: nothing there before, or nothing left after. */
const NA = '—';
/** The literal value the `geotagger` block uses for a tag the file did not have. */
const ABSENT = 'n/a';

/**
 * The `geotagger:Original*` preservation tags (SPEC §9.3): stamped once, the first time
 * a half is ever written, with what the file currently says. A later write touches none
 * of them — the preserved original doesn't change just because the edit did.
 *
 * Only the tags whose prior value the plan itself knows are listed. The write stamps one
 * `Original*` per tag it touches, including `EXIF:CreateDate` and the `XMP:GPS*` pair,
 * whose prior values are read from the file at write time.
 */
function geotaggerFieldsFor(entry: PersistPlanEntry): Field[] {
  const fields: Field[] = [];

  if (entry.stampsOriginalTime) {
    fields.push(
      {
        key: 'g-date',
        label: 'original date',
        rawLabel: 'geotagger:OriginalDateTimeOriginal',
        old: NA,
        next: entry.oldLocalIso === null ? ABSENT : rawExifDate(entry.oldLocalIso),
      },
      {
        key: 'g-offset',
        label: 'original offset',
        rawLabel: 'geotagger:OriginalOffsetTimeOriginal',
        old: NA,
        next: entry.oldUtcOffsetMinutes === null ? ABSENT : formatUtcOffset(entry.oldUtcOffsetMinutes),
      },
    );
  }

  if (entry.stampsOriginalPosition) {
    fields.push(
      { key: 'g-gpslat', label: 'original latitude', rawLabel: 'geotagger:OriginalGPSLatitude', old: NA, next: entry.oldLat === null ? ABSENT : String(entry.oldLat) },
      { key: 'g-gpslon', label: 'original longitude', rawLabel: 'geotagger:OriginalGPSLongitude', old: NA, next: entry.oldLon === null ? ABSENT : String(entry.oldLon) },
    );
  }

  return fields;
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
          <td className="persist-label">{rawExif ? field.rawLabel : field.label}</td>
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

/** `EXIF:GPSLatitude`/`GPSLongitude` are unsigned, with the sign carried by a separate ref tag. */
function rawLat(lat: number | null): string {
  return lat === null ? '—' : `${Math.abs(lat)} ${lat >= 0 ? 'N' : 'S'}`;
}

function rawLon(lon: number | null): string {
  return lon === null ? '—' : `${Math.abs(lon)} ${lon >= 0 ? 'E' : 'W'}`;
}

/** `2024-07-12T14:32:10` to the `2024:07:12 14:32:10` ExifTool writes. */
function rawExifDate(iso: string | null): string {
  if (iso === null) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}` : iso;
}
