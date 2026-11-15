import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidRequestError } from '../electron/aggregate';
import type { UsageDatabase } from '../electron/db';
import {
  ACTIVE_MINUTES,
  BURN_MINUTES,
  buildLiveFile,
  chainRuns,
  chainWindows,
  currentWindow,
  emptyLive,
  estimate,
  calibrate,
  getLive,
  getReferenceChoice,
  largestWindow,
  LIVE_SERIES,
  localWindows,
  MINUTE_MS,
  parseCalibrationPercent,
  parseLiveHours,
  parseReferenceChoice,
  rememberCombinedWindows,
  setReferenceChoice,
  weigh,
  WINDOW_MS,
  type EstimateBasis,
  type UsagePoint,
  type UsageWindow,
} from '../electron/live';
import {
  LIVE_FRESH_MS,
  parseLiveFile,
  serializeLiveFile,
  type LiveFile,
} from '../electron/liveFormat';
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
  const reference: LiveReference = {
    kind: 'largestWindow',
    units: 10,
    at: 0,
    atTime: { day: '2026-11-09', time: '08:00' },
    tokens: 0,
    percent: null,
  };
  // 4 units used of 10, the window resets 4 hours after `now`.
  const basis: EstimateBasis = { reference, basePercent: 0, units: 4, resetsAt: T0 + WINDOW_MS };
  const burn = (unitsPerMinute: number): LiveBurn => ({
    minutes: BURN_MINUTES,
    tokensPerMinute: 0,
    unitsPerMinute,
  });
  const now = T0 + HOUR;
  const timeOf = (ms: number) => ({ day: 'day', time: String(ms) });

  it('says when the reference is reached at the current speed', () => {
    // 6 units left at 0.1 per minute: 60 minutes, before the reset 4 hours later.
    const result = estimate(basis, burn(0.1), now, timeOf);
    expect(result.percent).toBeCloseTo(40, 10);
    expect(result.outcome).toBe('limitFirst');
    expect(result.limitAt).toBeCloseTo(now + 60 * MINUTE_MS, 3);
    expect(result.limitAtTime?.time).toBe(String(result.limitAt));
    expect(result).toMatchObject({
      resetsAt: T0 + WINDOW_MS,
      resetsAtTime: { time: String(T0 + WINDOW_MS) },
    });
  });

  it('says when the window resets first', () => {
    const result = estimate(basis, burn(0.01), now, timeOf);
    expect(result).toMatchObject({ outcome: 'resetsFirst', limitAt: null, limitAtTime: null });
    // Reaching the reference exactly at the reset: the reset comes first.
    const resetIn96 = { ...basis, resetsAt: now + 96 * MINUTE_MS };
    expect(estimate(resetIn96, burn(6 / 96), now, timeOf).outcome).toBe('resetsFirst');
    expect(estimate(resetIn96, burn(6 / 95), now, timeOf).outcome).toBe('limitFirst');
  });

  it('says when nothing is being used', () => {
    expect(estimate(basis, burn(0), now, timeOf).outcome).toBe('noRate');
  });

  it('says when the reference is already reached', () => {
    const result = estimate({ ...basis, units: 12 }, burn(1), now, timeOf);
    expect(result.outcome).toBe('reached');
    expect(result.percent).toBeCloseTo(120, 10);
  });

  it('starts from a base % and adds the units on top', () => {
    // 30% already used, 2 more units of 10: 50%; 5 units left at 0.1 per minute.
    const result = estimate({ ...basis, basePercent: 30, units: 2 }, burn(0.1), now, timeOf);
    expect(result.percent).toBeCloseTo(50, 10);
    expect(result.outcome).toBe('limitFirst');
    expect(result.limitAt).toBeCloseTo(now + 50 * MINUTE_MS, 3);
    expect(estimate({ ...basis, basePercent: 95, units: 1 }, burn(1), now, timeOf)).toMatchObject({
      outcome: 'reached',
      percent: 105,
    });
  });

  it('keeps the base % alone without a limit', () => {
    const noLimit = { ...basis, reference: { ...reference, units: null }, basePercent: 22 };
    expect(estimate(noLimit, burn(1), now, timeOf)).toMatchObject({
      outcome: 'noLimit',
      percent: 22,
      limitAt: null,
    });
    expect(estimate({ ...noLimit, basePercent: 100 }, burn(1), now, timeOf).outcome).toBe(
      'reached',
    );
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
    expect(live.estimate).toBeNull();

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
    const live = getLive(db, PRICING, undefined, 6, NOW);
    const [machine] = live.machines;
    expect(live.estimate).toBeNull();
    expect(machine).toMatchObject({
      status: 'idle',
      window: null,
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
    const live = getLive(db, PRICING, undefined, 1, NOW);
    const [machine] = live.machines;
    expect(machine).toMatchObject({ status: 'idle', window: null });
    expect(live.estimate).toBeNull();
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
    const live = getLive(db, PRICING, undefined, 3, NOW);
    const [machine] = live.machines;
    const estimated = live.estimate;
    const reference = opusUnits(big) * 2;
    const used = machine?.window?.units ?? 0;
    const perMinute = machine?.burn.unitsPerMinute ?? 0;

    expect(machine?.previous?.start).toBe(NOW - 24 * HOUR);
    expect(estimated?.reference).toMatchObject({
      kind: 'largestWindow',
      tokens: tokensOf(big) * 2,
      at: NOW - 24 * HOUR,
      atTime: { day: '2026-11-09', time: '12:00' },
      percent: null,
    });
    expect(estimated?.reference.units).toBeCloseTo(reference, 15);
    expect(estimated?.resetsAt).toBe(NOW + 3 * HOUR);
    expect(estimated?.percent).toBeCloseTo((used / reference) * 100, 10);
    expect(estimated?.outcome).toBe('limitFirst');
    expect(estimated?.limitAt).toBeCloseTo(NOW + ((reference - used) / perMinute) * MINUTE_MS, 3);
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

describe('reference settings', () => {
  it('checks the choice and the percentage', () => {
    expect(parseReferenceChoice('calibration')).toBe('calibration');
    expect(parseReferenceChoice('largestWindow')).toBe('largestWindow');
    for (const bad of ['claude', '', null, 1]) {
      expect(() => parseReferenceChoice(bad)).toThrow(InvalidRequestError);
    }
    expect(parseCalibrationPercent(38)).toBe(38);
    expect(parseCalibrationPercent(38.46)).toBe(38.5);
    expect(parseCalibrationPercent(100)).toBe(100);
    expect(parseCalibrationPercent(0.01)).toBe(0.1);
    for (const bad of [0, -5, 100.1, Number.NaN, Number.POSITIVE_INFINITY, '38', null]) {
      expect(() => parseCalibrationPercent(bad)).toThrow(InvalidRequestError);
    }
  });

  it('keeps the largest window until the user picks the calibration', () => {
    const db = openMemoryDb();
    open.push(db);
    expect(getReferenceChoice(db)).toBe('largestWindow');
    setReferenceChoice(db, 'calibration');
    expect(getReferenceChoice(db)).toBe('calibration');
    setReferenceChoice(db, 'largestWindow');
    expect(getReferenceChoice(db)).toBe('largestWindow');
  });
});

describe('calibration', () => {
  // The running window starts at NOW - 2 h; a big finished window the day before.
  const big: Usage = [100, 50, 0, 600];
  const HISTORY: Response[] = [
    { at: NOW - 24 * HOUR, u: big, session: SESSION_C },
    { at: NOW - 2 * HOUR },
    { at: NOW - 40 * MINUTE_MS },
  ];

  it('takes the units at that moment ÷ the % as the limit', async () => {
    const { db, root } = await liveDb(HISTORY);
    const atCalibration = opusUnits(DEFAULT_USAGE) * 2;
    expect(calibrate(db, PRICING, 25, NOW)).toEqual({ status: 'done' });
    expect(getReferenceChoice(db)).toBe('calibration');

    // Half an hour later, two more responses.
    // Another session, so the earlier lines are not written again (with new ids).
    writeResponses(root, [
      { at: NOW + 10 * MINUTE_MS, session: SESSION_B },
      { at: NOW + 20 * MINUTE_MS, u: [20, 10, 0, 200], session: SESSION_B },
    ]);
    await scanLogs(db, [root]);
    const later = NOW + 30 * MINUTE_MS;
    const live = getLive(db, PRICING, undefined, 3, later);
    const limit = atCalibration / 0.25;
    const used = atCalibration + opusUnits(DEFAULT_USAGE) + opusUnits([20, 10, 0, 200]);

    const estimateNow = live.estimate;
    expect(estimateNow?.reference).toMatchObject({
      kind: 'calibration',
      at: NOW,
      atTime: { day: '2026-11-10', time: '12:00' },
      percent: 25,
      tokens: null,
    });
    expect(estimateNow?.reference.units).toBeCloseTo(limit, 15);
    expect(estimateNow?.percent).toBeCloseTo((used / limit) * 100, 10);
    expect(estimateNow?.resetsAt).toBe(NOW + 3 * HOUR);

    expect(live.reference).toMatchObject({
      choice: 'calibration',
      calibration: { at: NOW, percent: 25 },
      canCalibrate: true,
      claudeEnabled: false,
      claude: null,
    });
    expect(live.reference.calibration?.units).toBeCloseTo(limit, 15);
    expect(live.reference.largest?.start).toBe(NOW - 24 * HOUR);
  });

  it('applies to later windows, and does not change with the prices', async () => {
    const { db, root } = await liveDb(HISTORY);
    calibrate(db, PRICING, 20, NOW);
    // A new window the next day.
    const nextDay = NOW + 24 * HOUR;
    writeResponses(root, [{ at: nextDay - HOUR, session: SESSION_B }]);
    await scanLogs(db, [root]);

    const limit = (opusUnits(DEFAULT_USAGE) * 2) / 0.2;
    const estimateNext = getLive(db, PRICING, undefined, 1, nextDay).estimate;
    expect(estimateNext?.reference.kind).toBe('calibration');
    expect(estimateNext?.percent).toBeCloseTo((opusUnits(DEFAULT_USAGE) / limit) * 100, 10);

    // Doubled prices double both sides: the % stays.
    const doubled: Pricing = {
      lastChecked: null,
      models: Object.fromEntries(
        Object.entries(PRICING.models).map(([model, price]) => [
          model,
          {
            input: price.input * 2,
            output: price.output * 2,
            cacheWrite: price.cacheWrite * 2,
            cacheWrite1h: price.cacheWrite1h * 2,
            cacheRead: price.cacheRead * 2,
          },
        ]),
      ),
    };
    const estimateDoubled = getLive(db, doubled, undefined, 1, nextDay).estimate;
    expect(estimateDoubled?.reference.units).toBeCloseTo(limit * 2, 15);
    expect(estimateDoubled?.percent).toBeCloseTo(estimateNext?.percent ?? 0, 10);
  });

  it('is refused without a running window', async () => {
    const { db } = await liveDb([{ at: NOW - 7 * HOUR }]);
    expect(calibrate(db, PRICING, 30, NOW)).toEqual({ status: 'noWindow' });
    expect(getReferenceChoice(db)).toBe('largestWindow');
    expect(getLive(db, PRICING, undefined, 1, NOW).reference).toMatchObject({
      calibration: null,
      canCalibrate: false,
    });
    // A window with only unpriced usage cannot be calibrated either.
    const { db: unpriced } = await liveDb([{ at: NOW - HOUR, model: 'claude-haiku-9-9' }]);
    expect(calibrate(unpriced, PRICING, 30, NOW)).toEqual({ status: 'noWindow' });
  });

  it('falls back to the largest window when its window is gone or not chosen', async () => {
    const { db } = await liveDb(HISTORY);
    // A moment no window holds (between the two windows).
    db.setSetting('live_calibration', JSON.stringify({ at: NOW - 10 * HOUR, percent: 20 }));
    setReferenceChoice(db, 'calibration');
    const live = getLive(db, PRICING, undefined, 3, NOW);
    expect(live.estimate?.reference.kind).toBe('largestWindow');
    expect(live.reference.calibration).toMatchObject({ at: NOW - 10 * HOUR, units: null });

    calibrate(db, PRICING, 20, NOW);
    setReferenceChoice(db, 'largestWindow');
    const chosen = getLive(db, PRICING, undefined, 3, NOW);
    expect(chosen.estimate?.reference.kind).toBe('largestWindow');
    expect(chosen.reference.calibration?.units).not.toBeNull();
  });

  it('ignores a stored calibration that is not as expected', async () => {
    const { db } = await liveDb(HISTORY);
    for (const stored of ['{', '[]', '{"at":"x","percent":20}', '{"at":1,"percent":0}']) {
      db.setSetting('live_calibration', stored);
      expect(getLive(db, PRICING, undefined, 3, NOW).reference.calibration).toBeNull();
    }
  });
});

describe('Claude’s own numbers', () => {
  // The running window starts at NOW - 2 h. Claude's window started earlier, at NOW - 3 h
  // (another computer), and resets at NOW + 2 h; Claude Code fetched 40% at NOW - 30 min.
  const RUNNING: Response[] = [
    { at: NOW - 2 * HOUR },
    { at: NOW - 40 * MINUTE_MS, project: 'web-shop', model: 'claude-sonnet-5-5' },
    { at: NOW - 10 * MINUTE_MS, u: [20, 10, 0, 200] },
    { at: NOW - 2 * MINUTE_MS, project: 'web-shop', session: SESSION_B },
  ];
  const sonnetUnits = (20 + 50 + 50) / 1e6;
  const usage = { fetchedAt: NOW - 30 * MINUTE_MS, percent: 40, resetsAt: NOW + 2 * HOUR };

  it('starts from Claude’s % and its reset time, and adds the usage since', async () => {
    const { db } = await liveDb(RUNNING);
    const live = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage });
    const before = opusUnits(DEFAULT_USAGE) + sonnetUnits;
    const since = opusUnits([20, 10, 0, 200]) + opusUnits(DEFAULT_USAGE);
    const limit = before / 0.4;

    const result = live.estimate;
    expect(result?.reference).toMatchObject({
      kind: 'claude',
      at: usage.fetchedAt,
      atTime: { day: '2026-11-10', time: '11:30' },
      percent: 40,
      tokens: null,
    });
    expect(result?.reference.units).toBeCloseTo(limit, 15);
    expect(result?.percent).toBeCloseTo(40 + (since / limit) * 100, 10);
    // Claude's reset, not the rebuilt window's (NOW + 3 h).
    expect(result).toMatchObject({
      resetsAt: NOW + 2 * HOUR,
      resetsAtTime: { day: '2026-11-10', time: '14:00' },
    });
    expect(live.machines[0]?.window?.end).toBe(NOW + 3 * HOUR);
    expect(live.reference).toMatchObject({
      claudeEnabled: true,
      claude: { ...usage, fresh: true, fetchedAtTime: { time: '11:30' } },
    });
  });

  it('uses the chosen reference’s limit when Claude’s % cannot give one', async () => {
    // No response of this machine before Claude's numbers were fetched.
    const big: Usage = [100, 50, 0, 600];
    const { db } = await liveDb([
      { at: NOW - 24 * HOUR, u: big, session: SESSION_C },
      { at: NOW - 10 * MINUTE_MS },
    ]);
    const live = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage });
    const result = live.estimate;
    const largest = opusUnits(big);
    expect(result?.reference.kind).toBe('claude');
    expect(result?.reference.units).toBeCloseTo(largest, 15);
    expect(result?.percent).toBeCloseTo(40 + (opusUnits(DEFAULT_USAGE) / largest) * 100, 10);

    // Nothing to take a limit from: Claude's % alone.
    const { db: alone } = await liveDb([{ at: NOW - 10 * MINUTE_MS }]);
    const single = getLive(alone, PRICING, undefined, 3, NOW, { enabled: true, usage });
    expect(single.estimate).toMatchObject({
      outcome: 'noLimit',
      percent: 40,
      reference: { kind: 'claude', units: null },
    });
  });

  it('never takes a limit below the largest window, nor from under 5%', async () => {
    // A large finished window; then Claude says 40% while this machine used little.
    const big: Usage = [100, 50, 0, 600];
    const { db } = await liveDb([{ at: NOW - 24 * HOUR, u: big, session: SESSION_C }, ...RUNNING]);
    const largest = opusUnits(big);
    const derived = (opusUnits(DEFAULT_USAGE) + sonnetUnits) / 0.4;
    expect(derived).toBeLessThan(largest);
    const floored = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage });
    expect(floored.estimate?.reference.units).toBeCloseTo(largest, 15);

    // 4%: too coarse, the chosen reference's limit (the largest window) is used.
    const coarse = { ...usage, percent: 4 };
    const low = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage: coarse });
    expect(low.estimate?.reference).toMatchObject({ kind: 'claude', percent: 4 });
    expect(low.estimate?.reference.units).toBeCloseTo(largest, 15);
  });

  it('is left out once its reset has passed, or when turned off', async () => {
    const big: Usage = [100, 50, 0, 600];
    const { db } = await liveDb([{ at: NOW - 24 * HOUR, u: big, session: SESSION_C }, ...RUNNING]);
    const old = { fetchedAt: NOW - 8 * HOUR, percent: 70, resetsAt: NOW - 4 * HOUR };
    const stale = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage: old });
    expect(stale.estimate?.reference.kind).toBe('largestWindow');
    expect(stale.estimate?.resetsAt).toBe(NOW + 3 * HOUR);
    expect(stale.reference.claude).toMatchObject({ percent: 70, fresh: false });

    const off = getLive(db, PRICING, undefined, 3, NOW, { enabled: false, usage });
    expect(off.estimate?.reference.kind).toBe('largestWindow');
    expect(off.reference).toMatchObject({ claudeEnabled: false, claude: null });
  });

  it('gives no estimate without a running window on this machine', async () => {
    const { db } = await liveDb([{ at: NOW - 7 * HOUR }]);
    const live = getLive(db, PRICING, undefined, 3, NOW, { enabled: true, usage });
    expect(live.machines[0]).toMatchObject({ status: 'idle' });
    expect(live.estimate).toBeNull();
    expect(live.reference.claude?.fresh).toBe(true);
  });
});

describe('live.json of this computer', () => {
  it('carries its minutes by project and model, its runs of responses and its windows', async () => {
    const { db } = await liveDb([
      { at: NOW - 26 * HOUR, session: SESSION_C }, // older than the 24 hours of runs
      { at: NOW - 7 * HOUR, session: SESSION_C }, // before the 6 hours of minutes
      { at: NOW - 2 * HOUR - 30_000, session: SESSION_C }, // the same window's last response
      { at: NOW - 90 * MINUTE_MS },
      { at: NOW - 90 * MINUTE_MS + 20_000, project: 'web-shop', model: 'claude-sonnet-5-5' },
      { at: NOW - 90 * MINUTE_MS + 25_000 },
      { at: NOW - 10 * MINUTE_MS, u: [20, 10, 0, 200] },
    ]);
    const file = buildLiveFile(db, PRICING, NOW);
    expect(file).toEqual({
      schemaVersion: 1,
      machineId: db.machineId,
      writtenAt: NOW,
      minutesFrom: Date.parse('2026-11-10T06:01:00Z'),
      activityFrom: NOW - 24 * HOUR,
      window: {
        start: NOW - 90 * MINUTE_MS,
        last: NOW - 10 * MINUTE_MS,
        responses: 4,
        models: [
          ['Opus 5.5', 40, 20, 0, 400, 0],
          ['Sonnet 5.5', 10, 5, 0, 100, 0],
        ],
      },
      previous: {
        start: NOW - 7 * HOUR,
        last: NOW - 2 * HOUR - 30_000,
        responses: 2,
        models: [['Opus 5.5', 20, 10, 0, 200, 0]],
      },
      activity: [
        [NOW - 7 * HOUR, NOW - 7 * HOUR],
        [NOW - 2 * HOUR - 30_000, NOW - 2 * HOUR - 30_000],
        [NOW - 90 * MINUTE_MS, NOW - 90 * MINUTE_MS + 25_000],
        [NOW - 10 * MINUTE_MS, NOW - 10 * MINUTE_MS],
      ],
      minutes: [
        [
          NOW - 2 * HOUR - 30_000,
          NOW - 2 * HOUR - 30_000,
          'demo-app',
          'Opus 5.5',
          10,
          5,
          0,
          100,
          0,
          1,
        ],
        [
          NOW - 90 * MINUTE_MS,
          NOW - 90 * MINUTE_MS + 25_000,
          'demo-app',
          'Opus 5.5',
          20,
          10,
          0,
          200,
          0,
          2,
        ],
        [
          NOW - 90 * MINUTE_MS + 20_000,
          NOW - 90 * MINUTE_MS + 20_000,
          'web-shop',
          'Sonnet 5.5',
          10,
          5,
          0,
          100,
          0,
          1,
        ],
        [NOW - 10 * MINUTE_MS, NOW - 10 * MINUTE_MS, 'demo-app', 'Opus 5.5', 20, 10, 0, 200, 0, 1],
      ],
    } satisfies LiveFile);
    expect(parseLiveFile(serializeLiveFile(file), db.machineId)).toEqual({
      ok: true,
      skippedRows: 0,
      value: file,
    });
  });

  it('has no window and no minutes on a computer that has not been used', () => {
    const db = openMemoryDb();
    open.push(db);
    expect(buildLiveFile(db, PRICING, NOW)).toMatchObject({
      window: null,
      previous: null,
      activity: [],
      minutes: [],
    });
  });
});

describe('chainRuns', () => {
  const T = Date.parse('2026-11-10T08:00:00Z');

  it('chains single responses like the windows of one computer', () => {
    const times = [T, T + HOUR, T + 5 * HOUR, T + 5 * HOUR + MINUTE_MS, T + 11 * HOUR];
    expect(chainRuns(times.map((time) => [time, time]))).toEqual(
      chainWindows(times.map((time) => point(time))).map(({ start, end }) => ({ start, end })),
    );
  });

  it('starts the next window at the reset inside a run of responses', () => {
    expect(chainRuns([[T, T + 11 * HOUR]])).toEqual([
      { start: T, end: T + 5 * HOUR },
      { start: T + 5 * HOUR, end: T + 10 * HOUR },
      { start: T + 10 * HOUR, end: T + 15 * HOUR },
    ]);
  });

  it('merges the runs of several computers, whatever their order', () => {
    // The second computer starts first; the first one's run crosses the reset.
    expect(
      chainRuns([
        [T + 2 * HOUR, T + 6 * HOUR],
        [T, T + 10 * MINUTE_MS],
      ]),
    ).toEqual([
      { start: T, end: T + 5 * HOUR },
      { start: T + 5 * HOUR, end: T + 10 * HOUR },
    ]);
  });

  it('continues the window already running', () => {
    const running = { start: T - 4 * HOUR, end: T + HOUR };
    expect(chainRuns([[T + 30 * MINUTE_MS, T + 30 * MINUTE_MS]], running)).toEqual([running]);
    expect(chainRuns([[T + HOUR, T + HOUR]], running)).toEqual([
      running,
      { start: T + HOUR, end: T + 6 * HOUR },
    ]);
  });
});

describe('other computers', () => {
  const big: Usage = [100, 50, 0, 600];
  const sonnet = (20 + 50 + 50) / 1e6;
  /** This computer: a big finished window yesterday, and a window since NOW - 2 h. */
  const LOCAL: Response[] = [
    { at: NOW - 24 * HOUR, u: big, session: SESSION_C },
    { at: NOW - 2 * HOUR },
    { at: NOW - 10 * MINUTE_MS, u: [20, 10, 0, 200] },
  ];
  /** The Mac: its window started at NOW - 3 h, an hour before this computer's. */
  const MAC: Response[] = [
    { at: NOW - 3 * HOUR, project: 'api' },
    { at: NOW - 3 * HOUR + 30_000, project: 'api' },
    { at: NOW - 45 * MINUTE_MS, model: 'claude-sonnet-5-5' },
    { at: NOW - 3 * MINUTE_MS, project: 'api', u: [40, 20, 0, 400] },
  ];
  const localUnits = opusUnits(DEFAULT_USAGE) + opusUnits([20, 10, 0, 200]);
  const macUnits = 2 * opusUnits(DEFAULT_USAGE) + sonnet + opusUnits([40, 20, 0, 400]);

  /** This computer's database, with the Mac known from its machine.json, and the Mac's live.json. */
  async function withMac(
    local: readonly Response[],
    mac: readonly Response[],
    { writtenAt = NOW - 30_000, appVersion = '0.1.2' as string | null } = {},
  ) {
    const { db } = await liveDb(local);
    const { db: macDb } = await liveDb(mac);
    db.upsertRemoteMachine({
      id: macDb.machineId,
      name: 'MacBook',
      platform: 'darwin',
      lastSync: null,
      appVersion,
    });
    return { db, macDb, macId: macDb.machineId, file: buildLiveFile(macDb, PRICING, writtenAt) };
  }

  it('merges every computer into one window that starts with the first of them', async () => {
    const { db, macId, file } = await withMac(LOCAL, MAC);
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);

    expect(live.combined).toMatchObject({
      status: 'active',
      previous: null,
      machines: [
        { machineId: db.machineId, name: 'test-machine' },
        { machineId: macId, name: 'MacBook' },
      ],
    });
    expect(live.combined?.window).toMatchObject({
      start: NOW - 3 * HOUR,
      end: NOW + 2 * HOUR,
      endAt: { day: '2026-11-10', time: '14:00' },
      total: 345 + 805,
      responses: 6,
    });
    expect(live.combined?.window?.units).toBeCloseTo(localUnits + macUnits, 15);
    const burn = (opusUnits([20, 10, 0, 200]) + opusUnits([40, 20, 0, 400])) / BURN_MINUTES;
    expect(live.combined?.burn.unitsPerMinute).toBeCloseTo(burn, 15);

    // Each computer's own window: the Mac's from its file.
    expect(live.machines.map((m) => [m.name, m.status, m.window?.start, m.window?.total])).toEqual([
      ['test-machine', 'active', NOW - 2 * HOUR, 345],
      ['MacBook', 'active', NOW - 3 * HOUR, 805],
    ]);
    expect(live.machines[1]).toMatchObject({
      liveAt: NOW - 30_000,
      liveAtTime: { day: '2026-11-10', time: '12:00' },
      lastResponse: NOW - 3 * MINUTE_MS,
      previous: null,
    });
    expect(live.machines[1]?.window?.units).toBeCloseTo(macUnits, 15);

    // The chart and the projects in use hold both computers.
    expect(live.series.map((series) => [series.project, series.tokens])).toEqual([
      ['api', 690],
      ['demo-app', 460],
    ]);
    const minuteOf = (at: number) =>
      live.minutes.find((m) => m.t === Math.floor(at / MINUTE_MS) * MINUTE_MS);
    expect(minuteOf(NOW - 3 * MINUTE_MS)?.tokens).toEqual([460, 0]);
    expect(live.active).toEqual([
      {
        project: 'api',
        models: ['Opus 5.5'],
        tokens: 460,
        last: NOW - 3 * MINUTE_MS,
        lastAt: { day: '2026-11-10', time: '11:57' },
      },
    ]);

    // The estimate counts both, against this computer's largest window; Claude's reset is
    // the combined window's.
    expect(live.estimate?.reference).toMatchObject({ kind: 'largestWindow', at: NOW - 24 * HOUR });
    expect(live.estimate?.percent).toBeCloseTo(
      ((localUnits + macUnits) / opusUnits(big)) * 100,
      10,
    );
    expect(live.estimate?.resetsAt).toBe(NOW + 2 * HOUR);
    expect(live.reference.scope).toEqual({ counted: ['MacBook'], others: 1 });
    expect(live.reference.canCalibrate).toBe(true);
  });

  it('follows the selection for the windows and the chart, never for the estimate', async () => {
    const { db, macId, file } = await withMac(LOCAL, MAC);
    const all = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);

    const local = getLive(db, PRICING, [db.machineId], 6, NOW, undefined, [file]);
    expect(local.machines.map((machine) => machine.name)).toEqual(['test-machine']);
    expect(local.series.map((series) => [series.project, series.tokens])).toEqual([
      ['demo-app', 345],
    ]);
    expect(local.combined).toEqual(all.combined);
    expect(local.estimate).toEqual(all.estimate);

    const mac = getLive(db, PRICING, [macId], 6, NOW, undefined, [file]);
    expect(mac.hasData).toBe(true);
    expect(mac.machines.map((machine) => [machine.name, machine.status])).toEqual([
      ['MacBook', 'active'],
    ]);
    expect(mac.series.map((series) => [series.project, series.tokens])).toEqual([
      ['api', 690],
      ['demo-app', 115],
    ]);
    expect(mac.estimate).toEqual(all.estimate);
  });

  it('leaves stale live data out of the window and the estimate, not out of the chart', async () => {
    const writtenAt = NOW - LIVE_FRESH_MS - 1_000;
    const { db, file } = await withMac(LOCAL, MAC, { writtenAt });
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);

    expect(live.combined).toBeNull();
    expect(live.machines[1]).toMatchObject({
      status: 'stale',
      window: null,
      liveAt: writtenAt,
      liveAtTime: { day: '2026-11-10', time: '11:45' },
    });
    expect(live.estimate?.resetsAt).toBe(NOW + 3 * HOUR);
    expect(live.estimate?.percent).toBeCloseTo((localUnits / opusUnits(big)) * 100, 10);
    expect(live.reference.scope).toEqual({ counted: [], others: 1 });
    // What the Mac did up to its last write is still on the chart.
    expect(live.series.map((series) => [series.project, series.tokens])).toEqual([
      ['demo-app', 460],
      ['api', 230],
    ]);
    // Written exactly 15 minutes ago: still fresh.
    const edge = await withMac(LOCAL, MAC, { writtenAt: NOW - LIVE_FRESH_MS });
    expect(
      getLive(edge.db, PRICING, undefined, 6, NOW, undefined, [edge.file]).combined,
    ).not.toBeNull();
  });

  it('says when another computer has shared no live data, or needs a newer app', async () => {
    const { db } = await liveDb(LOCAL);
    for (const [id, name, appVersion] of [
      ['remote-old', 'Old PC', '0.1.1'],
      ['remote-new', 'New PC', '0.1.2'],
      ['remote-dev', 'Dev PC', null],
    ] as const) {
      db.upsertRemoteMachine({ id, name, platform: 'win32', lastSync: null, appVersion });
    }
    const live = getLive(db, PRICING, undefined, 3, NOW);
    expect(live.machines.map((machine) => [machine.name, machine.status])).toEqual([
      ['test-machine', 'active'],
      ['Dev PC', 'noLiveData'],
      ['New PC', 'noLiveData'],
      ['Old PC', 'needsUpdate'],
    ]);
    expect(live.reference.scope).toEqual({ counted: [], others: 3 });

    // A live.json counts, whatever version its machine.json says.
    const old = await withMac(LOCAL, MAC, { appVersion: '0.1.1' });
    const withFile = getLive(old.db, PRICING, undefined, 3, NOW, undefined, [old.file]);
    expect(withFile.machines[1]?.status).toBe('active');
  });

  it('derives Claude’s limit from every computer’s usage, else from this one’s', async () => {
    const { db, file } = await withMac(LOCAL, MAC);
    // Claude's window started with the Mac, at NOW - 3 h.
    const usage = { fetchedAt: NOW - 30 * MINUTE_MS, percent: 40, resetsAt: NOW + 2 * HOUR };
    const claude = { enabled: true, usage };
    const before = 3 * opusUnits(DEFAULT_USAGE) + sonnet;
    const since = opusUnits([20, 10, 0, 200]) + opusUnits([40, 20, 0, 400]);
    expect(before / 0.4).toBeGreaterThan(opusUnits(big));

    const live = getLive(db, PRICING, undefined, 6, NOW, claude, [file]);
    expect(live.estimate?.reference).toMatchObject({ kind: 'claude', percent: 40 });
    expect(live.estimate?.reference.units).toBeCloseTo(before / 0.4, 15);
    expect(live.estimate?.percent).toBeCloseTo(40 + (since / (before / 0.4)) * 100, 10);
    expect(live.estimate?.resetsAt).toBe(NOW + 2 * HOUR);

    // No fresh live data: this computer's usage only. Too small a limit (the Mac's part of
    // Claude's % is not counted), so a higher %: the safe side. This computer's largest
    // window is no floor with another computer around (it may span two account windows).
    const alone = getLive(db, PRICING, undefined, 6, NOW, claude);
    const localLimit = opusUnits(DEFAULT_USAGE) / 0.4;
    expect(alone.estimate?.reference.units).toBeCloseTo(localLimit, 15);
    expect(alone.estimate?.percent).toBeCloseTo(
      40 + (opusUnits([20, 10, 0, 200]) / localLimit) * 100,
      10,
    );
    expect(alone.reference.scope.counted).toEqual([]);
  });

  it('keeps the other computers of a calibration once their live data is gone', async () => {
    const { db, file } = await withMac(LOCAL, MAC);
    expect(calibrate(db, PRICING, 25, NOW, [file])).toEqual({ status: 'done' });
    const limit = (localUnits + macUnits) / 0.25;

    // Half an hour later the Mac's file is stale: the calibration still counts it.
    const later = NOW + 30 * MINUTE_MS;
    const live = getLive(db, PRICING, undefined, 6, later, undefined, [file]);
    expect(live.combined).toBeNull();
    expect(live.reference.calibration).toMatchObject({ at: NOW, percent: 25, computers: 2 });
    expect(live.reference.calibration?.units).toBeCloseTo(limit, 15);
    expect(live.estimate?.reference.kind).toBe('calibration');
    expect(live.estimate?.reference.units).toBeCloseTo(limit, 15);

    // At doubled prices, both sides double.
    const doubled: Pricing = {
      lastChecked: null,
      models: Object.fromEntries(
        Object.entries(PRICING.models).map(([model, price]) => [
          model,
          {
            input: price.input * 2,
            output: price.output * 2,
            cacheWrite: price.cacheWrite * 2,
            cacheWrite1h: price.cacheWrite1h * 2,
            cacheRead: price.cacheRead * 2,
          },
        ]),
      ),
    };
    const repriced = getLive(db, doubled, undefined, 6, later, undefined, [file]);
    expect(repriced.reference.calibration?.units).toBeCloseTo(limit * 2, 15);

    // Without live data it counts this computer only.
    calibrate(db, PRICING, 25, later);
    expect(getLive(db, PRICING, undefined, 6, later).reference.calibration).toMatchObject({
      computers: 1,
    });
  });

  it('shows the combined window that has reset before the running one', async () => {
    // The Mac at NOW - 5 h 30 and NOW - 4 h: that window resets at NOW - 30 min; this
    // computer's response at NOW - 20 min starts the next one.
    const { db, file } = await withMac(
      [{ at: NOW - 20 * MINUTE_MS }],
      [{ at: NOW - 5.5 * HOUR }, { at: NOW - 4 * HOUR }],
    );
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(live.combined?.window).toMatchObject({ start: NOW - 20 * MINUTE_MS, responses: 1 });
    expect(live.combined?.previous).toMatchObject({
      start: NOW - 5.5 * HOUR,
      end: NOW - 30 * MINUTE_MS,
      total: 230,
      responses: 2,
    });
    expect(live.machines[1]).toMatchObject({ status: 'idle', window: null });
    expect(live.machines[1]?.previous?.start).toBe(NOW - 5.5 * HOUR);
  });

  it('never floors Claude’s limit with one computer’s own window when there are others', async () => {
    // This computer at NOW - 10 h starts the account's window; the Mac joins it at NOW - 9 h
    // and starts the next one at NOW - 4 h 30. The Mac's own window (NOW - 9 h to NOW - 4 h)
    // spans both: it holds more than one account window can.
    const huge: Usage = [300, 100, 0, 1000];
    const { db, file } = await withMac(
      [{ at: NOW - 10 * HOUR }, { at: NOW - 10 * MINUTE_MS }],
      [
        { at: NOW - 9 * HOUR, u: huge },
        { at: NOW - 4.5 * HOUR, u: big },
      ],
    );
    const usage = { fetchedAt: NOW - 5 * MINUTE_MS, percent: 50, resetsAt: NOW + 0.5 * HOUR };
    const live = getLive(db, PRICING, undefined, 6, NOW, { enabled: true, usage }, [file]);
    const derived = (opusUnits(big) + opusUnits(DEFAULT_USAGE)) / 0.5;
    expect(opusUnits(huge) + opusUnits(big)).toBeGreaterThan(derived);
    expect(live.combined?.window?.start).toBe(NOW - 4.5 * HOUR);
    expect(live.estimate?.reference.kind).toBe('claude');
    expect(live.estimate?.reference.units).toBeCloseTo(derived, 15);
    // The largest window is this computer's own, the Mac's is not taken.
    expect(live.reference.largest).toMatchObject({ start: NOW - 10 * HOUR, computers: 1 });
  });

  it('completes a calibration with the other computer’s usage written after it', async () => {
    // The Mac's copy is 5 minutes old when the calibration is entered: its response at
    // NOW - 3 min is not in it yet, while the % Claude showed counted it.
    const { db, macDb, file } = await withMac(LOCAL, MAC, { writtenAt: NOW - 5 * MINUTE_MS });
    calibrate(db, PRICING, 25, NOW, [file]);
    const early = (localUnits + macUnits - opusUnits([40, 20, 0, 400])) / 0.25;
    expect(getLive(db, PRICING, undefined, 6, NOW).reference.calibration?.units).toBeCloseTo(
      early,
      15,
    );

    const later = buildLiveFile(macDb, PRICING, NOW + MINUTE_MS);
    const live = getLive(db, PRICING, undefined, 6, NOW + MINUTE_MS, undefined, [later]);
    expect(live.reference.calibration).toMatchObject({ computers: 2 });
    expect(live.reference.calibration?.units).toBeCloseTo((localUnits + macUnits) / 0.25, 15);
    // A copy that lacks part of it never lowers it.
    getLive(db, PRICING, undefined, 6, NOW + MINUTE_MS, undefined, [file]);
    expect(getLive(db, PRICING, undefined, 6, NOW).reference.calibration?.units).toBeCloseTo(
      (localUnits + macUnits) / 0.25,
      15,
    );
  });

  it('says when another computer’s live data needs a newer version of this app', async () => {
    const { db, macId, file } = await withMac(LOCAL, MAC);
    const newer = getLive(db, PRICING, undefined, 3, NOW, undefined, [], [macId]);
    expect(newer.machines[1]?.status).toBe('newerApp');
    // Its last good copy, while still fresh, is used.
    const fresh = getLive(db, PRICING, undefined, 3, NOW, undefined, [file], [macId]);
    expect(fresh.machines[1]?.status).toBe('active');
  });

  it('counts only the computers that used the window', async () => {
    // The Mac's app runs, but it was not used in this computer's window.
    const { db, file } = await withMac(LOCAL, [{ at: NOW - 12 * HOUR }]);
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(live.reference.scope.counted).toEqual(['MacBook']);
    expect(live.combined?.machines.map((machine) => machine.name)).toEqual(['test-machine']);
  });

  it('remembers a combined window once it has reset, as the largest window', async () => {
    // The Mac at NOW - 5 h 10, this computer at NOW - 5 h: one window until NOW - 10 min.
    // This computer again at NOW - 5 min: the next window.
    const local: Response[] = [{ at: NOW - 5 * HOUR }, { at: NOW - 5 * MINUTE_MS }];
    const mac: Response[] = [
      { at: NOW - 5 * HOUR - 10 * MINUTE_MS, u: big },
      { at: NOW - 4 * HOUR, u: big },
    ];
    // Written before that window reset: the Mac may have used it since, nothing is kept.
    const early = await withMac(local, mac, { writtenAt: NOW - 12 * MINUTE_MS });
    getLive(early.db, PRICING, undefined, 6, NOW, undefined, [early.file]);
    expect(early.db.getSetting('live_combined_windows')).toBeNull();

    const { db, file } = await withMac(local, mac);
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(live.combined?.previous).toMatchObject({
      start: NOW - 5 * HOUR - 10 * MINUTE_MS,
      responses: 3,
    });
    const units = 2 * opusUnits(big) + opusUnits(DEFAULT_USAGE);
    expect(live.reference.largest).toMatchObject({ computers: 2 });
    expect(live.reference.largest?.units).toBeCloseTo(units, 15);

    // Hours later, without any live data: still the largest window, at the current prices.
    const later = NOW + 6 * HOUR;
    const alone = getLive(db, PRICING, undefined, 6, later);
    expect(alone.reference.largest).toMatchObject({
      start: NOW - 5 * HOUR - 10 * MINUTE_MS,
      computers: 2,
    });
    const half: Pricing = {
      lastChecked: null,
      models: { 'Opus 5.5': { ...flat, input: 0.5, output: 5, cacheRead: 0.25 } },
    };
    const repriced = getLive(db, half, undefined, 6, later);
    expect(repriced.reference.largest?.units).toBeCloseTo(units / 2, 15);
  });

  it('remembers combined windows without the Live page, and only those of two computers', async () => {
    const mac: Response[] = [{ at: NOW - 5 * HOUR - 10 * MINUTE_MS }, { at: NOW - 4 * HOUR }];
    // This computer did not use that window: the Mac's own window, not remembered.
    const single = await withMac([{ at: NOW - 5 * MINUTE_MS }], mac);
    rememberCombinedWindows(single.db, PRICING, [single.file], NOW);
    expect(single.db.getSetting('live_combined_windows')).toBeNull();

    const both = await withMac([{ at: NOW - 5 * HOUR }, { at: NOW - 5 * MINUTE_MS }], mac);
    rememberCombinedWindows(both.db, PRICING, [both.file], NOW);
    const stored = JSON.parse(both.db.getSetting('live_combined_windows') ?? '[]') as unknown[];
    expect(stored).toEqual([
      {
        start: NOW - 5 * HOUR - 10 * MINUTE_MS,
        computers: 2,
        models: [['Opus 5.5', 30, 15, 0, 300, 0]],
      },
    ]);
  });

  it('ignores a hidden computer, and names the projects with this computer’s aliases', async () => {
    const { db, macId, file } = await withMac(LOCAL, MAC);
    db.setProjectAliases([{ from: 'api', to: 'demo-app' }]);
    const aliased = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(aliased.series.map((series) => [series.project, series.tokens])).toEqual([
      ['demo-app', 1150],
    ]);

    db.setMachineHidden(macId, true);
    const hidden = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(hidden.combined).toBeNull();
    expect(hidden.machines.map((machine) => machine.name)).toEqual(['test-machine']);
    expect(hidden.series.map((series) => [series.project, series.tokens])).toEqual([
      ['demo-app', 345],
    ]);
    expect(hidden.reference.scope).toEqual({ counted: [], others: 0 });
  });

  it('leaves out the minutes another computer dated after this one’s clock', async () => {
    // The Mac's clock is 2 minutes ahead: its file is still fresh, its last minute not yet here.
    const { db, file } = await withMac(LOCAL, [...MAC, { at: NOW + MINUTE_MS, project: 'api' }], {
      writtenAt: NOW + 2 * MINUTE_MS,
    });
    const live = getLive(db, PRICING, undefined, 6, NOW, undefined, [file]);
    expect(live.combined?.window?.responses).toBe(6);
    expect(live.series.find((series) => series.project === 'api')?.tokens).toBe(690);
  });
});
