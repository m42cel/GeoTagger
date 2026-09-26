import path from 'node:path';
import fs from 'node:fs';
import type { GroupingMode, SessionState } from '@geotagger/shared';
import type { Config } from './config.js';
import { FolderStore } from './db/store.js';
import { Scanner } from './scan/scanner.js';
import { pruneStaleThumbTiers } from './thumbs/generator.js';
import { StripService } from './strips/service.js';
import { PositionService } from './positions/service.js';
import { resolveWithinRoot, toRelPath } from './paths.js';

export type Logger = (msg: string, err?: unknown) => void;

/**
 * One open photo folder: its store, its scanner and its strips.
 *
 * The application is single-user on a home network (SPEC §2), so exactly one folder
 * is open at a time and the session is a singleton rather than a keyed map.
 */
export class Session {
  readonly store: FolderStore;
  readonly scanner: Scanner;
  readonly strips: StripService;
  readonly positions: PositionService;
  readonly absPath: string;
  readonly relPath: string;

  private constructor(absPath: string, relPath: string, store: FolderStore, config: Config, log: Logger) {
    this.absPath = absPath;
    this.relPath = relPath;
    this.store = store;
    this.scanner = new Scanner(store, absPath, config, log);
    this.strips = new StripService(store);
    this.positions = new PositionService(store, this.strips);
  }

  static open(config: Config, relPath: string, log: Logger): Session {
    const absPath = resolveWithinRoot(config.photoRoot, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      throw new Error(`Not a folder: ${relPath}`);
    }
    const store = FolderStore.open(absPath);
    // Opening is the one moment this is free: the cache is about to be read from.
    pruneStaleThumbTiers(store.thumbsDir);
    return new Session(absPath, toRelPath(config.photoRoot, absPath), store, config, log);
  }

  state(): SessionState {
    return {
      relPath: this.relPath,
      absPath: this.absPath,
      folderId: this.store.folderId,
      fileCount: this.store.fileCount(),
      groupingMode: this.store.groupingMode,
      groupingQuestionPending: !this.store.groupingModeAnswered,
      timestampQuestionPending: !this.store.timestampQuestionAnswered,
      scan: this.scanner.getStatus(),
    };
  }

  regroup(mode: GroupingMode): void {
    this.strips.regroup(mode);
  }

  /**
   * Brings strips up to date after a scan, unless grouping is manual — rebuilding
   * there would throw away the strips the user built by hand.
   *
   * A rebuild is needed not only for files that have no strip yet, but also when a
   * file *changed*: its capture time may have moved, and strips are ordered by their
   * first capture, so a stale set would show the wrong lane order.
   *
   * Nothing is built here until the user has answered the initial grouping question
   * (SPEC §4.4) — that answer is what picks device or subfolder in the first place,
   * so building strips ahead of it would just be guessing and then discarding the
   * guess the moment they answer.
   */
  regroupIfNeeded(): void {
    const files = this.store.listFiles();
    // The periods of SPEC §4.2 come from the files that know their own offset, so
    // they can only change when the set of files does — recomputing them here rather
    // than per request keeps a timezone lookup off the read path.
    this.strips.refreshUtcOffsetRules(files);

    if (!this.store.groupingModeAnswered) return;
    const mode = this.store.groupingMode;
    if (mode === 'manual') return;
    const summary = this.scanner.getStatus().summary;
    const contentMoved = summary !== null && (summary.added > 0 || summary.changed > 0 || summary.missing > 0);
    if (this.store.listStrips().length === 0 || this.store.unassignedFileIds().length > 0 || contentMoved) {
      this.strips.rebuildAfterScan(mode);
    }
  }

  absPathFor(relPath: string): string {
    return path.join(this.absPath, relPath);
  }

  close(): void {
    this.scanner.cancel();
    this.store.close();
  }
}

/** Holds the single open session and the recent-folders list. */
export class SessionManager {
  private current: Session | null = null;

  constructor(private readonly config: Config, private readonly log: Logger) {}

  get(): Session | null {
    return this.current;
  }

  require(): Session {
    if (!this.current) throw new NoSessionError();
    return this.current;
  }

  /** Opens the new folder before closing the old one, so a failure leaves the current session intact. */
  open(relPath: string): Session {
    const next = Session.open(this.config, relPath, this.log);
    this.current?.close();
    this.current = next;
    this.rememberRecent(next);
    return next;
  }

  /** True while `session` is still the open one — false once another folder replaced it. */
  isCurrent(session: Session): boolean {
    return this.current === session;
  }

  closeAll(): void {
    this.current?.close();
    this.current = null;
  }

  // ---- recent folders ----------------------------------------------------

  private recentPath(): string {
    return path.join(this.config.stateDir, 'recent-folders.json');
  }

  listRecent(): { relPath: string; lastOpenedAt: number; fileCount: number }[] {
    try {
      const raw = fs.readFileSync(this.recentPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecentEntry).filter((e) => {
        // A folder that has been moved or unmounted should not be offered.
        try {
          return fs.existsSync(resolveWithinRoot(this.config.photoRoot, e.relPath));
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * Records a folder in the recent list.
   *
   * Called once when the folder opens, so it is offered again even if the scan is
   * interrupted, and once more when the scan settles — at open time the file count is
   * still whatever the last visit left behind, and zero for a folder never scanned.
   */
  rememberRecent(session: Session): void {
    const entry = {
      relPath: session.relPath,
      lastOpenedAt: Date.now(),
      fileCount: session.store.fileCount(),
    };
    const kept = this.listRecent().filter((e) => e.relPath !== entry.relPath);
    const next = [entry, ...kept].slice(0, 12);
    try {
      fs.mkdirSync(this.config.stateDir, { recursive: true });
      fs.writeFileSync(this.recentPath(), JSON.stringify(next, null, 2));
    } catch (err) {
      // A read-only state directory costs the user their recents list and nothing
      // more, so it must not stop the folder from opening.
      this.log('could not write recent-folders list', err);
    }
  }
}

function isRecentEntry(v: unknown): v is { relPath: string; lastOpenedAt: number; fileCount: number } {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as { relPath?: unknown }).relPath === 'string' &&
    typeof (v as { lastOpenedAt?: unknown }).lastOpenedAt === 'number'
  );
}

export class NoSessionError extends Error {
  constructor() {
    super('No folder is open');
    this.name = 'NoSessionError';
  }
}
