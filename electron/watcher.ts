/**
 * Watches the Claude Code `projects` folders and calls back once the transcripts stop
 * changing for a moment, so the app can read what is new.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import type { Stats } from 'node:fs';
import { samePath } from './paths';

/** Quiet time after the last change before the callback runs. */
export const WATCH_DEBOUNCE_MS = 2_000;
/**
 * Claude Code appends to a transcript every few seconds while it works, so changes can
 * keep coming for minutes. The callback still runs at least this often during such a run.
 */
export const WATCH_MAX_WAIT_MS = 10_000;

export interface Debouncer {
  trigger(): void;
  cancel(): void;
}

/**
 * Runs `callback` once `waitMs` have passed without a new trigger, and no later than
 * `maxWaitMs` after the first trigger of a burst.
 */
export function createDebouncer(
  callback: () => void,
  waitMs: number,
  maxWaitMs: number,
): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStart: number | null = null;

  const fire = () => {
    timer = null;
    burstStart = null;
    callback();
  };

  return {
    trigger() {
      const now = Date.now();
      burstStart ??= now;
      if (timer) clearTimeout(timer);
      const delay = Math.max(0, Math.min(waitMs, burstStart + maxWaitMs - now));
      timer = setTimeout(fire, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      burstStart = null;
    },
  };
}

/** Transcripts and the meta files of subagents; the other files of a session folder do not matter. */
export function isWatchedFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.jsonl') || lower.endsWith('.meta.json');
}

export interface LogWatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  onError?: (error: unknown) => void;
}

export class LogWatcher {
  private watcher: FSWatcher | null = null;
  private roots: string[] = [];
  private readonly debouncer: Debouncer;
  private readonly onError: (error: unknown) => void;

  constructor(onChange: () => void, options: LogWatcherOptions = {}) {
    this.debouncer = createDebouncer(
      onChange,
      options.debounceMs ?? WATCH_DEBOUNCE_MS,
      options.maxWaitMs ?? WATCH_MAX_WAIT_MS,
    );
    this.onError = options.onError ?? (() => {});
  }

  get watchedRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Watches exactly these folders, recursively. Nothing happens when they are the ones
   * already watched. Resolves once the folders are being watched.
   */
  async watch(roots: readonly string[]): Promise<void> {
    if (this.watcher && sameFolders(roots, this.roots)) return;
    await this.close();
    this.roots = [...roots];
    if (roots.length === 0) return;

    const watcher = chokidar.watch([...roots], {
      ignoreInitial: true,
      // Folders are always followed, so new session and `subagents/` folders are seen.
      ignored: (filePath: string, stats?: Stats) =>
        stats?.isFile() === true && !isWatchedFile(filePath),
      followSymlinks: false,
    });
    this.watcher = watcher;
    const changed = (filePath: string) => {
      if (isWatchedFile(filePath)) this.debouncer.trigger();
    };
    watcher.on('add', changed);
    watcher.on('change', changed);
    watcher.on('error', (error) => this.onError(error));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  }

  async close(): Promise<void> {
    this.debouncer.cancel();
    const watcher = this.watcher;
    this.watcher = null;
    this.roots = [];
    if (watcher) await watcher.close();
  }
}

export function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((root) => b.some((other) => samePath(root, other)));
}
