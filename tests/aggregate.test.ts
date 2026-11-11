import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  comparePeriods,
  emptyOverview,
  getOverview,
  InvalidRequestError,
  parseFilters,
} from '../electron/aggregate';
import type { UsageDatabase } from '../electron/db';
import { scanLogs } from '../electron/scanner';
import type { Filters, Pricing } from '../shared/types';
import {
  assistantLine,
  cleanupTempDirs,
  fixtureRoot,
  MAC_FOLDER,
  openMemoryDb,
  SESSION_A,
  tempDir,
  writeLines,
} from './helpers';

const open: UsageDatabase[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

/** A database holding the macOS fixture, described at the top of scanner.test.ts. */
async function fixtureDb(timeZone = 'UTC'): Promise<UsageDatabase> {
  const db = openMemoryDb(timeZone);
  open.push(db);
  await scanLogs(db, [fixtureRoot('mac')]);
  return db;
}

const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
/** The same simple prices for the four models of the fixture. */
const PRICING: Pricing = {
  lastChecked: null,
  models: { 'Opus 5.5': flat, 'Sonnet 5.5': flat, 'Haiku 5.5': flat, 'Fable 5.2': flat },
};

const BOTH_DAYS: Filters = { from: '2026-11-09', to: '2026-11-10' };
const EVENING = Date.parse('2026-11-10T20:00:00Z');

describe('getOverview', () => {
  it('computes the KPI cards', async () => {
    const db = await fixtureDb();
    const { kpis, hasData } = getOverview(db, PRICING, BOTH_DAYS, EVENING);

    expect(hasData).toBe(true);
    expect(kpis.totalTokens).toBe(65134);
    // Total input is everything sent to Claude: input + cache write + cache read.
    expect(kpis.inputTokens).toBe(959 + 14400 + 49278);
    expect(kpis.outputTokens).toBe(497);
    expect(kpis.inputTokens + kpis.outputTokens).toBe(kpis.totalTokens);
    // Nothing happened in the two days before.
    expect(kpis.totalChange).toEqual({ kind: 'new' });
    expect(kpis.cost).toBeCloseTo((959 * 1 + 497 * 10 + 14400 * 2 + 49278 * 0.5) / 1e6, 12);
    expect(kpis.costIsPartial).toBe(false);
  });

  it('compares the total with the period just before', async () => {
    const db = await fixtureDb();
    const lastDay = getOverview(db, PRICING, { from: '2026-11-10', to: '2026-11-10' }, EVENING);
    expect(lastDay.kpis.totalTokens).toBe(60349 + 1110);
    // The day before had 6% of this day's usage: enough to compare with.
    const change = lastDay.kpis.totalChange;
    expect(change.kind).toBe('change');
    expect(change.kind === 'change' && change.ratio).toBeCloseTo((61459 - 3675) / 3675, 12);

    const dayBefore = getOverview(db, PRICING, { from: '2026-11-09', to: '2026-11-09' }, EVENING);
    expect(dayBefore.kpis.totalTokens).toBe(3675);
    expect(dayBefore.kpis.totalChange).toEqual({ kind: 'new' });

    // A day without usage after a day with some: a full drop.
    const after = getOverview(db, PRICING, { from: '2026-11-11', to: '2026-11-11' }, EVENING);
    expect(after.kpis.totalChange).toEqual({ kind: 'change', ratio: -1 });
  });

  it('calls a period new activity when the one before had under 5% of its usage', () => {
    expect(comparePeriods(1000, 0)).toEqual({ kind: 'new' });
    expect(comparePeriods(1000, 49)).toEqual({ kind: 'new' });
    expect(comparePeriods(1000, 50)).toEqual({ kind: 'change', ratio: 19 });
    expect(comparePeriods(1000, 1000)).toEqual({ kind: 'change', ratio: 0 });
    expect(comparePeriods(0, 500)).toEqual({ kind: 'change', ratio: -1 });
    expect(comparePeriods(0, 0)).toEqual({ kind: 'none' });
  });

  it('leaves models without a price out of the cost and says so', async () => {
    const db = await fixtureDb();
    const opusOnly: Pricing = { lastChecked: null, models: { 'Opus 5.5': flat } };
    const partial = getOverview(db, opusOnly, BOTH_DAYS, EVENING).kpis;
    // Opus 5.5 in the fixture: 725 input, 250 output, 1000 cache write, 27200 cache read.
    expect(partial.cost).toBeCloseTo((725 + 2500 + 2000 + 13600) / 1e6, 12);
    expect(partial.costIsPartial).toBe(true);

    const noPrices = getOverview(db, { lastChecked: null, models: {} }, BOTH_DAYS, EVENING).kpis;
    expect(noPrices.cost).toBeNull();
    expect(noPrices.costIsPartial).toBe(false);
  });

  it('prices 1-hour cache writes at the higher rate', async () => {
    const root = path.join(tempDir(), 'projects');
    writeLines(path.join(root, MAC_FOLDER, `${SESSION_A}.jsonl`), [
      assistantLine({ id: 'a', u: [0, 0, 1_000_000, 0], cache1h: 1_000_000 }),
      assistantLine({ id: 'b', u: [0, 0, 1_000_000, 0], cache1h: 250_000 }),
      assistantLine({ id: 'c', u: [0, 0, 1_000_000, 0] }),
    ]);
    const db = openMemoryDb();
    open.push(db);
    await scanLogs(db, [root]);
    const { kpis } = getOverview(db, PRICING, { from: '2026-11-10', to: '2026-11-10' }, EVENING);
    expect(kpis.totalTokens).toBe(3_000_000);
    expect(kpis.cost).toBeCloseTo(4 + (0.25 * 4 + 0.75 * 2) + 2, 12);
  });

  it('returns one point per day, with zeros for the days without usage', async () => {
    const db = await fixtureDb();
    const { daily } = getOverview(db, PRICING, { from: '2026-11-07', to: '2026-11-11' }, EVENING);
    expect(daily).toEqual([
      { day: '2026-11-07', input: 0, output: 0, subagent: 0 },
      { day: '2026-11-08', input: 0, output: 0, subagent: 0 },
      { day: '2026-11-09', input: 3602, output: 73, subagent: 1425 },
      { day: '2026-11-10', input: 61035, output: 424, subagent: 44894 },
      { day: '2026-11-11', input: 0, output: 0, subagent: 0 },
    ]);

    const month = getOverview(db, PRICING, { from: '2026-10-12', to: '2026-11-10' }, EVENING);
    expect(month.daily).toHaveLength(30);
    const sum = month.daily.reduce((total, point) => total + point.input + point.output, 0);
    expect(sum).toBe(month.kpis.totalTokens);
  });

  it('follows the local day of the time zone', async () => {
    // In Paris the late session of 2026-11-10 (23:30 UTC) happens on the 11th.
    const db = await fixtureDb('Europe/Paris');
    const { daily } = getOverview(db, PRICING, { from: '2026-11-10', to: '2026-11-11' }, EVENING);
    expect(daily.map((point) => point.input + point.output)).toEqual([60349, 1110]);
  });

  it('fills the shortcut cards', async () => {
    const db = await fixtureDb();
    const { shortcuts } = getOverview(db, PRICING, BOTH_DAYS, EVENING);

    expect(shortcuts.project).toEqual({ name: 'demo-app', share: 64024 / 65134, tokens: 64024 });
    expect(shortcuts.model).toEqual({
      name: 'Opus 5.5',
      share: 29175 / 65134,
      // Cache read / total input of that model.
      cacheHitRate: 27200 / (725 + 1000 + 27200),
    });
    expect(shortcuts.activity).toEqual({ currentStreak: 2, activeDays: 2, periodDays: 2 });
    expect(shortcuts.sessions).toEqual({ count: 3, averageTokens: 65134 / 3 });
    // Six invocations: the warm-up agent is not one.
    expect(shortcuts.subagents).toEqual({ share: (44894 + 1425) / 65134, invocations: 6 });
    expect(shortcuts.machines).toEqual([{ id: db.machineId, name: 'test-machine', share: 1 }]);
  });

  it('counts the streak back from today, or from yesterday when today is still empty', async () => {
    const db = await fixtureDb();
    const streak = (now: string) =>
      getOverview(db, PRICING, BOTH_DAYS, Date.parse(now)).shortcuts.activity.currentStreak;
    expect(streak('2026-11-10T08:00:00Z')).toBe(2);
    expect(streak('2026-11-09T23:00:00Z')).toBe(1);
    expect(streak('2026-11-11T08:00:00Z')).toBe(2);
    expect(streak('2026-11-12T08:00:00Z')).toBe(0);
    expect(streak('2026-11-08T08:00:00Z')).toBe(0);
  });

  it('applies the machine filter, except to the share of each machine', async () => {
    const db = await fixtureDb();
    const mine = getOverview(db, PRICING, { ...BOTH_DAYS, machineIds: [db.machineId] }, EVENING);
    expect(mine.kpis.totalTokens).toBe(65134);

    const other = getOverview(
      db,
      PRICING,
      { ...BOTH_DAYS, machineIds: ['another-machine'] },
      EVENING,
    );
    expect(other.hasData).toBe(false);
    expect(other.kpis).toMatchObject({ totalTokens: 0, cost: null, totalChange: { kind: 'none' } });
    expect(other.shortcuts.project).toBeNull();
    expect(other.shortcuts.model).toBeNull();
    expect(other.shortcuts.sessions).toEqual({ count: 0, averageTokens: 0 });
    expect(other.shortcuts.activity.currentStreak).toBe(0);
    expect(other.shortcuts.machines).toHaveLength(1);

    const nobody = getOverview(db, PRICING, { ...BOTH_DAYS, machineIds: [] }, EVENING);
    expect(nobody.kpis.totalTokens).toBe(0);
  });

  it('applies the other filters to the totals', async () => {
    const db = await fixtureDb();
    const total = (filters: Partial<Filters>) =>
      getOverview(db, PRICING, { ...BOTH_DAYS, ...filters }, EVENING).kpis.totalTokens;
    expect(total({ projects: ['other-tool', 'scratch-pad'] })).toBe(1110);
    expect(total({ models: ['Haiku 5.5'] })).toBe(25549);
    expect(total({ kinds: ['main'] })).toBe(15455 + 2250 + 1110);
    expect(total({ kinds: ['task', 'workflow', 'aside', 'warmup'] })).toBe(44894 + 1425);
    expect(total({ agentTypes: ['Explore'] })).toBe(21540);
  });

  it('reports a period without usage as zeros, with the data flag still set', async () => {
    const db = await fixtureDb();
    const quiet = getOverview(db, PRICING, { from: '2026-01-01', to: '2026-01-07' }, EVENING);
    expect(quiet.hasData).toBe(true);
    expect(quiet.kpis).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalChange: { kind: 'none' },
      cost: null,
      costIsPartial: false,
    });
    expect(quiet.daily).toHaveLength(7);
    expect(quiet.shortcuts.subagents).toEqual({ share: 0, invocations: 0 });
  });

  it('describes an empty database', () => {
    const db = openMemoryDb();
    open.push(db);
    const overview = getOverview(db, PRICING, BOTH_DAYS, EVENING);
    expect(overview).toEqual(emptyOverview(BOTH_DAYS));
    expect(overview.hasData).toBe(false);
  });
});

describe('parseFilters', () => {
  it('returns a clean copy of valid filters', () => {
    expect(parseFilters({ from: '2026-10-12', to: '2026-11-10', extra: 'ignored' })).toEqual({
      from: '2026-10-12',
      to: '2026-11-10',
      machineIds: undefined,
      projects: undefined,
      models: undefined,
      agentTypes: undefined,
      kinds: undefined,
    });
    expect(
      parseFilters({
        from: '2026-11-10',
        to: '2026-11-10',
        machineIds: ['a'],
        kinds: ['main', 'warmup'],
      }),
    ).toMatchObject({ machineIds: ['a'], kinds: ['main', 'warmup'] });
  });

  it.each([
    ['not an object', 'filters'],
    ['null', null],
    ['missing days', {}],
    ['a day that does not exist', { from: '2026-02-30', to: '2026-03-01' }],
    ['a timestamp', { from: '2026-11-10T00:00:00Z', to: '2026-11-10' }],
    ['an inverted range', { from: '2026-11-10', to: '2026-11-09' }],
    ['a range that is too long', { from: '2020-01-01', to: '2026-11-10' }],
    [
      'a machine list that is not a list',
      { from: '2026-11-10', to: '2026-11-10', machineIds: 'a' },
    ],
    ['a list with a number', { from: '2026-11-10', to: '2026-11-10', projects: [1] }],
    ['an unknown kind', { from: '2026-11-10', to: '2026-11-10', kinds: ['secret'] }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseFilters(input)).toThrow(InvalidRequestError);
  });
});
