/**
 * The Live page: the last hours of usage minute by minute, and the 5-hour usage window
 * rebuilt from the times of the responses.
 *
 * Window rule: a window starts with the first response after the previous window ended
 * and resets 5 hours later. A response at the exact reset time starts the next window.
 * A pause of 5 hours or more therefore always ends a window. Claude starts the window
 * with the prompt, a few seconds before its first response; the logs only have the
 * responses' times. Claude's limit is per account: usage on other computers or on
 * claude.ai counts in the same window and is not in these logs.
 *
 * Estimates are in API-price units: each response weighs what it would cost at API prices
 * (`pricing.json`, per model and token type). Claude does not publish its limits; this is
 * the closest local measure, whereas raw tokens would be mostly cheap cache reads.
 */
import type {
  Live,
  LiveBurn,
  LiveEstimate,
  LiveHours,
  LiveMachine,
  LiveMinute,
  LiveProject,
  LiveReference,
  LiveSeries,
  LiveWindow,
  Pricing,
  TokenBreakdown,
} from '../shared/types';
import { hasAnyUsage, InvalidRequestError } from './aggregate';
import type { ResponseRow, UsageDatabase } from './db';
import { costOf } from './pricing';

export const WINDOW_MS = 5 * 60 * 60_000;
export const MINUTE_MS = 60_000;
/** The burn rate is the usage of the last 15 minutes, per minute. */
export const BURN_MINUTES = 15;
/** A project is in use when it had a response in the last 5 minutes. */
export const ACTIVE_MINUTES = 5;
export const LIVE_HOURS: readonly LiveHours[] = [1, 3, 6];
/** The chart shows at most this many series; past it, the smaller projects are merged. */
export const LIVE_SERIES = 6;

// ── Windows ───────────────────────────────────────────────────────────────────

/** One response weighed: its tokens and API-price units. */
export interface UsagePoint {
  /** Epoch milliseconds. */
  ts: number;
  tokens: TokenBreakdown;
  /** US dollars at API prices; 0 for a model without a price. */
  units: number;
  /** Tokens of a model without a price, left out of `units`. */
  unpriced: number;
  /** How many responses the point stands for. */
  responses: number;
}

export interface UsageWindow {
  start: number;
  /** The reset time: `start` + 5 hours. */
  end: number;
  /** The window's last response. */
  last: number;
  tokens: TokenBreakdown;
  units: number;
  unpriced: number;
  responses: number;
}

function totalOf(tokens: TokenBreakdown): number {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;
}

/**
 * Adds a point to a chain of windows. Points must come in time order: a point joins the
 * last window while it has not reset, and starts the next window otherwise.
 */
export function addToWindows(windows: UsageWindow[], point: UsagePoint): void {
  let window = windows.at(-1);
  if (!window || point.ts >= window.end) {
    window = {
      start: point.ts,
      end: point.ts + WINDOW_MS,
      last: point.ts,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      units: 0,
      unpriced: 0,
      responses: 0,
    };
    windows.push(window);
  }
  window.last = Math.max(window.last, point.ts);
  window.tokens.input += point.tokens.input;
  window.tokens.output += point.tokens.output;
  window.tokens.cacheWrite += point.tokens.cacheWrite;
  window.tokens.cacheRead += point.tokens.cacheRead;
  window.units += point.units;
  window.unpriced += point.unpriced;
  window.responses += point.responses;
}

/** The windows of points in time order. */
export function chainWindows(points: Iterable<UsagePoint>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const point of points) addToWindows(windows, point);
  return windows;
}

/** Weighs one response at the given prices. */
export function weigh(pricing: Pricing, row: ResponseRow): UsagePoint {
  const tokens = {
    input: row.input,
    output: row.output,
    cacheWrite: row.cacheWrite,
    cacheRead: row.cacheRead,
  };
  const cost = costOf(pricing, row.model, { ...tokens, cacheWrite1h: row.cacheWrite1h });
  return {
    ts: row.ts,
    tokens,
    units: cost ?? 0,
    unpriced: cost === null ? totalOf(tokens) : 0,
    responses: 1,
  };
}

/**
 * This machine's windows up to `now`, kept between calls. Windows before the last one
 * never change unless older responses arrive or grow, so each call only reads the
 * responses from the start of the last window on. It reads everything again when the
 * prices change, when the database rebuilt every derived row (`fullRefreshes`), when the
 * number of older responses changed, when an older response's tokens grew (a later copy
 * of a streamed response, `takeEarliestUpgrade`), or when `now` went back.
 *
 * Responses dated after `now` (a clock set ahead) are left out until their time comes, so
 * they never hide the running window.
 */
class WindowHistory {
  private windows: UsageWindow[] = [];
  private pricing: Pricing | null = null;
  private refreshes = -1;
  private now = Number.NEGATIVE_INFINITY;

  update(db: UsageDatabase, pricing: Pricing, now: number): readonly UsageWindow[] {
    const upgraded = db.takeEarliestUpgrade();
    if (pricing !== this.pricing || db.fullRefreshes !== this.refreshes || now < this.now) {
      this.windows = [];
    }
    let frozen = this.windows.slice(0, -1);
    const tail = this.windows.at(-1);
    let from = tail?.start ?? Number.MIN_SAFE_INTEGER;
    if (tail) {
      const expected = frozen.reduce((sum, window) => sum + window.responses, 0);
      const olderGrew = upgraded !== null && upgraded < tail.start;
      if (olderGrew || db.responsesBefore(tail.start) !== expected) {
        frozen = [];
        from = Number.MIN_SAFE_INTEGER;
      }
    }
    // Cached windows are never changed: every response read here is at or after `from`,
    // which is past the end of the last frozen window.
    const windows = frozen;
    for (const row of db.responsesFrom(from, now)) addToWindows(windows, weigh(pricing, row));
    this.windows = windows;
    this.pricing = pricing;
    this.refreshes = db.fullRefreshes;
    this.now = now;
    return windows;
  }
}

const histories = new WeakMap<UsageDatabase, WindowHistory>();

/** Every window of this machine's history up to `now`, oldest first. */
export function localWindows(
  db: UsageDatabase,
  pricing: Pricing,
  now = Date.now(),
): readonly UsageWindow[] {
  let history = histories.get(db);
  if (!history) {
    history = new WindowHistory();
    histories.set(db, history);
  }
  return history.update(db, pricing, now);
}

// ── Estimates ─────────────────────────────────────────────────────────────────

/** The window running at `now`, if any. */
export function currentWindow(windows: readonly UsageWindow[], now: number): UsageWindow | null {
  const last = windows.at(-1);
  return last && last.start <= now && now < last.end ? last : null;
}

/** The finished window with the most units (the latest on a tie), or null. */
export function largestWindow(
  windows: readonly UsageWindow[],
  current: UsageWindow | null,
): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of windows) {
    if (window === current) continue;
    if (!best || window.units >= best.units) best = window;
  }
  return best && best.units > 0 ? best : null;
}

/**
 * Where the running window stands against a reference, and when it would reach it at the
 * current speed.
 */
export function estimate(
  window: UsageWindow,
  reference: LiveReference,
  burn: LiveBurn,
  now: number,
  timeOf: (ms: number) => LiveEstimate['limitAtTime'],
): LiveEstimate {
  const percent = (window.units / reference.units) * 100;
  const none = { limitAt: null, limitAtTime: null };
  if (window.units >= reference.units) return { reference, percent, outcome: 'reached', ...none };
  if (burn.unitsPerMinute <= 0) return { reference, percent, outcome: 'noRate', ...none };
  const limitAt = now + ((reference.units - window.units) / burn.unitsPerMinute) * MINUTE_MS;
  if (limitAt >= window.end) return { reference, percent, outcome: 'resetsFirst', ...none };
  return { reference, percent, outcome: 'limitFirst', limitAt, limitAtTime: timeOf(limitAt) };
}

// ── The page ──────────────────────────────────────────────────────────────────

export function parseLiveHours(value: unknown): LiveHours {
  if (!LIVE_HOURS.includes(value as LiveHours)) {
    throw new InvalidRequestError(`hours must be one of ${LIVE_HOURS.join(', ')}`);
  }
  return value as LiveHours;
}

function emptyBurn(): LiveBurn {
  return { minutes: BURN_MINUTES, tokensPerMinute: 0, unitsPerMinute: 0 };
}

/** Start of the first minute of the chart: the current minute is the last of `hours` hours. */
function firstMinute(hours: LiveHours, now: number): number {
  return (Math.floor(now / MINUTE_MS) - (hours * 60 - 1)) * MINUTE_MS;
}

/** Every minute of the last `hours` hours, the current one last, with no usage. */
function emptyMinutes(hours: LiveHours, now: number, series: number): LiveMinute[] {
  const first = firstMinute(hours, now);
  return Array.from({ length: hours * 60 }, (_, index) => ({
    t: first + index * MINUTE_MS,
    tokens: new Array<number>(series).fill(0),
  }));
}

export function emptyLive(hours: LiveHours, now = Date.now()): Live {
  return {
    hasData: false,
    now,
    hours,
    series: [],
    minutes: emptyMinutes(hours, now, 0),
    active: [],
    machines: [],
  };
}

/** Sums `value` per key, largest first (ties by key). */
function ranked<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => number) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + value(item));
  return [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * The Live page for the selected machines (all by default): the last `hours` hours of
 * this machine minute by minute, the projects in use, and each machine's 5-hour window.
 * Other machines have no response times yet (`noLiveData`).
 */
export function getLive(
  db: UsageDatabase,
  pricing: Pricing,
  machineIds: string[] | undefined,
  hours: LiveHours,
  now = Date.now(),
): Live {
  const selected = (id: string) => !machineIds || machineIds.includes(id);
  const localSelected = selected(db.machineId);
  const minutesFrom = firstMinute(hours, now);
  const burnFrom = now - BURN_MINUTES * MINUTE_MS;
  const activeFrom = now - ACTIVE_MINUTES * MINUTE_MS;

  // Responses of the chart's hours, which cover the burn rate's 15 minutes.
  const rows = localSelected ? db.responsesBetween(minutesFrom, now) : [];
  const tokensOf = (row: ResponseRow) => row.input + row.output + row.cacheWrite + row.cacheRead;

  const projects = ranked(rows, (row) => row.project, tokensOf);
  const shown = projects.length > LIVE_SERIES ? projects.slice(0, LIVE_SERIES - 1) : projects;
  const series: LiveSeries[] = shown.map(([project, tokens]) => ({ project, tokens, projects: 1 }));
  const rest = projects.slice(shown.length);
  if (rest.length > 0) {
    series.push({
      project: null,
      tokens: rest.reduce((sum, [, t]) => sum + t, 0),
      projects: rest.length,
    });
  }
  const seriesIndex = new Map(shown.map(([project], index) => [project, index]));

  const minutes = emptyMinutes(hours, now, series.length);
  for (const row of rows) {
    const minute = minutes[Math.floor((row.ts - minutesFrom) / MINUTE_MS)];
    const index = seriesIndex.get(row.project) ?? series.length - 1;
    if (minute) minute.tokens[index] = (minute.tokens[index] ?? 0) + tokensOf(row);
  }

  const recent = rows.filter((row) => row.ts > burnFrom);
  const active: LiveProject[] = [];
  for (const project of new Set(
    recent.filter((row) => row.ts > activeFrom).map((r) => r.project),
  )) {
    const own = recent.filter((row) => row.project === project);
    const last = Math.max(...own.map((row) => row.ts));
    active.push({
      project,
      models: ranked(own, (row) => row.model, tokensOf).map(([model]) => model),
      tokens: own.reduce((sum, row) => sum + tokensOf(row), 0),
      last,
      lastAt: db.localDayTime(last),
    });
  }
  active.sort((a, b) => b.last - a.last || (a.project < b.project ? -1 : 1));

  const machines: LiveMachine[] = db
    .listMachines()
    .filter((machine) => selected(machine.id))
    .map((machine) => {
      const base = {
        machineId: machine.id,
        name: machine.name,
        platform: machine.platform,
        isLocal: machine.isLocal,
      };
      if (!machine.isLocal) {
        return {
          ...base,
          status: 'noLiveData',
          window: null,
          previous: null,
          lastResponse: null,
          lastResponseAt: null,
          burn: emptyBurn(),
          estimate: null,
        };
      }
      return { ...base, ...localState(db, pricing, recent, now) };
    });

  return {
    hasData: hasAnyUsage(db, machineIds),
    now,
    hours,
    series,
    minutes,
    active,
    machines,
  };
}

/** This machine's window, burn rate and estimate. `recent`: its last 15 minutes of responses. */
function localState(
  db: UsageDatabase,
  pricing: Pricing,
  recent: readonly ResponseRow[],
  now: number,
): Omit<LiveMachine, 'machineId' | 'name' | 'platform' | 'isLocal'> {
  const windows = localWindows(db, pricing, now);
  const current = currentWindow(windows, now);
  const last = windows.at(-1) ?? null;
  const previousWindow = current ? (windows.at(-2) ?? null) : last;

  const weighed = recent.map((row) => weigh(pricing, row));
  const burn: LiveBurn = {
    minutes: BURN_MINUTES,
    tokensPerMinute: weighed.reduce((sum, p) => sum + totalOf(p.tokens), 0) / BURN_MINUTES,
    unitsPerMinute: weighed.reduce((sum, p) => sum + p.units, 0) / BURN_MINUTES,
  };

  const toLive = (window: UsageWindow): LiveWindow => ({
    start: window.start,
    end: window.end,
    startAt: db.localDayTime(window.start),
    endAt: db.localDayTime(window.end),
    tokens: { ...window.tokens },
    total: totalOf(window.tokens),
    units: window.units,
    unpricedTokens: window.unpriced,
    responses: window.responses,
  });

  const largest = largestWindow(windows, current);
  const reference: LiveReference | null = largest && {
    kind: 'largestWindow',
    units: largest.units,
    tokens: totalOf(largest.tokens),
    start: largest.start,
    startAt: db.localDayTime(largest.start),
  };

  return {
    status: !last ? 'noData' : current ? 'active' : 'idle',
    window: current && toLive(current),
    previous: previousWindow && toLive(previousWindow),
    lastResponse: last?.last ?? null,
    lastResponseAt: last ? db.localDayTime(last.last) : null,
    burn,
    estimate:
      current && reference
        ? estimate(current, reference, burn, now, (ms) => db.localDayTime(ms))
        : null,
  };
}
