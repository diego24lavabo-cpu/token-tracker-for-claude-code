import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALENDAR_DAYS,
  comparePeriods,
  emptyCalendar,
  emptyModels,
  emptyOverview,
  emptyProjectDetail,
  emptyProjects,
  getCalendar,
  getModels,
  getOverview,
  getProjectDetail,
  getProjects,
  InvalidRequestError,
  parseFilters,
  parseMachineIds,
  parseProjectName,
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
  SESSION_B,
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

describe('getProjects', () => {
  it('lists every project of the period, largest first', async () => {
    const db = await fixtureDb();
    const { hasData, rows } = getProjects(db, BOTH_DAYS);

    expect(hasData).toBe(true);
    expect(rows.map((row) => [row.name, row.tokens])).toEqual([
      ['demo-app', 64024],
      ['other-tool', 1010],
      ['scratch-pad', 100],
    ]);
    // The projects add up to the Overview total.
    const overview = getOverview(db, PRICING, BOTH_DAYS, EVENING);
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(overview.kpis.totalTokens);
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
    for (const row of rows) expect(row.input + row.output).toBe(row.tokens);
  });

  it('fills the columns of a project', async () => {
    const db = await fixtureDb();
    const demo = getProjects(db, BOTH_DAYS).rows[0]!;

    expect(demo).toMatchObject({
      name: 'demo-app',
      share: 64024 / 65134,
      input: 63563,
      output: 461,
      outputInputRatio: 461 / 63563,
      sessions: 2,
      // Session totals include their subagents: 60349 + 3675.
      tokensPerSession: 64024 / 2,
      activeDays: 2,
      mainModel: 'Opus 5.5',
      lastUsed: '2026-11-10',
    });
    // Every token outside the two main sessions comes from a subagent.
    expect(demo.subagentShare).toBeCloseTo((64024 - 15455 - 2250) / 64024, 10);
  });

  it('counts a session in every project where it has activity', async () => {
    const db = await fixtureDb();
    const { rows, kpis } = getProjects(db, BOTH_DAYS);
    const byName = new Map(rows.map((row) => [row.name, row]));

    // Session 3333 spends 1010 tokens in other-tool and 100 in scratch-pad.
    expect(byName.get('other-tool')).toMatchObject({ sessions: 1, tokensPerSession: 1010 });
    expect(byName.get('scratch-pad')).toMatchObject({ sessions: 1, tokensPerSession: 100 });
    for (const row of rows) expect(row.sessions).toBeGreaterThan(0);
    expect(getProjectDetail(db, PRICING, 'scratch-pad', BOTH_DAYS).summary.sessions).toBe(1);

    // Global totals still count each session once.
    expect(rows.reduce((sum, row) => sum + row.sessions, 0)).toBe(4);
    expect(kpis.tokensPerSession).toBe(65134 / 3);
    expect(getOverview(db, PRICING, BOTH_DAYS, EVENING).shortcuts.sessions.count).toBe(3);
  });

  it('shows the last day of use, whatever the period', async () => {
    const db = await fixtureDb();
    const firstDay = getProjects(db, { from: '2026-11-09', to: '2026-11-09' });
    expect(firstDay.rows.map((row) => [row.name, row.lastUsed])).toEqual([
      ['demo-app', '2026-11-10'],
    ]);
  });

  it('computes the KPI row', async () => {
    const db = await fixtureDb();
    const { kpis } = getProjects(db, BOTH_DAYS);

    expect(kpis).toEqual({
      activeProjects: 3,
      mainProject: { name: 'demo-app', share: 64024 / 65134 },
      tokensPerSession: 65134 / 3,
      outputInputRatio: 497 / (959 + 14400 + 49278),
      top3Share: 1,
    });

    const oneDay = getProjects(db, { from: '2026-11-09', to: '2026-11-09' });
    expect(oneDay.kpis).toMatchObject({
      activeProjects: 1,
      mainProject: { name: 'demo-app', share: 1 },
      tokensPerSession: 3675,
    });
  });

  it('follows the machine filter', async () => {
    const db = await fixtureDb();
    const other = getProjects(db, { ...BOTH_DAYS, machineIds: ['another-machine'] });
    expect(other).toEqual(emptyProjects());

    const local = getProjects(db, { ...BOTH_DAYS, machineIds: [db.machineId] });
    expect(local.rows).toHaveLength(3);
  });

  it('reports a quiet period as an empty table, with the data flag still set', async () => {
    const db = await fixtureDb();
    const quiet = getProjects(db, { from: '2026-01-01', to: '2026-01-07' });
    expect(quiet).toEqual({ ...emptyProjects(), hasData: true });
  });
});

describe('getProjectDetail', () => {
  it('summarises the project and prices it like the Overview', async () => {
    const db = await fixtureDb();
    const detail = getProjectDetail(db, PRICING, 'demo-app', BOTH_DAYS);
    const overview = getOverview(db, PRICING, { ...BOTH_DAYS, projects: ['demo-app'] }, EVENING);

    expect(detail.name).toBe('demo-app');
    expect(detail.summary).toEqual({
      tokens: 64024,
      sessions: 2,
      outputShare: overview.kpis.outputTokens / 64024,
      subagentShare: (64024 - 15455 - 2250) / 64024,
      cost: overview.kpis.cost,
      costIsPartial: false,
    });
    expect(detail.summary.cost).toBeGreaterThan(0);
  });

  it('splits the days between main sessions and subagents', async () => {
    const db = await fixtureDb();
    const { daily } = getProjectDetail(db, PRICING, 'demo-app', {
      from: '2026-11-08',
      to: '2026-11-10',
    });
    expect(daily).toEqual([
      { day: '2026-11-08', main: 0, subagent: 0 },
      { day: '2026-11-09', main: 2250, subagent: 1225 + 200 },
      { day: '2026-11-10', main: 15455, subagent: 44894 },
    ]);
  });

  it('breaks the project down by model, machine, agent type and hour', async () => {
    const db = await fixtureDb();
    const detail = getProjectDetail(db, PRICING, 'demo-app', BOTH_DAYS);

    expect(detail.models.map((row) => [row.name, row.tokens])).toEqual([
      ['Opus 5.5', 29175],
      ['Haiku 5.5', 25549],
      ['Sonnet 5.5', 9300],
    ]);
    expect(detail.models.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);

    expect(detail.machines).toEqual([
      { id: db.machineId, name: 'test-machine', tokens: 64024, share: 1 },
    ]);

    expect(
      detail.agentTypes.map((row) => [row.name, row.kind, row.tokens, row.invocations]),
    ).toEqual([
      ['Explore', 'task', 21540, 1],
      ['aside_question', 'aside', 12040, 1],
      // The agent without meta, the legacy agent and the inline bucket.
      ['unknown', 'task', 3035 + 1225 + 200, 3],
      ['build-check', 'workflow', 4270, 1],
      // A warm-up is never an invocation.
      ['general-purpose', 'warmup', 4009, 0],
    ]);
    expect(detail.agentTypes.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);

    expect(detail.hours).toHaveLength(24);
    expect(detail.hours[9]).toBe(3675);
    expect(detail.hours[12]).toBe(60349);
    expect(detail.hours.reduce((sum, value) => sum + value, 0)).toBe(64024);
  });

  it('describes a project without usage in the period', async () => {
    const db = await fixtureDb();
    const filters = { from: '2026-01-01', to: '2026-01-03' };
    expect(getProjectDetail(db, PRICING, 'demo-app', filters)).toEqual(
      emptyProjectDetail('demo-app', filters),
    );
    expect(getProjectDetail(db, PRICING, 'no-such-project', BOTH_DAYS).summary.tokens).toBe(0);
  });
});

describe('parseProjectName', () => {
  it('accepts a project name', () => {
    expect(parseProjectName('demo-app')).toBe('demo-app');
  });

  it.each([
    ['a number', 1],
    ['an empty string', ''],
    ['a list', ['demo-app']],
    ['a very long string', 'x'.repeat(1_001)],
  ])('rejects %s', (_name, input) => {
    expect(() => parseProjectName(input)).toThrow(InvalidRequestError);
  });
});

describe('getModels', () => {
  it('gives one card per model, largest first, adding up to the Overview total', async () => {
    const db = await fixtureDb();
    const { hasData, cards } = getModels(db, PRICING, BOTH_DAYS);

    expect(hasData).toBe(true);
    expect(cards.map((card) => [card.name, card.tokens])).toEqual([
      ['Opus 5.5', 29175],
      ['Haiku 5.5', 25549],
      ['Sonnet 5.5', 9300],
      ['Fable 5.2', 1110],
    ]);
    const overview = getOverview(db, PRICING, BOTH_DAYS, EVENING);
    const sum = (pick: (card: (typeof cards)[number]) => number) =>
      cards.reduce((total, card) => total + pick(card), 0);
    expect(sum((card) => card.tokens)).toBe(overview.kpis.totalTokens);
    expect(sum((card) => card.input)).toBe(overview.kpis.inputTokens);
    expect(sum((card) => card.output)).toBe(overview.kpis.outputTokens);
    expect(sum((card) => card.share)).toBeCloseTo(1, 10);
    expect(sum((card) => card.cost ?? 0)).toBeCloseTo(overview.kpis.cost!, 12);
    for (const card of cards) {
      const { input, output, cacheWrite, cacheRead } = card.breakdown;
      expect(input + output + cacheWrite + cacheRead).toBe(card.tokens);
      expect(input + cacheWrite + cacheRead).toBe(card.input);
    }
  });

  it('fills the numbers of a card', async () => {
    const db = await fixtureDb();
    const cards = getModels(db, PRICING, BOTH_DAYS).cards;
    const haiku = cards.find((card) => card.name === 'Haiku 5.5')!;

    // The Explore run and the warm-up agent.
    expect(haiku).toMatchObject({
      breakdown: { input: 48, output: 101, cacheWrite: 7200, cacheRead: 18200 },
      input: 25448,
      output: 101,
      messages: 4,
      subagentShare: 1,
      topProject: 'demo-app',
    });
    expect(haiku.cacheHitRate).toBeCloseTo(18200 / 25448, 12);
    expect(haiku.outputPerMessage).toBeCloseTo(101 / 4, 12);
    expect(haiku.cost).toBeCloseTo((48 * 1 + 101 * 10 + 7200 * 2 + 18200 * 0.5) / 1e6, 12);

    const opus = cards.find((card) => card.name === 'Opus 5.5')!;
    // Only the /btw side question ran on Opus outside the main sessions.
    expect(opus.subagentShare).toBeCloseTo(12040 / 29175, 12);
    expect(opus.messages).toBe(7);

    const fable = cards.find((card) => card.name === 'Fable 5.2')!;
    expect(fable).toMatchObject({ subagentShare: 0, topProject: 'other-tool', messages: 3 });
  });

  it('shows no cost for a model without a price', async () => {
    const db = await fixtureDb();
    const pricing: Pricing = { lastChecked: null, models: { 'Opus 5.5': flat } };
    const cards = getModels(db, pricing, BOTH_DAYS).cards;
    expect(cards.find((card) => card.name === 'Opus 5.5')!.cost).not.toBeNull();
    expect(cards.find((card) => card.name === 'Haiku 5.5')!.cost).toBeNull();
  });

  it('splits the 12 weeks ending with the period, whatever its length', async () => {
    const db = await fixtureDb();
    await scanLogs(db, [fixtureRoot('win')]);
    const { weekly, weeklyModels } = getModels(db, PRICING, {
      from: '2026-11-10',
      to: '2026-11-10',
    });

    expect(weekly).toHaveLength(12);
    expect(weekly[0]!.week).toBe('2026-08-24');
    expect(weekly.at(-1)!.week).toBe('2026-11-09');
    expect(weeklyModels).toEqual(['Opus 5.5', 'Haiku 5.5', 'Sonnet 5.5', 'Fable 5.2']);
    // Monday 9 and Tuesday 10 fall in the last week, Sunday 8 in the one before.
    expect(weekly.at(-1)!.tokens).toEqual([29175, 25549, 9300, 1110]);
    expect(weekly.at(-2)!.tokens).toEqual([1100, 0, 200, 0]);
    expect(weekly.slice(0, -2).every((point) => point.tokens.every((value) => value === 0))).toBe(
      true,
    );
  });

  it('applies the filters to the weeks too', async () => {
    const db = await fixtureDb();
    const haikuOnly = getModels(db, PRICING, { ...BOTH_DAYS, models: ['Haiku 5.5'] });
    expect(haikuOnly.cards.map((card) => card.name)).toEqual(['Haiku 5.5']);
    expect(haikuOnly.weeklyModels).toEqual(['Haiku 5.5']);
    expect(haikuOnly.weekly.at(-1)!.tokens).toEqual([25549]);

    const other = getModels(db, PRICING, { ...BOTH_DAYS, machineIds: ['another-machine'] });
    expect(other).toEqual(emptyModels(BOTH_DAYS));
  });

  it('reports a quiet period as no cards, with the data flag still set', async () => {
    const db = await fixtureDb();
    const quiet = getModels(db, PRICING, { from: '2026-01-01', to: '2026-01-07' });
    expect(quiet.hasData).toBe(true);
    expect(quiet.cards).toEqual([]);
    expect(quiet.weekly).toHaveLength(12);
    expect(quiet.weeklyModels).toEqual([]);
  });

  it('describes an empty database', () => {
    const db = openMemoryDb();
    open.push(db);
    expect(getModels(db, PRICING, BOTH_DAYS)).toEqual(emptyModels(BOTH_DAYS));
  });
});

describe('getCalendar', () => {
  /** Every day of the heatmap inside the 12 months, oldest first. */
  const heatmapDays = (calendar: ReturnType<typeof getCalendar>) =>
    calendar.heatmap.weeks.flatMap((week) => week.days.filter((day) => day !== null));

  /** The macOS and Windows fixtures together: usage on Sunday 8, Monday 9 and Tuesday 10. */
  async function bothFixturesDb(): Promise<UsageDatabase> {
    const db = await fixtureDb();
    await scanLogs(db, [fixtureRoot('win')]);
    return db;
  }

  it('lays the last 365 days out as 53 weeks starting on Monday', async () => {
    const db = await bothFixturesDb();
    const { today, heatmap } = getCalendar(db, undefined, EVENING);

    expect(today).toBe('2026-11-10');
    expect(heatmap.from).toBe('2025-11-11');
    expect(heatmap.to).toBe('2026-11-10');
    expect(heatmap.weeks).toHaveLength(53);
    expect(heatmap.weeks.every((week) => week.days.length === 7)).toBe(true);
    // 2025-11-11 is a Tuesday: the first column starts with an empty Monday.
    expect(heatmap.weeks[0]!.start).toBe('2025-11-10');
    expect(heatmap.weeks[0]!.days[0]).toBeNull();
    expect(heatmap.weeks[0]!.days[1]!.day).toBe('2025-11-11');
    // The last column holds Monday 9 and today, then five days still to come.
    expect(heatmap.weeks.at(-1)!.start).toBe('2026-11-09');
    expect(heatmap.weeks.at(-1)!.days.map((day) => day?.day ?? null)).toEqual([
      '2026-11-09',
      '2026-11-10',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(heatmapDays(getCalendar(db, undefined, EVENING))).toHaveLength(CALENDAR_DAYS);
  });

  it('adds up to the Overview total over the same range', async () => {
    const db = await bothFixturesDb();
    const calendar = getCalendar(db, undefined, EVENING);
    const days = heatmapDays(calendar);
    const overview = getOverview(db, PRICING, calendar.heatmap, EVENING);

    const sum = days.reduce((total, day) => total + day.tokens, 0);
    expect(sum).toBe(overview.kpis.totalTokens);
    expect(sum).toBe(65134 + 1300);
    expect(days.filter((day) => day.tokens > 0).map((day) => [day.day, day.tokens])).toEqual([
      ['2026-11-08', 1300],
      ['2026-11-09', 3675],
      ['2026-11-10', 61459],
    ]);
    // Every day with usage has at least one session with activity.
    expect(days.every((day) => day.tokens > 0 === day.sessions > 0)).toBe(true);
    // The other charts split the same total.
    const add = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(add(calendar.byWeekday)).toBe(sum);
    expect(add(calendar.byHour)).toBe(sum);
    expect(add(calendar.byMonth.map((point) => point.tokens))).toBe(sum);
  });

  it('puts a Sunday last in the week', async () => {
    const db = await bothFixturesDb();
    const { byWeekday, bestWeekday, heatmap } = getCalendar(db, undefined, EVENING);
    // The Windows fixture is Sunday 2026-11-08.
    expect(byWeekday).toEqual([3675, 61459, 0, 0, 0, 0, 1300]);
    expect(bestWeekday).toBe(1);
    const sundayWeek = heatmap.weeks.at(-2)!;
    expect(sundayWeek.start).toBe('2026-11-02');
    expect(sundayWeek.days[6]).toMatchObject({ day: '2026-11-08', tokens: 1300 });
  });

  it('computes the KPI row', async () => {
    const db = await bothFixturesDb();
    const { kpis } = getCalendar(db, undefined, EVENING);
    expect(kpis).toEqual({
      activeDays: 3,
      totalDays: 365,
      currentStreak: { days: 3, from: '2026-11-08', to: '2026-11-10' },
      longestStreak: { days: 3, from: '2026-11-08', to: '2026-11-10' },
      bestDay: { day: '2026-11-10', tokens: 61459 },
      averagePerActiveDay: (65134 + 1300) / 3,
    });
  });

  it('grades the days by quartile of the active days', async () => {
    const db = await bothFixturesDb();
    const calendar = getCalendar(db, undefined, EVENING);
    expect(calendar.heatmap.thresholds).toEqual([3675, 61459, 61459]);
    const level = (day: string) => heatmapDays(calendar).find((cell) => cell.day === day)!.level;
    expect(level('2026-11-07')).toBe(0);
    expect(level('2026-11-08')).toBe(1);
    expect(level('2026-11-09')).toBe(2);
    expect(level('2026-11-10')).toBe(4);
  });

  it('counts streaks across gaps, inside the 12 months only', async () => {
    const root = path.join(tempDir(), 'projects');
    const days = [
      // Ten days in a row, more than a year ago: outside the calendar.
      ...Array.from({ length: 10 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`),
      // Four days in a row, then a gap, then two runs of two days.
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-20',
      '2026-10-21',
      '2026-11-09',
      '2026-11-10',
    ];
    writeLines(
      path.join(root, MAC_FOLDER, `${SESSION_A}.jsonl`),
      days.map((day, i) => assistantLine({ id: `d${i}`, ts: `${day}T12:00:00.000Z` })),
    );
    const db = openMemoryDb();
    open.push(db);
    await scanLogs(db, [root]);

    const at = (now: string) => getCalendar(db, undefined, Date.parse(now)).kpis;
    const tuesday = at('2026-11-10T20:00:00Z');
    expect(tuesday.activeDays).toBe(8);
    expect(tuesday.longestStreak).toEqual({ days: 4, from: '2026-10-01', to: '2026-10-04' });
    expect(tuesday.currentStreak).toEqual({ days: 2, from: '2026-11-09', to: '2026-11-10' });
    // Today still empty: the streak ends yesterday.
    expect(at('2026-11-11T08:00:00Z').currentStreak).toEqual({
      days: 2,
      from: '2026-11-09',
      to: '2026-11-10',
    });
    expect(at('2026-11-12T08:00:00Z').currentStreak).toBeNull();
    // On 2025-01-08 the ten-day run is inside the calendar, and still going.
    const january = at('2025-01-08T20:00:00Z');
    expect(january.longestStreak).toEqual({ days: 8, from: '2025-01-01', to: '2025-01-08' });
    expect(january.currentStreak).toEqual({ days: 8, from: '2025-01-01', to: '2025-01-08' });
    // A year later, October 1-3 have left the calendar: of the two runs of two days, the
    // latest wins.
    const nextYear = at('2027-10-03T20:00:00Z');
    expect(nextYear.activeDays).toBe(5);
    expect(nextYear.longestStreak).toEqual({ days: 2, from: '2026-11-09', to: '2026-11-10' });
    expect(nextYear.currentStreak).toBeNull();
  });

  it('counts a session on every day it has activity', async () => {
    const root = path.join(tempDir(), 'projects');
    writeLines(path.join(root, MAC_FOLDER, `${SESSION_A}.jsonl`), [
      assistantLine({ id: 'a1', ts: '2026-11-09T23:50:00.000Z' }),
      assistantLine({ id: 'a2', ts: '2026-11-10T00:10:00.000Z' }),
    ]);
    writeLines(path.join(root, MAC_FOLDER, `${SESSION_B}.jsonl`), [
      assistantLine({ id: 'b1', session: SESSION_B, ts: '2026-11-10T09:00:00.000Z' }),
    ]);
    const db = openMemoryDb();
    open.push(db);
    await scanLogs(db, [root]);

    const sessionsOn = (calendar: ReturnType<typeof getCalendar>, day: string) =>
      heatmapDays(calendar).find((cell) => cell.day === day)!.sessions;
    const calendar = getCalendar(db, undefined, EVENING);
    expect(sessionsOn(calendar, '2026-11-09')).toBe(1);
    expect(sessionsOn(calendar, '2026-11-10')).toBe(2);
    // Other machines have no per-day sessions yet.
    expect(sessionsOn(getCalendar(db, ['another-machine'], EVENING), '2026-11-10')).toBe(0);
  });

  it('splits the year by hour and by calendar month', async () => {
    const db = await bothFixturesDb();
    const { byHour, byMonth } = getCalendar(db, undefined, EVENING);
    expect(byHour).toHaveLength(24);
    expect(byMonth.map((point) => point.month)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(byMonth.at(-1)!.tokens).toBe(65134 + 1300);
    // The Windows session runs from 09:59 to 10:06 UTC.
    expect(byHour[9]! + byHour[10]!).toBeGreaterThanOrEqual(1300);
  });

  it('follows the machine filter', async () => {
    const db = await bothFixturesDb();
    expect(heatmapDays(getCalendar(db, [db.machineId], EVENING)).length).toBe(CALENDAR_DAYS);
    expect(getCalendar(db, [db.machineId], EVENING).kpis.activeDays).toBe(3);
    const other = getCalendar(db, ['another-machine'], EVENING);
    expect(other).toEqual(emptyCalendar('2026-11-10'));
    expect(getCalendar(db, [], EVENING).hasData).toBe(false);
  });

  it('describes an empty database', () => {
    const db = openMemoryDb();
    open.push(db);
    const calendar = getCalendar(db, undefined, EVENING);
    expect(calendar).toEqual(emptyCalendar('2026-11-10'));
    expect(heatmapDays(calendar)).toHaveLength(CALENDAR_DAYS);
  });

  it('checks the machine list', () => {
    expect(parseMachineIds(undefined)).toBeUndefined();
    expect(parseMachineIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => parseMachineIds('a')).toThrow(InvalidRequestError);
    expect(() => parseMachineIds([1])).toThrow(InvalidRequestError);
  });
});
