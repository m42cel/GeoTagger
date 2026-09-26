import path from 'node:path';
import type { ScanStatus, ScanSummary } from '@geotagger/shared';
import type { Config } from '../config.js';
import type { FolderStore } from '../db/store.js';
import { metadataFromTags, readRawTags } from '../metadata/reader.js';
import { generateThumb, thumbExists } from '../thumbs/generator.js';
import { walkMedia } from './walker.js';
import { runPool } from './pool.js';

export function idleScanStatus(): ScanStatus {
  return {
    phase: 'idle',
    discovered: 0,
    processed: 0,
    queued: 0,
    thumbsDone: 0,
    thumbsQueued: 0,
    currentPath: null,
    error: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * The scanning pipeline of SPEC §10.1: walk, diff against the index, read metadata
 * for what changed, then generate thumbnails in the background.
 *
 * The scan is incremental — an unchanged file costs a `stat` and nothing more — and
 * reports progress throughout, because the UI blocks on it until it settles (SPEC §2
 * "Target scale") and the user needs to see it moving.
 */
export class Scanner {
  private status: ScanStatus = idleScanStatus();
  private cancelled = false;
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<(s: ScanStatus) => void>();

  constructor(
    private readonly store: FolderStore,
    private readonly folderPath: string,
    private readonly config: Config,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {}

  getStatus(): ScanStatus {
    return { ...this.status };
  }

  onChange(listener: (s: ScanStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<ScanStatus>): void {
    this.status = { ...this.status, ...patch };
    const snapshot = this.getStatus();
    for (const l of this.listeners) l(snapshot);
  }

  /** Starts a scan, or returns the one already in flight. */
  start(): Promise<void> {
    if (this.running) return this.running;
    this.cancelled = false;
    this.running = this.run()
      .catch((err: unknown) => {
        this.log('scan failed', err);
        this.emit({
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private async run(): Promise<void> {
    this.emit({
      ...idleScanStatus(),
      phase: 'walking',
      startedAt: Date.now(),
    });

    const now = Date.now();
    const summary: ScanSummary = { known: 0, added: 0, changed: 0, missing: 0 };
    const seenIds: number[] = [];
    const needMetadata: { id: number; relPath: string }[] = [];

    for (const scanned of walkMedia(this.folderPath)) {
      if (this.cancelled) return this.finish(summary);
      const { id, change } = this.store.upsertScanned(scanned, now);
      seenIds.push(id);
      if (change === 'added') summary.added += 1;
      else if (change === 'changed') summary.changed += 1;
      else summary.known += 1;
      if (change !== 'unchanged') needMetadata.push({ id, relPath: scanned.relPath });
      this.emit({ discovered: seenIds.length, currentPath: scanned.relPath });
    }

    summary.missing = this.store.markMissingExcept(seenIds);

    this.emit({
      phase: 'reading-metadata',
      queued: needMetadata.length,
      processed: 0,
      summary: { ...summary },
      currentPath: null,
    });

    let processed = 0;
    await runPool(
      needMetadata,
      this.config.scanConcurrency,
      async (item) => {
        try {
          const file = this.store.getFile(item.id);
          if (!file) return;
          const abs = path.join(this.folderPath, item.relPath);
          const tags = await readRawTags(abs, file.kind);
          const { metadata, device } = metadataFromTags(tags, file.filename);
          this.store.applyScanResult(item.id, metadata, device);
        } catch (err) {
          // One unreadable file must not abort a 5,000-file scan; it stays in the
          // index with source 'none' and shows as undated in the UI.
          this.log(`metadata read failed: ${item.relPath}`, err);
        } finally {
          processed += 1;
          this.emit({ processed, currentPath: item.relPath });
        }
      },
      () => this.cancelled,
    );

    if (this.cancelled) return this.finish(summary);

    await this.generateThumbnails();
    this.finish(summary);
  }

  /** Eagerly fills the 160 px tier; previews are rendered on demand. */
  private async generateThumbnails(): Promise<void> {
    const pending = this.store
      .pendingThumbIds()
      .filter((id) => !thumbExists(this.store.thumbsDir, id, 'thumb'));

    this.emit({ phase: 'thumbnails', thumbsQueued: pending.length, thumbsDone: 0, currentPath: null });

    let done = 0;
    await runPool(
      pending,
      this.config.scanConcurrency,
      async (id) => {
        let relPath = '';
        try {
          const file = this.store.getFile(id);
          if (!file) return;
          relPath = file.relPath;
          await generateThumb(path.join(this.folderPath, file.relPath), file, this.store.thumbsDir, 'thumb');
          this.store.setThumbState(id, 'ready');
        } catch (err) {
          // Covers both an undecodable file and the store being closed out from
          // under an in-flight worker when the user opens another folder.
          this.log(`thumbnail failed: ${relPath || id}`, err);
          try {
            this.store.setThumbState(id, 'failed');
          } catch {
            /* store already closed */
          }
        } finally {
          done += 1;
          this.emit({ thumbsDone: done, currentPath: relPath });
        }
      },
      () => this.cancelled,
    );
  }

  private finish(summary: ScanSummary): void {
    this.emit({
      phase: this.cancelled ? 'idle' : 'done',
      summary,
      currentPath: null,
      finishedAt: Date.now(),
    });
  }
}
