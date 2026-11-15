import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeUsageReader,
  isFresh,
  parseClaudeUsage,
  readClaudeUsage,
} from '../electron/claudeUsage';
import { cleanupTempDirs, tempDir } from './helpers';

const FETCHED = Date.parse('2026-11-10T12:00:00.250Z');

/** A config file shaped like the one Claude Code writes, with made-up account details. */
function config(fiveHour: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    numStartups: 12,
    oauthAccount: { emailAddress: 'alex@example.com', accountUuid: 'not-a-real-account' },
    primaryApiKey: 'sk-ant-not-a-real-key',
    projects: { '/Users/alex/dev/demo-app': { history: ['some prompt'] } },
    cachedUsageUtilization: {
      fetchedAtMs: FETCHED,
      accountUuid: 'not-a-real-account',
      utilization: {
        five_hour: {
          utilization: 22,
          resets_at: '2026-11-10T15:30:00.123456+00:00',
          limit_dollars: null,
          used_dollars: null,
          ...fiveHour,
        },
        seven_day: { utilization: 52, resets_at: '2026-11-14T09:00:00.000000+00:00' },
      },
    },
    ...extra,
  };
}

afterEach(() => {
  cleanupTempDirs();
  vi.restoreAllMocks();
});

describe('parseClaudeUsage', () => {
  it('keeps only the 5-hour %, its reset time and when it was fetched', () => {
    const usage = parseClaudeUsage(config());
    expect(usage).toEqual({
      fetchedAt: FETCHED,
      percent: 22,
      resetsAt: Date.parse('2026-11-10T15:30:00.123Z'),
    });
    expect(Object.keys(usage ?? {}).sort()).toEqual(['fetchedAt', 'percent', 'resetsAt']);
    expect(JSON.stringify(usage)).not.toMatch(/alex|sk-ant|account|prompt/);
  });

  it('reads a reset time given as Unix seconds or milliseconds', () => {
    const seconds = Date.parse('2026-11-10T15:30:00Z') / 1000;
    expect(parseClaudeUsage(config({ resets_at: seconds }))?.resetsAt).toBe(seconds * 1000);
    expect(parseClaudeUsage(config({ resets_at: seconds * 1000 }))?.resetsAt).toBe(seconds * 1000);
  });

  it('caps the % at 100', () => {
    expect(parseClaudeUsage(config({ utilization: 130 }))?.percent).toBe(100);
    expect(parseClaudeUsage(config({ utilization: 0 }))?.percent).toBe(0);
  });

  it('gives null for anything not in the expected format', () => {
    const cases: unknown[] = [
      null,
      [],
      'text',
      {},
      { cachedUsageUtilization: null },
      { cachedUsageUtilization: [] },
      { cachedUsageUtilization: { fetchedAtMs: FETCHED, utilization: { five_hour: null } } },
      config({ utilization: '22' }),
      config({ utilization: -1 }),
      config({ utilization: Number.NaN }),
      config({ resets_at: 'soon' }),
      config({ resets_at: null }),
      config({ resets_at: 'x'.repeat(100) }),
      config({ resets_at: '1999-01-01T00:00:00Z' }),
    ];
    for (const fetchedAtMs of ['yesterday', undefined, 0]) {
      const value = config();
      Object.assign(value.cachedUsageUtilization, { fetchedAtMs });
      cases.push(value);
    }
    for (const value of cases) expect(parseClaudeUsage(value)).toBeNull();
  });

  it('ignores numbers fetched for another account than the signed-in one', () => {
    const other = config();
    other.oauthAccount = { emailAddress: 'alex@example.com', accountUuid: 'another-account' };
    expect(parseClaudeUsage(other)).toBeNull();
    // Without the signed-in account's id, the numbers are kept.
    const unknown: Record<string, unknown> = config();
    delete unknown.oauthAccount;
    expect(parseClaudeUsage(unknown)?.percent).toBe(22);
  });

  it('never reads inherited properties', () => {
    // JSON.parse makes "__proto__" an own key; a prototype member must not count.
    const parsed: unknown = JSON.parse('{"__proto__": {"cachedUsageUtilization": 1}}');
    expect(parseClaudeUsage(parsed)).toBeNull();
    const inherited = Object.create({ cachedUsageUtilization: config().cachedUsageUtilization });
    expect(parseClaudeUsage(inherited)).toBeNull();
  });
});

describe('isFresh', () => {
  const usage = { fetchedAt: FETCHED, percent: 22, resetsAt: FETCHED + 3 * 3_600_000 };

  it('is fresh until the reset', () => {
    expect(isFresh(usage, FETCHED)).toBe(true);
    expect(isFresh(usage, usage.resetsAt - 1)).toBe(true);
    expect(isFresh(usage, usage.resetsAt)).toBe(false);
  });

  it('is not fresh when fetched before the window or in the future', () => {
    expect(isFresh({ ...usage, fetchedAt: usage.resetsAt - 5 * 3_600_000 }, FETCHED)).toBe(false);
    expect(isFresh(usage, FETCHED - 2 * 60_000)).toBe(false);
  });
});

describe('readClaudeUsage', () => {
  function write(content: string): string {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, content);
    return file;
  }

  it('reads the numbers from the file', async () => {
    expect(await readClaudeUsage(write(JSON.stringify(config())))).toEqual({
      state: 'found',
      usage: parseClaudeUsage(config()),
    });
    // With a byte order mark.
    const bom = String.fromCharCode(0xfeff);
    expect((await readClaudeUsage(write(bom + JSON.stringify(config())))).state).toBe('found');
  });

  it('says when the file is missing, has no numbers or cannot be read, without logging', async () => {
    const logs = ['log', 'warn', 'error', 'info', 'debug'].map((name) =>
      vi.spyOn(console, name as 'log').mockImplementation(() => undefined),
    );
    const folder = tempDir();
    expect(await readClaudeUsage(path.join(folder, 'missing.json'))).toEqual({
      state: 'missing',
      usage: null,
    });
    expect((await readClaudeUsage(write('{"numStartups": 3}'))).state).toBe('noData');
    const broken = await readClaudeUsage(write('{"primaryApiKey": "sk-ant-secret", oops'));
    expect(broken).toEqual({ state: 'unreadable', usage: null });
    expect(JSON.stringify(broken)).not.toContain('sk-ant');
    // A folder where the file should be.
    expect((await readClaudeUsage(folder)).state).toBe('unreadable');
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('does not read a file over the size limit', async () => {
    const file = write(JSON.stringify(config()));
    expect((await readClaudeUsage(file, 100)).state).toBe('unreadable');
  });
});

describe('ClaudeUsageReader', () => {
  it('reads the file again only when it changed', async () => {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, JSON.stringify(config()));
    const reader = new ClaudeUsageReader(() => file);
    const open = vi.spyOn(fs.promises, 'open');

    expect((await reader.read()).usage?.percent).toBe(22);
    expect((await reader.read()).usage?.percent).toBe(22);
    expect(open).toHaveBeenCalledTimes(1);

    fs.writeFileSync(file, JSON.stringify(config({ utilization: 35 }), null, 2));
    expect((await reader.read()).usage?.percent).toBe(35);
    expect(open).toHaveBeenCalledTimes(2);

    fs.rmSync(file);
    expect(await reader.read()).toEqual({ state: 'missing', usage: null });
  });

  it('does not wait on a read that hangs', async () => {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, JSON.stringify(config()));
    const reader = new ClaudeUsageReader(() => file, 50);
    vi.spyOn(fs.promises, 'open').mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await reader.read()).toEqual({ state: 'unreadable', usage: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Still stuck: answered at once.
    const again = Date.now();
    expect((await reader.read()).state).toBe('unreadable');
    expect(Date.now() - again).toBeLessThan(40);
  });

  it('does not keep a read that finishes after forget', async () => {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, JSON.stringify(config()));
    const reader = new ClaudeUsageReader(() => file);
    const realOpen = fs.promises.open.bind(fs.promises);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = vi
      .spyOn(fs.promises, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        await gate;
        return realOpen(...args);
      });
    const first = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reader.forget();
    release();
    expect((await first).usage?.percent).toBe(22);
    // Nothing was kept: the next read opens the file again.
    await reader.read();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('shares one read between calls made at the same time', async () => {
    const file = path.join(tempDir(), '.claude.json');
    fs.writeFileSync(file, JSON.stringify(config()));
    const reader = new ClaudeUsageReader(() => file);
    const open = vi.spyOn(fs.promises, 'open');
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
