import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidRequestError } from '../electron/aggregate';
import type { UsageDatabase } from '../electron/db';
import {
  ACTIVE_MINUTES,
  BURN_MINUTES,
  chainWindows,
  currentWindow,
  emptyLive,
  estimate,
  getLive,
  largestWindow,
  LIVE_SERIES,
  localWindows,
  MINUTE_MS,
  parseLiveHours,
  weigh,
  WINDOW_MS,
  type UsagePoint,
  type UsageWindow,
} from '../electron/live';
import { scanLogs } from '../electron/scanner';
import type { LiveBurn, LiveReference, Pricing } from '../shared/types';
import {
  assistantLine,
  cleanupTempDirs,
  openMemoryDb,
  SESSION_A,
  SESSION_B,
  tempDir,
  writeLines,
} from './helpers';

const HOUR = 60 * MINUTE_MS;
/** 30 seconds into a minute, so minute boundaries are visible. */
const NOW = Date.parse('2026-11-10T12:00:30Z');
const SESSION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
const PRICING: Pricing = {
  lastChecked: null,
  models: { 'Opus 5.5': flat, 'Sonnet 5.5': { ...flat, input: 2 } },
};

type Usage = [number, number, number, number];
const DEFAULT_USAGE: Usage = [10, 5, 0, 100];

/** API-price units of a response at the flat Opus prices. */
function opusUnits([input, output, cacheWrite, cacheRead]: Usage): number {
  return (input * 1 + output * 10 + cacheWrite * 2 + cacheRead * 0.5) / 1e6;
}

function tokensOf(usage: Usage): number {
  return usage.reduce((sum, value) => sum + value, 0);
}

interface Response {
  at: number;
  project?: string;
  model?: string;
  u?: Usage;
  session?: string;
  /** Writes the response into this subagent's transcript. */
  agent?: string;
}

let lineNumber = 0;

/** Writes one transcript per project, session and subagent. Files are replaced. */
function writeResponses(root: string, responses: readonly Response[]): void {
  const files = new Map<string, string[]>();
  for (const response of responses) {
    const project = response.project ?? 'demo-app';
    const folder = path.join(root, `-Users-alex-dev-${project}`);
    const session = response.session ?? SESSION_A;
    const file = response.agent
      ? path.join(folder, session, 'subagents', `agent-${response.agent}.jsonl`)
      : path.join(folder, `${session}.jsonl`);
    const line = assistantLine({
      id: `live${(lineNumber += 1)}`,
      ts: new Date(response.at).toISOString(),
      session,
      cwd: `/Users/alex/dev/${project}`,
      model: response.model ?? 'claude-opus-5-5',
      u: response.u ?? DEFAULT_USAGE,
      sidechain: response.agent !== undefined,
      agentId: response.agent,
    });
    files.set(file, [...(files.get(file) ?? []), line]);
  }
  for (const [file, lines] of files) writeLines(file, lines);
}

const open: UsageDatabase[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
  vi.restoreAllMocks();
});

async function scanned(root: string, timeZone = 'UTC'): Promise<UsageDatabase> {
  const db = openMemoryDb(timeZone);
  open.push(db);
  await scanLogs(db, [root]);
  return db;
}

async function liveDb(
  responses: readonly Response[],
  timeZone = 'UTC',
): Promise<{ db: UsageDatabase; root: string }> {
  const root = path.join(tempDir(), 'projects');
  writeResponses(root, responses);
  return { db: await scanned(root, timeZone), root };
}

function point(ts: number, units = 1, tokens = 100): UsagePoint {
  return {
    ts,
    tokens: { input: tokens, output: 0, cacheWrite: 0, cacheRead: 0 },
    units,
    unpriced: 0,
    responses: 1,
  };
}

const T0 = Date.parse('2026-11-10T08:00:00Z');

describe('5-hour windows', () => {
  it('lasts 5 hours from its first response', () => {
    const windows = chainWindows([point(T0), point(T0 + HOUR), point(T0 + 5 * HOUR - 1)]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      start: T0,
      end: T0 + WINDOW_MS,
      last: T0 + 5 * HOUR - 1,
      responses: 3,
      units: 3,
    });
    expect(windows[0]?.tokens.input).toBe(300);
  });

  it('starts the next window with a response at the exact reset time', () => {
    const windows = chainWindows([point(T0), point(T0 + WINDOW_MS)]);
    expect(windows.map((window) => window.start)).toEqual([T0, T0 + WINDOW_MS]);
  });

  it('starts the next window with the first response after the reset, not at the reset', () => {
    // The pause (2 hours) is shorter than 5 hours, but the window had reset meanwhile.
    const windows = chainWindows([point(T0), point(T0 + 4 * HOUR), point(T0 + 6 * HOUR)]);
    expect(windows.map((window) => [window.start, window.end, window.responses])).toEqual([
      [T0, T0 + 5 * HOUR, 2],
      [T0 + 6 * HOUR, T0 + 11 * HOUR, 1],
    ]);
  });

  it('chains windows through hours of continuous use', () => {
    // A response every 7 minutes for 12 hours: windows start at 0, 301 and 602 minutes.
    const points = Array.from({ length: 103 }, (_, index) => point(T0 + index * 7 * MINUTE_MS));
    const windows = chainWindows(points);
    expect(windows.map((window) => (window.start - T0) / MINUTE_MS)).toEqual([0, 301, 602]);
    expect(windows.map((window) => window.responses)).toEqual([43, 43, 17]);
    expect(windows[2]?.last).toBe(T0 + 714 * MINUTE_MS);
  });

  it('knows which window is running', () => {
    const windows = chainWindows([point(T0), point(T0 + 6 * HOUR)]);
    expect(currentWindow(windows, T0 + 6 * HOUR)).toBe(windows[1]);
    expect(currentWindow(windows, T0 + 11 * HOUR - 1)).toBe(windows[1]);
    expect(currentWindow(windows, T0 + 11 * HOUR)).toBeNull();
    // Between the two windows: the first has reset, the second has not started.
    expect(currentWindow(windows.slice(0, 1), T0 + 5 * HOUR + 1)).toBeNull();
    expect(currentWindow([], T0)).toBeNull();
  });

  it('takes the largest finished window as the reference', () => {
    const windows = chainWindows([
      point(T0, 3),
      point(T0 + 6 * HOUR, 5),
      point(T0 + 12 * HOUR, 5),
      point(T0 + 18 * HOUR, 9),
    ]);
    const current = windows[3] ?? null;
    // The running window is left out; on a tie the latest wins.
    expect(largestWindow(windows, current)).toBe(windows[2]);
    expect(largestWindow(windows, null)).toBe(windows[3]);
    expect(largestWindow(windows.slice(3), current)).toBeNull();
    // A window without priced usage cannot be a reference.
    expect(largestWindow(chainWindows([point(T0, 0)]), null)).toBeNull();
  });
});

describe('estimate', () => {
  const window: UsageWindow = {
    start: T0,
    end: T0 + WINDOW_MS,
    last: T0 + HOUR,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    units: 4,
    unpriced: 0,
    responses: 2,
  };
  const reference: LiveReference = {
    kind: 'largestWindow',
    units: 10,
    tokens: 0,
    start: 0,
    startAt: { day: '2026-11-09', time: '08:00' },
  };
  const burn = (unitsPerMinute: number): LiveBurn => ({
    minutes: BURN_MINUTES,
    tokensPerMinute: 0,
    unitsPerMinute,
  });
  const now = T0 + HOUR;
  const timeOf = (ms: number) => ({ day: 'day', time: String(ms) });

  it('says when the reference is reached at the current speed', () => {
    // 6 units left at 0.1 per minute: 60 minutes, before the reset 4 hours later.
    const result = estimate(window, reference, burn(0.1), now, timeOf);
    expect(result.percent).toBeCloseTo(40, 10);
    expect(result.outcome).toBe('limitFirst');
    expect(result.limitAt).toBeCloseTo(now + 60 * MINUTE_MS, 3);
    expect(result.limitAtTime?.time).toBe(String(result.limitAt));
  });

  it('says when the window resets first', () => {
    const result = estimate(window, reference, burn(0.01), now, timeOf);
    expect(result).toMatchObject({ outcome: 'resetsFirst', limitAt: null, limitAtTime: null });
    // Reaching the reference exactly at the reset: the reset comes first.
    const resetIn96 = { ...window, end: now + 96 * MINUTE_MS };
    expect(estimate(resetIn96, reference, burn(6 / 96), now, timeOf).outcome).toBe('resetsFirst');
    expect(estimate(resetIn96, reference, burn(6 / 95), now, timeOf).outcome).toBe('limitFirst');
  });

  it('says when nothing is being used', () => {
    expect(estimate(window, reference, burn(0), now, timeOf).outcome).toBe('noRate');
  });

  it('says when the reference is already reached', () => {
    const result = estimate({ ...window, units: 12 }, reference, burn(1), now, timeOf);
    expect(result.outcome).toBe('reached');
    expect(result.percent).toBeCloseTo(120, 10);
  });
});

describe('weigh', () => {
  it('weighs a response at API prices, 1-hour cache writes included', () => {
    const row = {
      ts: T0,
      model: 'Opus 5.5',
      input: 10,
      output: 5,
      cacheWrite: 30,
      cacheRead: 100,
      cacheWrite1h: 10,
    };
    const weighed = weigh(PRICING, row);
    expect(weighed.units).toBeCloseTo((10 + 50 + 20 * 2 + 10 * 4 + 50) / 1e6, 15);
    expect(weighed.unpriced).toBe(0);
    expect(weigh(PRICING, { ...row, model: 'Haiku 9.9' })).toMatchObject({
      units: 0,
      unpriced: 145,
    });
  });
});

describe('parseLiveHours', () => {
  it('accepts 1, 3 and 6 hours only', () => {
    expect(parseLiveHours(1)).toBe(1);
    expect(parseLiveHours(6)).toBe(6);
    for (const value of [2, '3', null, undefined, 24]) {
      expect(() => parseLiveHours(value)).toThrow(InvalidRequestError);
    }
  });
});

describe('getLive', () => {
  // Starts the window at NOW - 2 h; the last 15 minutes hold the last two responses.
  const RUNNING: Response[] = [
    { at: NOW - 2 * HOUR },
    { at: NOW - 40 * MINUTE_MS, project: 'web-shop', model: 'claude-sonnet-5-5' },
    { at: NOW - 10 * MINUTE_MS, u: [20, 10, 0, 200] },
    { at: NOW - 2 * MINUTE_MS, project: 'web-shop', session: SESSION_B },
  ];
  const sonnetUnits = (20 + 50 + 50) / 1e6;

  it('has every minute of the chart even without usage', () => {
    const db = openMemoryDb();
    open.push(db);
    for (const hours of [1, 3, 6] as const) {
      const live = getLive(db, PRICING, undefined, hours, NOW);
      expect(live.hasData).toBe(false);
      expect(live.minutes).toHaveLength(hours * 60);
      expect(live.minutes.at(-1)?.t).toBe(Date.parse('2026-11-10T12:00:00Z'));
      expect(live.minutes[0]?.t).toBe(Date.parse('2026-11-10T12:01:00Z') - hours * HOUR);
      expect(live.series).toEqual([]);
      expect(live.machines.map((machine) => machine.status)).toEqual(['noData']);
    }
    expect(emptyLive(3, NOW).minutes).toEqual(getLive(db, PRICING, undefined, 3, NOW).minutes);
  });

  it('shows the running window, the burn rate and the projects in use', async () => {
    const { db } = await liveDb(RUNNING);
    const live = getLive(db, PRICING, undefined, 3, NOW);
    expect(live.hasData).toBe(true);

    const [machine] = live.machines;
    expect(machine).toMatchObject({ isLocal: true, name: 'test-machine', status: 'active' });
    expect(machine?.window).toMatchObject({
      start: NOW - 2 * HOUR,
      end: NOW + 3 * HOUR,
      startAt: { day: '2026-11-10', time: '10:00' },
      endAt: { day: '2026-11-10', time: '15:00' },
      total: 115 * 3 + 230,
      responses: 4,
      unpricedTokens: 0,
    });
    expect(machine?.window?.units).toBeCloseTo(
      opusUnits(DEFAULT_USAGE) * 2 + sonnetUnits + opusUnits([20, 10, 0, 200]),
      15,
    );
    expect(machine?.window?.tokens).toEqual({
      input: 50,
      output: 25,
      cacheWrite: 0,
      cacheRead: 500,
    });
    expect(machine?.previous).toBeNull();
    expect(machine?.lastResponse).toBe(NOW - 2 * MINUTE_MS);

    // The last 15 minutes: the last two responses.
    expect(machine?.burn.minutes).toBe(BURN_MINUTES);
    expect(machine?.burn.tokensPerMinute).toBeCloseTo((230 + 115) / BURN_MINUTES, 10);
    expect(machine?.burn.unitsPerMinute).toBeCloseTo(
      (opusUnits([20, 10, 0, 200]) + opusUnits(DEFAULT_USAGE)) / BURN_MINUTES,
      15,
    );
    // No finished window to compare with yet.
    expect(machine?.estimate).toBeNull();

    // In use: a response in the last 5 minutes. Models and tokens of the last 15 minutes.
    expect(live.active).toEqual([
      {
        project: 'web-shop',
        models: ['Opus 5.5'],
        tokens: 115,
        last: NOW - 2 * MINUTE_MS,
        lastAt: { day: '2026-11-10', time: '11:58' },
      },
    ]);

    expect(live.series).toEqual([
      { project: 'demo-app', tokens: 345, projects: 1 },
      { project: 'web-shop', tokens: 230, projects: 1 },
    ]);
    const minuteOf = (at: number) =>
      live.minutes.find((minute) => minute.t === Math.floor(at / MINUTE_MS) * MINUTE_MS);
    expect(minuteOf(NOW - 2 * HOUR)?.tokens).toEqual([115, 0]);
    expect(minuteOf(NOW - 10 * MINUTE_MS)?.tokens).toEqual([230, 0]);
    expect(minuteOf(NOW - 2 * MINUTE_MS)?.tokens).toEqual([0, 115]);
    const charted = live.minutes.flatMap((minute) => minute.tokens).reduce((a, b) => a + b, 0);
    expect(charted).toBe(575);
  });

  it('keeps the chart to its hours and the burn rate to 15 minutes', async () => {
    const { db } = await liveDb([
      { at: NOW - HOUR + 29_999 }, // 11:00:59.999, just before the first minute of a 1-hour chart
      { at: NOW - HOUR + 30 * 1000 }, // its first minute (11:01)
      { at: NOW - BURN_MINUTES * MINUTE_MS }, // not in the last 15 minutes
      { at: NOW - BURN_MINUTES * MINUTE_MS + 1 },
    ]);
    const live = getLive(db, PRICING, undefined, 1, NOW);
    expect(live.minutes[0]?.tokens).toEqual([115]);
    expect(live.series[0]?.tokens).toBe(115 * 3);
    const [machine] = live.machines;
    expect(machine?.burn.tokensPerMinute).toBeCloseTo(115 / BURN_MINUTES, 10);
    expect(machine?.window?.total).toBe(115 * 4);
    // Nothing in the last 5 minutes.
    expect(live.active).toEqual([]);
  });

  it('lists a project as in use for 5 minutes after its last response', async () => {
    const { db } = await liveDb([
      { at: NOW - ACTIVE_MINUTES * MINUTE_MS, project: 'web-shop' }, // just too old
      { at: NOW - ACTIVE_MINUTES * MINUTE_MS + 1 },
    ]);
    const live = getLive(db, PRICING, undefined, 1, NOW);
    expect(live.active.map((project) => project.project)).toEqual(['demo-app']);
  });

  it('counts subagent responses', async () => {
    const { db } = await liveDb([
      ...RUNNING,
      { at: NOW - MINUTE_MS, agent: 'a1b2c3', u: [1, 1, 1, 1] },
    ]);
    const live = getLive(db, PRICING, undefined, 3, NOW);
    expect(live.machines[0]?.window).toMatchObject({ total: 579, responses: 5 });
    expect(live.active.map((project) => [project.project, project.tokens])).toEqual([
      ['demo-app', 234],
      ['web-shop', 115],
    ]);
  });

  it('shows the last window once it has reset', async () => {
    const { db } = await liveDb([{ at: NOW - 7 * HOUR }, { at: NOW - 6 * HOUR }]);
    const [machine] = getLive(db, PRICING, undefined, 6, NOW).machines;
    expect(machine).toMatchObject({
      status: 'idle',
      window: null,
      estimate: null,
      lastResponse: NOW - 6 * HOUR,
      lastResponseAt: { day: '2026-11-10', time: '06:00' },
    });
    expect(machine?.previous).toMatchObject({ start: NOW - 7 * HOUR, end: NOW - 2 * HOUR });
    expect(machine?.burn.tokensPerMinute).toBe(0);
  });

  it('keeps the burn rate of a window that has just reset, without an estimate', async () => {
    // The window ran from NOW - 5 h 05 to NOW - 5 min; its last response is 10 minutes old.
    const { db } = await liveDb([
      { at: NOW - 30 * HOUR }, // a finished window to compare with
      { at: NOW - 5 * HOUR - 5 * MINUTE_MS },
      { at: NOW - 10 * MINUTE_MS },
    ]);
    const [machine] = getLive(db, PRICING, undefined, 1, NOW).machines;
    expect(machine).toMatchObject({ status: 'idle', window: null, estimate: null });
    expect(machine?.previous?.end).toBe(NOW - 5 * MINUTE_MS);
    expect(machine?.burn.tokensPerMinute).toBeCloseTo(115 / BURN_MINUTES, 10);
  });

  it('estimates the running window against the largest past window', async () => {
    const big: Usage = [100, 50, 0, 600];
    const { db } = await liveDb([
      { at: NOW - 48 * HOUR, session: SESSION_C }, // a small old window
      { at: NOW - 24 * HOUR, u: big, session: SESSION_C },
      { at: NOW - 23 * HOUR, u: big, session: SESSION_C },
      ...RUNNING,
    ]);
    const [machine] = getLive(db, PRICING, undefined, 3, NOW).machines;
    const reference = opusUnits(big) * 2;
    const used = machine?.window?.units ?? 0;
    const perMinute = machine?.burn.unitsPerMinute ?? 0;

    expect(machine?.previous?.start).toBe(NOW - 24 * HOUR);
    expect(machine?.estimate?.reference).toMatchObject({
      kind: 'largestWindow',
      tokens: tokensOf(big) * 2,
      start: NOW - 24 * HOUR,
      startAt: { day: '2026-11-09', time: '12:00' },
    });
    expect(machine?.estimate?.reference.units).toBeCloseTo(reference, 15);
    expect(machine?.estimate?.percent).toBeCloseTo((used / reference) * 100, 10);
    expect(machine?.estimate?.outcome).toBe('limitFirst');
    expect(machine?.estimate?.limitAt).toBeCloseTo(
      NOW + ((reference - used) / perMinute) * MINUTE_MS,
      3,
    );
  });

  it('leaves models without a price out of the units', async () => {
    const { db } = await liveDb([
      { at: NOW - HOUR },
      { at: NOW - 30 * MINUTE_MS, model: 'claude-haiku-9-9' },
    ]);
    const window = getLive(db, PRICING, undefined, 3, NOW).machines[0]?.window;
    expect(window?.total).toBe(230);
    expect(window?.unpricedTokens).toBe(115);
    expect(window?.units).toBeCloseTo(opusUnits(DEFAULT_USAGE), 15);
  });

  it('merges the smaller projects past six series', async () => {
    const responses = Array.from({ length: 8 }, (_, index) => ({
      at: NOW - (30 - index) * MINUTE_MS,
      project: `project-${index}`,
      u: [index + 1, 0, 0, 0] as Usage,
    }));
    const live = getLive((await liveDb(responses)).db, PRICING, undefined, 1, NOW);
    expect(live.series).toHaveLength(LIVE_SERIES);
    expect(live.series.map((series) => series.project)).toEqual([
      'project-7',
      'project-6',
      'project-5',
      'project-4',
      'project-3',
      null,
    ]);
    expect(live.series.at(-1)).toEqual({ project: null, tokens: 1 + 2 + 3, projects: 3 });
    live.series.forEach((series, index) => {
      const charted = live.minutes.reduce((sum, minute) => sum + (minute.tokens[index] ?? 0), 0);
      expect(charted).toBe(series.tokens);
    });

    // Six projects fit without merging.
    const six = getLive((await liveDb(responses.slice(2))).db, PRICING, undefined, 1, NOW);
    expect(six.series.map((series) => series.project)).toEqual([
      'project-7',
      'project-6',
      'project-5',
      'project-4',
      'project-3',
      'project-2',
    ]);
  });

  it('keeps windows in UTC and shows their times in the local zone', async () => {
    const root = path.join(tempDir(), 'projects');
    writeResponses(root, RUNNING);
    const utc = getLive(await scanned(root, 'UTC'), PRICING, undefined, 3, NOW);
    const zurich = getLive(await scanned(root, 'Europe/Zurich'), PRICING, undefined, 3, NOW);
    expect(zurich.machines[0]?.window?.start).toBe(utc.machines[0]?.window?.start);
    expect(zurich.machines[0]?.window?.end).toBe(utc.machines[0]?.window?.end);
    expect(utc.machines[0]?.window?.startAt.time).toBe('10:00');
    expect(zurich.machines[0]?.window?.startAt.time).toBe('11:00');
    expect(zurich.minutes).toEqual(utc.minutes);
  });

  it('follows the machine selection', async () => {
    const { db } = await liveDb(RUNNING);
    db.upsertRemoteMachine({
      id: 'remote-1',
      name: 'Desktop PC',
      platform: 'win32',
      lastSync: null,
      appVersion: null,
    });

    const all = getLive(db, PRICING, undefined, 3, NOW);
    expect(all.machines.map((machine) => [machine.name, machine.status])).toEqual([
      ['test-machine', 'active'],
      ['Desktop PC', 'noLiveData'],
    ]);

    const remote = getLive(db, PRICING, ['remote-1'], 3, NOW);
    expect(remote.hasData).toBe(false);
    expect(remote.machines.map((machine) => machine.machineId)).toEqual(['remote-1']);
    expect(remote.series).toEqual([]);
    expect(remote.active).toEqual([]);
    expect(remote.minutes.every((minute) => minute.tokens.length === 0)).toBe(true);

    const local = getLive(db, PRICING, [db.machineId], 3, NOW);
    expect(local.machines.map((machine) => machine.status)).toEqual(['active']);
    expect(local.series).toEqual(all.series);
  });
});

describe('window history', () => {
  /** Later than every response of these tests. */
  const LATER = NOW + 10 * HOUR;

  /** The windows of a database computed from scratch. */
  function fresh(db: UsageDatabase, pricing: Pricing): UsageWindow[] {
    return chainWindows(
      [...db.responsesFrom(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)].map((row) =>
        weigh(pricing, row),
      ),
    );
  }

  it('reads only the last window again when nothing older changed', async () => {
    const early: Response[] = [
      { at: NOW - 30 * HOUR },
      { at: NOW - 20 * HOUR },
      { at: NOW - 19 * HOUR },
      { at: NOW - 3 * HOUR },
    ];
    const { db, root } = await liveDb(early);
    expect(localWindows(db, PRICING, LATER)).toEqual(fresh(db, PRICING));
    const tailStart = localWindows(db, PRICING, LATER).at(-1)?.start;

    // New responses in a new transcript: the last window grows and a new one starts.
    writeResponses(root, [
      { at: NOW - HOUR, session: SESSION_B },
      { at: NOW + 3 * HOUR, session: SESSION_B },
    ]);
    await scanLogs(db, [root]);
    const read = vi.spyOn(db, 'responsesFrom');
    expect(localWindows(db, PRICING, LATER)).toEqual(fresh(db, PRICING));
    expect(read.mock.calls[0]).toEqual([tailStart, LATER]);
    expect(localWindows(db, PRICING, LATER).map((window) => window.start)).toEqual([
      NOW - 30 * HOUR,
      NOW - 20 * HOUR,
      NOW - 3 * HOUR,
      NOW + 3 * HOUR,
    ]);
  });

  it('reads everything again when an older response arrives or the prices change', async () => {
    const { db, root } = await liveDb([{ at: NOW - 30 * HOUR }, { at: NOW - 3 * HOUR }]);
    localWindows(db, PRICING, LATER);

    // A response between the two windows: it starts a window of its own.
    writeResponses(root, [{ at: NOW - 10 * HOUR, session: SESSION_C }]);
    await scanLogs(db, [root]);
    const read = vi.spyOn(db, 'responsesFrom');
    expect(localWindows(db, PRICING, LATER)).toEqual(fresh(db, PRICING));
    expect(read.mock.calls[0]).toEqual([Number.MIN_SAFE_INTEGER, LATER]);
    expect(localWindows(db, PRICING, LATER)).toHaveLength(3);

    const dearer: Pricing = { ...PRICING, models: { 'Opus 5.5': { ...flat, output: 20 } } };
    expect(localWindows(db, dearer, LATER)).toEqual(fresh(db, dearer));
    expect(localWindows(db, dearer, LATER)[0]?.units).toBeCloseTo((10 + 100 + 50) / 1e6, 15);
  });

  it('reads everything again when an older response grows in place', async () => {
    // A response still streaming at the end of the first window, then a response that
    // starts the second one; later, the complete copy of the first response.
    const root = path.join(tempDir(), 'projects');
    const file = path.join(root, '-Users-alex-dev-demo-app', `${SESSION_A}.jsonl`);
    const streamed = (u: Usage, stop: string | null) =>
      assistantLine({
        id: 'streamed',
        ts: new Date(NOW - 5 * HOUR - MINUTE_MS).toISOString(),
        u,
        stop,
      });
    writeLines(file, [
      assistantLine({ id: 'first', ts: new Date(NOW - 10 * HOUR).toISOString() }),
      streamed([10, 1, 0, 100], null),
    ]);
    writeResponses(root, [{ at: NOW - 4 * HOUR, session: SESSION_B }]);
    const db = await scanned(root);
    expect(localWindows(db, PRICING, LATER).map((window) => window.tokens.output)).toEqual([6, 5]);

    fs.appendFileSync(file, `${streamed([10, 500, 0, 100], 'end_turn')}\n`);
    await scanLogs(db, [root]);
    const read = vi.spyOn(db, 'responsesFrom');
    expect(localWindows(db, PRICING, LATER)).toEqual(fresh(db, PRICING));
    expect(read.mock.calls[0]).toEqual([Number.MIN_SAFE_INTEGER, LATER]);
    expect(localWindows(db, PRICING, LATER).map((window) => window.tokens.output)).toEqual([
      505, 5,
    ]);
  });

  it('reads everything again after a rebuild', async () => {
    const { db } = await liveDb([{ at: NOW - 30 * HOUR }, { at: NOW - 3 * HOUR }]);
    localWindows(db, PRICING, LATER);
    db.resetFileStates();
    db.refreshDerived();
    const read = vi.spyOn(db, 'responsesFrom');
    localWindows(db, PRICING, LATER);
    expect(read.mock.calls[0]).toEqual([Number.MIN_SAFE_INTEGER, LATER]);
  });

  it('leaves responses dated in the future out until their time comes', async () => {
    const { db } = await liveDb([{ at: NOW - HOUR }, { at: NOW + 2 * HOUR }]);
    const now = getLive(db, PRICING, undefined, 1, NOW).machines[0];
    expect(now).toMatchObject({ status: 'active', lastResponse: NOW - HOUR });
    expect(now?.window).toMatchObject({ start: NOW - HOUR, responses: 1 });

    const later = getLive(db, PRICING, undefined, 1, NOW + 2 * HOUR + MINUTE_MS).machines[0];
    expect(later?.window).toMatchObject({ start: NOW - HOUR, responses: 2 });
    expect(later?.lastResponse).toBe(NOW + 2 * HOUR);
  });
});
