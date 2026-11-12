import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer, isWatchedFile, LogWatcher, sameFolders } from '../electron/watcher';
import { cleanupTempDirs, tempDir } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  cleanupTempDirs();
});

describe('createDebouncer', () => {
  it('runs once after a quiet moment', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 2_000, 10_000);

    debouncer.trigger();
    vi.advanceTimersByTime(1_500);
    debouncer.trigger();
    vi.advanceTimersByTime(1_500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('still runs during a long burst of changes', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 2_000, 10_000);

    for (let elapsed = 0; elapsed < 25_000; elapsed += 1_000) {
      debouncer.trigger();
      vi.advanceTimersByTime(1_000);
    }
    // At 10 s and 20 s, then once more 2 s after the burst ends.
    expect(callback).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debouncer = createDebouncer(callback, 2_000, 10_000);
    debouncer.trigger();
    debouncer.cancel();
    vi.advanceTimersByTime(20_000);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('LogWatcher', () => {
  it('only cares about transcripts and subagent meta files', () => {
    expect(isWatchedFile('/p/-Users-alex-app/abc.jsonl')).toBe(true);
    expect(isWatchedFile('C:\\p\\x\\subagents\\agent-1.meta.json')).toBe(true);
    expect(isWatchedFile('/p/x/abc/tool-results/toolu_1.txt')).toBe(false);
    expect(isWatchedFile('/p/x/settings.json')).toBe(false);
  });

  it('compares folder sets in any order', () => {
    expect(sameFolders(['/a', '/b'], ['/b', '/a'])).toBe(true);
    expect(sameFolders(['/a'], ['/a', '/b'])).toBe(false);
  });

  it(
    'calls back after a transcript is written, also in a new subfolder',
    { retry: 2, timeout: 20_000 },
    async () => {
      const root = path.join(tempDir(), 'projects');
      fs.mkdirSync(path.join(root, '-Users-alex-dev-app'), { recursive: true });
      let calls = 0;
      const watcher = new LogWatcher(() => calls++, { debounceMs: 100, maxWaitMs: 1_000 });
      try {
        await watcher.watch([root]);
        expect(watcher.watchedRoots).toEqual([root]);

        const waitForCall = async (expected: number) => {
          const deadline = Date.now() + 8_000;
          while (calls < expected && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(calls).toBeGreaterThanOrEqual(expected);
        };

        fs.writeFileSync(path.join(root, '-Users-alex-dev-app', 'one.jsonl'), '{}\n');
        await waitForCall(1);

        const subagents = path.join(root, '-Users-alex-dev-app', 'one', 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        // Give the watcher a moment to pick up the new folder before writing in it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const before = calls;
        fs.writeFileSync(path.join(subagents, 'agent-1.jsonl'), '{}\n');
        await waitForCall(before + 1);

        // Other files do not count.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const settled = calls;
        fs.writeFileSync(path.join(root, '-Users-alex-dev-app', 'notes.txt'), 'x');
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(calls).toBe(settled);
      } finally {
        await watcher.close();
      }
      expect(watcher.watchedRoots).toEqual([]);
    },
  );
});
