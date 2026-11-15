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
 *
 * Other computers share their last hours through `live.json` (see `liveFormat.ts`). Every
 * computer's responses are chained into one combined window, whatever the age of their
 * live data (usage does not expire). The estimate and the limits count another computer
 * while its live data is fresh or it has usage in the running window; otherwise only this
 * computer's.
 */
import { aliasMap, applyAliases, type AliasMap } from '../shared/projects';
import type {
  CalibrateResult,
  ClaudeUsage,
  Live,
  LiveBurn,
  LiveCombined,
  LiveEstimate,
  LiveHours,
  LiveMachine,
  LiveMinute,
  LiveProject,
  LiveReference,
  LiveReferenceChoice,
  LiveReferenceInfo,
  LiveSeries,
  LiveWindow,
  LocalDayTime,
  Pricing,
  SyncMachine,
  TokenBreakdown,
} from '../shared/types';
import { hasAnyUsage, InvalidRequestError } from './aggregate';
import { isFresh } from './claudeUsage';
import type { ResponseRow, UsageDatabase } from './db';
import {
  ACTIVITY_GAP_MS,
  isLiveFresh,
  LIVE_ACTIVITY_HOURS,
  LIVE_MIN_VERSION,
  LIVE_MINUTE_HOURS,
  LIVE_SCHEMA_VERSION,
  LIVE_SKEW_MS,
  versionBefore,
  type ActivityRun,
  type LiveFile,
  type LiveFileWindow,
  type LiveMinuteRow,
} from './liveFormat';
import { costOf } from './pricing';
import { isModelRow, type ModelRow } from './syncFormat';

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

/** Weighs one response (or `row.responses` of them, summed) at the given prices. */
export function weigh(pricing: Pricing, row: ResponseRow & { responses?: number }): UsagePoint {
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
    responses: row.responses ?? 1,
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

/** What an estimate starts from. */
export interface EstimateBasis {
  reference: LiveReference;
  /** % already used before `units`: Claude's own % under `claude`, else 0. */
  basePercent: number;
  /** Units used on top of `basePercent`: the window's, or those since Claude's numbers. */
  units: number;
  /** When the window resets. */
  resetsAt: number;
}

/**
 * Where the running window stands against a reference, and when it would reach it at the
 * current speed: % = base + units ÷ limit.
 */
export function estimate(
  basis: EstimateBasis,
  burn: LiveBurn,
  now: number,
  timeOf: (ms: number) => LocalDayTime,
): LiveEstimate {
  const { reference, basePercent, units, resetsAt } = basis;
  const limit = reference.units;
  const resets = { resetsAt, resetsAtTime: timeOf(resetsAt) };
  const none = { limitAt: null, limitAtTime: null, ...resets };
  if (limit === null || limit <= 0) {
    const outcome = basePercent >= 100 ? 'reached' : 'noLimit';
    return { reference, percent: basePercent, outcome, ...none };
  }
  const percent = basePercent + (units / limit) * 100;
  if (percent >= 100) return { reference, percent, outcome: 'reached', ...none };
  if (burn.unitsPerMinute <= 0) return { reference, percent, outcome: 'noRate', ...none };
  const left = (limit * (100 - percent)) / 100;
  const limitAt = now + (left / burn.unitsPerMinute) * MINUTE_MS;
  if (limitAt >= resetsAt) return { reference, percent, outcome: 'resetsFirst', ...none };
  return {
    reference,
    percent,
    outcome: 'limitFirst',
    limitAt,
    limitAtTime: timeOf(limitAt),
    ...resets,
  };
}

// ── Reference settings ────────────────────────────────────────────────────────

const SETTING_REFERENCE = 'live_reference';
const SETTING_CALIBRATION = 'live_calibration';
const REFERENCE_CHOICES: readonly LiveReferenceChoice[] = ['largestWindow', 'calibration'];

/** Largest window unless the user picked the calibration. */
export function getReferenceChoice(db: UsageDatabase): LiveReferenceChoice {
  return db.getSetting(SETTING_REFERENCE) === 'calibration' ? 'calibration' : 'largestWindow';
}

export function setReferenceChoice(db: UsageDatabase, choice: LiveReferenceChoice): void {
  db.setSetting(SETTING_REFERENCE, choice);
}

export function parseReferenceChoice(value: unknown): LiveReferenceChoice {
  if (!REFERENCE_CHOICES.includes(value as LiveReferenceChoice)) {
    throw new InvalidRequestError(`the reference must be one of ${REFERENCE_CHOICES.join(', ')}`);
  }
  return value as LiveReferenceChoice;
}

/** A % from `/usage`: above 0, at most 100, kept to one decimal. */
export function parseCalibrationPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new InvalidRequestError('the percentage must be above 0 and at most 100');
  }
  return Math.max(0.1, Math.round(value * 10) / 10);
}

/**
 * A calibration as stored. Entered while other computers that used the window had fresh
 * live data, it also keeps the combined window's start and their tokens per model in it
 * up to `at` (their live data does not last), and how many computers used it, this one
 * included. Later reads of their live data complete those tokens (`refineCalibration`).
 */
interface StoredCalibration {
  at: number;
  percent: number;
  combined: { start: number; others: ModelRow[]; computers: number } | null;
}

export function storedCalibration(db: UsageDatabase): StoredCalibration | null {
  try {
    const value: unknown = JSON.parse(db.getSetting(SETTING_CALIBRATION) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { at, percent, start, others, computers } = value as Record<string, unknown>;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (typeof percent !== 'number' || !(percent > 0 && percent <= 100)) return null;
    if (start === undefined) return { at, percent, combined: null };
    if (
      typeof start !== 'number' ||
      !Number.isFinite(start) ||
      start > at ||
      at - start >= WINDOW_MS ||
      !Array.isArray(others) ||
      !others.every(isModelRow) ||
      typeof computers !== 'number' ||
      !Number.isSafeInteger(computers) ||
      computers < 1
    ) {
      return null;
    }
    return { at, percent, combined: { start, others, computers } };
  } catch {
    return null;
  }
}

/**
 * Stores the % that `/usage` shows now, for the account's running window, and makes the
 * calibration the reference. Refused without a running window that has priced usage.
 * `live`: the other computers' live data, as for `getLive`.
 */
export function calibrate(
  db: UsageDatabase,
  pricing: Pricing,
  percent: number,
  now = Date.now(),
  live: readonly LiveFile[] = [],
): CalibrateResult {
  const windows = localWindows(db, pricing, now);
  const local = localPointsOf(db, now);
  const others = otherMachines(db, live, now);
  const account = accountUsage(db, pricing, now, windows, local, others);
  const current = account.current;
  if (!current || current.units <= 0) return { status: 'noWindow' };
  const stored: Record<string, unknown> = { at: now, percent };
  const inside = (point: LivePoint) => point.ts >= current.start && point.ts <= now;
  const users = account.counted.filter((other) => other.points.some(inside));
  if (account.combined && users.length > 0) {
    stored.start = current.start;
    stored.others = modelRowsOf(users.flatMap((other) => other.points.filter(inside)));
    stored.computers = users.length + (local.some(inside) ? 1 : 0);
  }
  db.setSetting(SETTING_CALIBRATION, JSON.stringify(stored));
  setReferenceChoice(db, 'calibration');
  return { status: 'done' };
}

/** API-price units of this machine's responses from `from` to `to`, both included. */
function unitsBetween(db: UsageDatabase, pricing: Pricing, from: number, to: number): number {
  let units = 0;
  if (to < from) return units;
  for (const row of db.responsesFrom(from, to)) units += weigh(pricing, row).units;
  return units;
}

/** API-price units of tokens per model. */
function unitsOfRows(pricing: Pricing, rows: readonly ModelRow[]): number {
  let units = 0;
  for (const [model, input, output, cacheWrite, cacheRead, cacheWrite1h] of rows) {
    units += costOf(pricing, model, { input, output, cacheWrite, cacheRead, cacheWrite1h }) ?? 0;
  }
  return units;
}

/** A limit = the units used up to a moment ÷ the % Claude showed then. */
function limitFrom(units: number, percent: number): number | null {
  return units > 0 && percent > 0 ? units / (percent / 100) : null;
}

/**
 * The limit a calibration gives: the units of its window up to the moment it was entered,
 * at the current prices, ÷ its %. A combined calibration adds the other computers' tokens
 * it kept. Null when no window holds that moment any more.
 */
function calibrationLimit(
  db: UsageDatabase,
  pricing: Pricing,
  windows: readonly UsageWindow[],
  calibration: StoredCalibration,
): number | null {
  const { at, percent, combined } = calibration;
  if (combined) {
    const units =
      unitsBetween(db, pricing, combined.start, at) + unitsOfRows(pricing, combined.others);
    return limitFrom(units, percent);
  }
  const window = windows.find((item) => item.start <= at && at < item.end);
  if (!window) return null;
  return limitFrom(unitsBetween(db, pricing, window.start, at), percent);
}

/** Claude's own numbers, as the main process passes them to `getLive`. */
export interface ClaudeSource {
  /** False when the Settings switch is off: nothing was read. */
  enabled: boolean;
  usage: ClaudeUsage | null;
}

const NO_CLAUDE: ClaudeSource = { enabled: false, usage: null };

/** Below this %, Claude's number is too coarse to derive a limit from. */
export const MIN_CLAUDE_PERCENT = 5;

function emptyReferenceInfo(): LiveReferenceInfo {
  return {
    choice: 'largestWindow',
    largest: null,
    calibration: null,
    claudeEnabled: false,
    claude: null,
    canCalibrate: false,
    scope: { counted: [], others: 0 },
  };
}

// ── Points ────────────────────────────────────────────────────────────────────

/**
 * A response of this computer, or a minute of another computer's responses of one project
 * and model (its first response's time as `ts`). Every range counts a point by `ts`.
 */
export interface LivePoint extends ResponseRow {
  /** The last response it stands for: `ts` for one response. */
  last: number;
  project: string;
  responses: number;
}

function tokensOfPoint(point: ResponseRow): number {
  return point.input + point.output + point.cacheWrite + point.cacheRead;
}

/** This computer's responses of the last 6 hours, which hold every window still running. */
function localPointsOf(db: UsageDatabase, now: number): LivePoint[] {
  return db
    .responsesBetween(firstMinute(LIVE_MINUTE_HOURS, now), now)
    .map((row) => ({ ...row, last: row.ts, responses: 1 }));
}

/** Units of the points from `from` to `to`, both included. */
function unitsOfPoints(
  pricing: Pricing,
  points: readonly LivePoint[],
  from: number,
  to: number,
): number {
  let units = 0;
  for (const point of points) {
    if (point.ts >= from && point.ts <= to) units += weigh(pricing, point).units;
  }
  return units;
}

/** Tokens per model of the points. */
function modelRowsOf(points: readonly ResponseRow[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const point of points) {
    let row = rows.get(point.model);
    if (!row) {
      row = [point.model, 0, 0, 0, 0, 0];
      rows.set(point.model, row);
    }
    row[1] += point.input;
    row[2] += point.output;
    row[3] += point.cacheWrite;
    row[4] += point.cacheRead;
    row[5] += point.cacheWrite1h;
  }
  return [...rows.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The speed over the last 15 minutes. A point exactly 15 minutes old is left out. */
function burnOf(pricing: Pricing, points: readonly LivePoint[], now: number): LiveBurn {
  const from = now - BURN_MINUTES * MINUTE_MS;
  let tokens = 0;
  let units = 0;
  for (const point of points) {
    if (point.ts <= from || point.ts > now) continue;
    tokens += tokensOfPoint(point);
    units += weigh(pricing, point).units;
  }
  return {
    minutes: BURN_MINUTES,
    tokensPerMinute: tokens / BURN_MINUTES,
    unitsPerMinute: units / BURN_MINUTES,
  };
}

// ── Writing live.json ─────────────────────────────────────────────────────────

/** One of this computer's windows as `live.json` carries it. */
function fileWindow(db: UsageDatabase, window: UsageWindow, now: number): LiveFileWindow {
  const rows = [...db.responsesFrom(window.start, Math.min(window.end - 1, now))];
  return {
    start: window.start,
    last: window.last,
    responses: window.responses,
    models: modelRowsOf(rows),
  };
}

/**
 * This computer's `live.json` at `now`: its minutes of the last 6 hours by project and
 * model, its runs of responses of the last 24 hours, and its running and last windows.
 */
export function buildLiveFile(db: UsageDatabase, pricing: Pricing, now = Date.now()): LiveFile {
  const minutesFrom = firstMinute(LIVE_MINUTE_HOURS, now);
  const buckets = new Map<string, LiveMinuteRow>();
  for (const row of db.responsesBetween(minutesFrom, now)) {
    const key = `${Math.floor(row.ts / MINUTE_MS)}\n${row.project}\n${row.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [row.ts, row.ts, row.project, row.model, 0, 0, 0, 0, 0, 0];
      buckets.set(key, bucket);
    }
    bucket[0] = Math.min(bucket[0], row.ts);
    bucket[1] = Math.max(bucket[1], row.ts);
    bucket[4] += row.input;
    bucket[5] += row.output;
    bucket[6] += row.cacheWrite;
    bucket[7] += row.cacheRead;
    bucket[8] += row.cacheWrite1h;
    bucket[9] += 1;
  }
  const minutes = [...buckets.values()].sort(
    (a, b) => a[0] - b[0] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[3] < b[3] ? -1 : 1),
  );

  const activityFrom = now - LIVE_ACTIVITY_HOURS * 60 * MINUTE_MS;
  const activity: ActivityRun[] = [];
  for (const row of db.responsesFrom(activityFrom, now)) {
    const run = activity.at(-1);
    if (run && row.ts - run[1] <= ACTIVITY_GAP_MS) run[1] = row.ts;
    else activity.push([row.ts, row.ts]);
  }

  const windows = localWindows(db, pricing, now);
  const current = currentWindow(windows, now);
  const previous = current ? (windows.at(-2) ?? null) : (windows.at(-1) ?? null);
  return {
    schemaVersion: LIVE_SCHEMA_VERSION,
    machineId: db.machineId,
    writtenAt: now,
    minutesFrom,
    activityFrom,
    window: current && fileWindow(db, current, now),
    previous: previous && fileWindow(db, previous, now),
    activity,
    minutes,
  };
}

// ── Other computers ───────────────────────────────────────────────────────────

/** Another computer, with its live data when it has shared any. */
interface OtherMachine {
  machine: Omit<SyncMachine, 'problem' | 'conflictCopies'>;
  file: LiveFile | null;
  /** Written in the last 15 minutes (and not ahead of this clock). */
  fresh: boolean;
  /**
   * Its live data counts in the account's windows, whatever its age: usage does not
   * expire. False without a file, or for a file dated ahead of this clock.
   */
  usable: boolean;
  /** Its minutes up to `now`, with this computer's project aliases. */
  points: LivePoint[];
}

function pointsOfFile(file: LiveFile, aliases: AliasMap, now: number): LivePoint[] {
  const points: LivePoint[] = [];
  for (const row of file.minutes) {
    const [first, last, project, model, input, output, cacheWrite, cacheRead, cacheWrite1h] = row;
    if (first > now) continue;
    points.push({
      ts: first,
      last: Math.min(last, now),
      project: applyAliases(project, aliases),
      model,
      input,
      output,
      cacheWrite,
      cacheRead,
      cacheWrite1h,
      responses: row[9],
    });
  }
  return points;
}

/** The other computers that are not hidden, in the machine list's order. */
function otherMachines(db: UsageDatabase, live: readonly LiveFile[], now: number): OtherMachine[] {
  const files = new Map(live.map((file) => [file.machineId, file]));
  const aliases = aliasMap(db.getProjectAliases());
  return db
    .listAllMachines()
    .filter((machine) => !machine.isLocal && !machine.hidden)
    .map((machine) => {
      const file = files.get(machine.id) ?? null;
      return {
        machine,
        file,
        fresh: file !== null && isLiveFresh(file, now),
        usable: file !== null && file.writtenAt <= now + LIVE_SKEW_MS,
        points: file ? pointsOfFile(file, aliases, now) : [],
      };
    });
}

// ── The combined window ───────────────────────────────────────────────────────

/** A window's start and reset time. */
interface Span {
  start: number;
  end: number;
}

/**
 * Chains 5-hour windows over runs of responses `[first, last]` of one or more computers,
 * after `initial` (the window already running, if any). Inside a run no two responses are
 * more than a minute apart, so a window that resets inside a run is followed at once by
 * the next one (its real first response is less than a minute after the reset). A run of
 * one response is exact: the rule of `addToWindows`.
 */
export function chainRuns(runs: readonly ActivityRun[], initial: Span | null = null): Span[] {
  const sorted = [...runs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const windows: Span[] = initial ? [{ ...initial }] : [];
  for (const [first, last] of sorted) {
    let window = windows.at(-1);
    if (!window || first >= window.end) {
      window = { start: first, end: first + WINDOW_MS };
      windows.push(window);
    }
    while (window.end <= last) {
      window = { start: window.end, end: window.end + WINDOW_MS };
      windows.push(window);
    }
  }
  return windows;
}

/**
 * The usage the estimate counts: every computer together, or this one only.
 *
 * Every other computer's live data goes into the chain of windows, however old: usage does
 * not expire, so a window the Mac started at 09:00 and left at 10:00 still runs until
 * 14:00, and the next one starts with the first response after that. Freshness only
 * changes the wording: `counted` lists the computers whose live data is fresh or that have
 * usage in the running window.
 */
interface AccountUsage {
  /** True when other computers' live data is chained in (`shared` is not empty). */
  combined: boolean;
  /** The window running at `now`, with its units, or null. */
  current: (Span & { units: number }) | null;
  /** The points counted: this computer's of the last 6 hours, plus the shared others'. */
  points: LivePoint[];
  /** This computer's points alone. */
  local: LivePoint[];
  burn: LiveBurn;
  /** The other computers counted now: fresh, or with usage in the running window. */
  counted: OtherMachine[];
  /**
   * The other computers chained in: fresh, or with activity in the last 24 hours, stale
   * ones included.
   */
  shared: OtherMachine[];
  /** Every computer's window chain (combined only), oldest first. */
  spans: Span[];
}

function accountUsage(
  db: UsageDatabase,
  pricing: Pricing,
  now: number,
  windows: readonly UsageWindow[],
  local: LivePoint[],
  others: readonly OtherMachine[],
): AccountUsage {
  // Before the horizon only this computer's history is known.
  const horizon = now - LIVE_ACTIVITY_HOURS * 60 * MINUTE_MS;
  const shared = others.filter(
    (other) =>
      other.usable &&
      other.file !== null &&
      (other.fresh || other.file.activity.some(([, last]) => last >= horizon)),
  );
  if (shared.length === 0) {
    const current = currentWindow(windows, now);
    return {
      combined: false,
      current: current && { start: current.start, end: current.end, units: current.units },
      points: local,
      local,
      burn: burnOf(pricing, local, now),
      counted: [],
      shared,
      spans: [],
    };
  }

  // This computer's window running at the horizon, if any, starts the chain.
  let initial: Span | null = null;
  for (let index = windows.length - 1; index >= 0; index--) {
    const window = windows[index]!;
    if (window.start >= horizon) continue;
    if (window.end > horizon) initial = { start: window.start, end: window.end };
    break;
  }
  const runs: ActivityRun[] = [];
  for (const row of db.responsesFrom(horizon, now)) runs.push([row.ts, row.ts]);
  for (const other of shared) {
    for (const [first, last] of other.file!.activity) {
      // A run that began before the horizon would start a made-up window at it.
      if (first < horizon) continue;
      const to = Math.min(last, now);
      if (first <= to) runs.push([first, to]);
    }
  }
  const spans = chainRuns(runs, initial);
  const points = [...local, ...shared.flatMap((other) => other.points)];
  const last = spans.at(-1);
  const current = last && last.start <= now && now < last.end ? last : null;
  const counted = shared.filter(
    (other) =>
      other.fresh ||
      (current !== null &&
        other.points.some((point) => point.ts >= current.start && point.ts <= now)),
  );
  return {
    combined: true,
    current: current && { ...current, units: unitsOfPoints(pricing, points, current.start, now) },
    points,
    local,
    burn: burnOf(pricing, points, now),
    counted,
    shared,
    spans,
  };
}

// ── Combined windows remembered ───────────────────────────────────────────────

const SETTING_COMBINED = 'live_combined_windows';
/** At most this many combined windows are remembered: the latest. */
export const MAX_COMBINED_WINDOWS = 100;

/**
 * A finished window of several computers together, remembered with its tokens per model
 * (priced on reading, so a price change applies): their live data does not last.
 */
interface StoredWindow {
  start: number;
  computers: number;
  models: ModelRow[];
}

function storedCombinedWindows(db: UsageDatabase): StoredWindow[] {
  try {
    const value: unknown = JSON.parse(db.getSetting(SETTING_COMBINED) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is StoredWindow => {
      if (typeof item !== 'object' || item === null) return false;
      const { start, computers, models } = item as Record<string, unknown>;
      return (
        typeof start === 'number' &&
        Number.isFinite(start) &&
        typeof computers === 'number' &&
        Number.isSafeInteger(computers) &&
        computers >= 2 &&
        Array.isArray(models) &&
        models.length > 0 &&
        models.every(isModelRow)
      );
    });
  } catch {
    return [];
  }
}

/** All token types of tokens per model. */
function totalOfRows(rows: readonly ModelRow[]): number {
  return rows.reduce((sum, row) => sum + row[1] + row[2] + row[3] + row[4], 0);
}

/** The first moment every computer's minutes cover: this one's and the given others'. */
function minutesCovered(now: number, others: readonly OtherMachine[]): number {
  return Math.max(
    firstMinute(LIVE_MINUTE_HOURS, now),
    ...others.map((other) => other.file?.minutesFrom ?? Number.POSITIVE_INFINITY),
  );
}

/** How many computers have usage in a range: the given others, and this one. */
function usersOf(
  account: AccountUsage,
  others: readonly OtherMachine[],
  inside: (point: LivePoint) => boolean,
): { others: OtherMachine[]; computers: number } {
  const users = others.filter((other) => other.points.some(inside));
  return { others: users, computers: users.length + (account.local.some(inside) ? 1 : 0) };
}

/**
 * True when every computer still sharing its live data wrote it after `at`: a fresh file
 * written before may still be missing usage up to then. A stale file is the last word of
 * its computer, so it never holds this back.
 */
function writtenAfter(others: readonly OtherMachine[], at: number): boolean {
  return others.every((other) => !other.fresh || (other.file?.writtenAt ?? 0) >= at);
}

/**
 * Remembers the combined window that reset last, once every computer's live data covers
 * all of it (its minutes, and the fresh ones written after its reset), when two computers
 * or more used it: the largest of them is a reference, like this computer's own largest
 * window.
 */
function rememberCombined(db: UsageDatabase, account: AccountUsage, now: number): void {
  const { spans, shared } = account;
  const last = spans.at(-1);
  if (!last) return;
  const span = last.start <= now && now < last.end ? spans.at(-2) : last;
  if (!span || span.end > now || span.start < minutesCovered(now, shared)) return;
  if (!writtenAfter(shared, span.end)) return;
  const inside = (point: LivePoint) => point.ts >= span.start && point.ts < span.end;
  const users = usersOf(account, shared, inside).computers;
  if (users < 2) return;
  const models = modelRowsOf(account.points.filter(inside));
  const stored = storedCombinedWindows(db);
  const known = stored.find((window) => window.start === span.start);
  if (known && totalOfRows(known.models) >= totalOfRows(models)) return;
  const next = [
    ...stored.filter((window) => window.start !== span.start),
    { start: span.start, computers: users, models },
  ]
    .sort((a, b) => a.start - b.start)
    .slice(-MAX_COMBINED_WINDOWS);
  db.setSetting(SETTING_COMBINED, JSON.stringify(next));
}

/**
 * Completes a combined calibration with the other computers' usage written after it was
 * entered: their copy then could be a few minutes behind, while the % Claude showed
 * counted it. Only while every fresh file was written after it, every file covers its
 * window, and only upward (a computer whose live data is gone since would lower it).
 */
function refineCalibration(db: UsageDatabase, account: AccountUsage): void {
  const stored = storedCalibration(db);
  const combined = stored?.combined;
  const { shared } = account;
  if (!stored || !combined || shared.length === 0) return;
  if (combined.start < Math.max(...shared.map((other) => other.file?.minutesFrom ?? Infinity))) {
    return;
  }
  if (!writtenAfter(shared, stored.at)) return;
  const inside = (point: LivePoint) => point.ts >= combined.start && point.ts <= stored.at;
  const users = usersOf(account, shared, inside);
  const others = modelRowsOf(users.others.flatMap((other) => other.points.filter(inside)));
  if (totalOfRows(others) <= totalOfRows(combined.others)) return;
  db.setSetting(
    SETTING_CALIBRATION,
    JSON.stringify({
      at: stored.at,
      percent: stored.percent,
      start: combined.start,
      others,
      computers: Math.max(combined.computers, users.computers),
    }),
  );
}

/**
 * Keeps what the other computers' live data says before it expires: the combined window
 * that reset last (`rememberCombined`) and the rest of a combined calibration
 * (`refineCalibration`). A failure only costs that memory: it is logged, never thrown.
 */
function remember(db: UsageDatabase, account: AccountUsage, now: number): void {
  if (account.shared.length === 0) return;
  try {
    rememberCombined(db, account, now);
    refineCalibration(db, account);
  } catch (error) {
    console.warn(`[live] Could not remember the other computers' usage: ${String(error)}`);
  }
}

/**
 * Remembers what the other computers' live data says (see `remember`). The main process
 * calls it whenever their live data changes, so it does not wait for the Live page to be
 * opened; `getLive` does it too.
 */
export function rememberCombinedWindows(
  db: UsageDatabase,
  pricing: Pricing,
  live: readonly LiveFile[],
  now = Date.now(),
): void {
  if (live.length === 0) return;
  const windows = localWindows(db, pricing, now);
  const others = otherMachines(db, live, now);
  const account = accountUsage(db, pricing, now, windows, localPointsOf(db, now), others);
  remember(db, account, now);
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
function firstMinute(hours: number, now: number): number {
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
    combined: null,
    estimate: null,
    reference: emptyReferenceInfo(),
  };
}

/** Sums `value` per key, largest first (ties by key). */
function ranked<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => number) {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + value(item));
  return [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** A window's totals from the points between `from` and `to`, both included. */
function windowOf(
  pricing: Pricing,
  points: readonly LivePoint[],
  span: Span,
  to: number,
  timeOf: (ms: number) => LocalDayTime,
): LiveWindow {
  const window: UsageWindow = {
    start: span.start,
    end: span.end,
    last: span.start,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    units: 0,
    unpriced: 0,
    responses: 0,
  };
  for (const point of points) {
    if (point.ts < span.start || point.ts > to) continue;
    const weighed = weigh(pricing, point);
    window.tokens.input += weighed.tokens.input;
    window.tokens.output += weighed.tokens.output;
    window.tokens.cacheWrite += weighed.tokens.cacheWrite;
    window.tokens.cacheRead += weighed.tokens.cacheRead;
    window.units += weighed.units;
    window.unpriced += weighed.unpriced;
    window.responses += weighed.responses;
  }
  return toLiveWindow(window, timeOf);
}

function toLiveWindow(window: UsageWindow, timeOf: (ms: number) => LocalDayTime): LiveWindow {
  return {
    start: window.start,
    end: window.end,
    startAt: timeOf(window.start),
    endAt: timeOf(window.end),
    tokens: { ...window.tokens },
    total: totalOf(window.tokens),
    units: window.units,
    unpricedTokens: window.unpriced,
    responses: window.responses,
  };
}

/** One of another computer's windows from its `live.json`, priced here. */
function fromFileWindow(
  pricing: Pricing,
  window: LiveFileWindow,
  timeOf: (ms: number) => LocalDayTime,
): LiveWindow {
  const usage: UsageWindow = {
    start: window.start,
    end: window.start + WINDOW_MS,
    last: window.last,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    units: 0,
    unpriced: 0,
    responses: window.responses,
  };
  for (const [model, input, output, cacheWrite, cacheRead, cacheWrite1h] of window.models) {
    const weighed = weigh(pricing, {
      ts: window.start,
      model,
      input,
      output,
      cacheWrite,
      cacheRead,
      cacheWrite1h,
    });
    usage.tokens.input += input;
    usage.tokens.output += output;
    usage.tokens.cacheWrite += cacheWrite;
    usage.tokens.cacheRead += cacheRead;
    usage.units += weighed.units;
    usage.unpriced += weighed.unpriced;
  }
  return toLiveWindow(usage, timeOf);
}

type MachineState = Omit<LiveMachine, 'machineId' | 'name' | 'platform' | 'isLocal'>;

/**
 * Another computer's window and speed, from its live data. Stale live data still shows
 * the window it holds until that window resets (`stale` set); after that the computer
 * reads as `stale`. `newer`: its live data needs a newer version of this app.
 */
function otherMachineState(
  pricing: Pricing,
  other: OtherMachine,
  now: number,
  timeOf: (ms: number) => LocalDayTime,
  newer: boolean,
): MachineState {
  const { file } = other;
  const none = {
    window: null,
    previous: null,
    lastResponse: null,
    lastResponseAt: null,
    burn: emptyBurn(),
    liveAt: file?.writtenAt ?? null,
    liveAtTime: file ? timeOf(file.writtenAt) : null,
    stale: false,
  };
  if (newer && !other.fresh) return { status: 'newerApp', ...none };
  if (!file) {
    const old = versionBefore(other.machine.appVersion, LIVE_MIN_VERSION);
    return { status: old ? 'needsUpdate' : 'noLiveData', ...none };
  }
  if (!other.usable) return { status: 'stale', ...none };

  const ends = (window: LiveFileWindow) => window.start + WINDOW_MS;
  const shown = file.window && file.window.start <= now ? file.window : null;
  const running = shown && now < ends(shown) ? shown : null;
  // Stale: only the window it holds is still known, until it resets.
  if (!other.fresh && !running) return { status: 'stale', ...none };
  const previous = running ? file.previous : (shown ?? file.previous);
  const last = Math.max(file.window?.last ?? 0, file.previous?.last ?? 0) || null;
  return {
    ...none,
    status: running ? 'active' : last === null ? 'noData' : 'idle',
    window: running && fromFileWindow(pricing, running, timeOf),
    previous: previous && fromFileWindow(pricing, previous, timeOf),
    lastResponse: last,
    lastResponseAt: last === null ? null : timeOf(last),
    burn: burnOf(pricing, other.points, now),
    stale: !other.fresh,
  };
}

/**
 * The Live page for the selected machines (all by default): the last `hours` hours minute
 * by minute, the projects in use, and each machine's 5-hour window. `claude`: Claude Code's
 * own numbers, read by the caller (this module never reads Claude Code's files). `live`:
 * the other computers' `live.json` files, as the sync read them; `newer`: the computers
 * whose latest `live.json` needs a newer version of this app.
 *
 * The estimate is the account's, whatever the selection: Claude's limit is per account.
 * It counts every computer whose live data is fresh or in the running window (`combined`),
 * else this one only.
 */
export function getLive(
  db: UsageDatabase,
  pricing: Pricing,
  machineIds: string[] | undefined,
  hours: LiveHours,
  now = Date.now(),
  claude: ClaudeSource = NO_CLAUDE,
  live: readonly LiveFile[] = [],
  newer: readonly string[] = [],
): Live {
  const selected = (id: string) => !machineIds || machineIds.includes(id);
  const timeOf = (ms: number) => db.localDayTime(ms);
  const minutesFrom = firstMinute(hours, now);
  const burnFrom = now - BURN_MINUTES * MINUTE_MS;
  const activeFrom = now - ACTIVE_MINUTES * MINUTE_MS;

  const local = localPointsOf(db, now);
  const others = otherMachines(db, live, now);

  // The chart and the projects in use: the selected machines' points, stale live data
  // included (it is what happened, up to the time it was written).
  const shown = [
    ...(selected(db.machineId) ? local : []),
    ...others.filter((other) => selected(other.machine.id)).flatMap((other) => other.points),
  ].filter((point) => point.ts >= minutesFrom && point.ts <= now);

  const projects = ranked(shown, (point) => point.project, tokensOfPoint);
  const top = projects.length > LIVE_SERIES ? projects.slice(0, LIVE_SERIES - 1) : projects;
  const series: LiveSeries[] = top.map(([project, tokens]) => ({ project, tokens, projects: 1 }));
  const rest = projects.slice(top.length);
  if (rest.length > 0) {
    series.push({
      project: null,
      tokens: rest.reduce((sum, [, t]) => sum + t, 0),
      projects: rest.length,
    });
  }
  const seriesIndex = new Map(top.map(([project], index) => [project, index]));

  const minutes = emptyMinutes(hours, now, series.length);
  for (const point of shown) {
    const minute = minutes[Math.floor((point.ts - minutesFrom) / MINUTE_MS)];
    const index = seriesIndex.get(point.project) ?? series.length - 1;
    if (minute) minute.tokens[index] = (minute.tokens[index] ?? 0) + tokensOfPoint(point);
  }

  const recent = shown.filter((point) => point.ts > burnFrom);
  const active: LiveProject[] = [];
  for (const project of new Set(
    shown.filter((point) => point.last > activeFrom).map((point) => point.project),
  )) {
    const own = recent.filter((point) => point.project === project);
    let last = 0;
    for (const point of shown) if (point.project === project) last = Math.max(last, point.last);
    active.push({
      project,
      models: ranked(own, (point) => point.model, tokensOfPoint).map(([model]) => model),
      tokens: own.reduce((sum, point) => sum + tokensOfPoint(point), 0),
      last,
      lastAt: timeOf(last),
    });
  }
  active.sort((a, b) => b.last - a.last || (a.project < b.project ? -1 : 1));

  // This computer's windows.
  const windows = localWindows(db, pricing, now);
  const current = currentWindow(windows, now);
  const lastWindow = windows.at(-1) ?? null;
  const previousWindow = current ? (windows.at(-2) ?? null) : lastWindow;
  const localState: MachineState = {
    status: !lastWindow ? 'noData' : current ? 'active' : 'idle',
    window: current && toLiveWindow(current, timeOf),
    previous: previousWindow && toLiveWindow(previousWindow, timeOf),
    lastResponse: lastWindow?.last ?? null,
    lastResponseAt: lastWindow ? timeOf(lastWindow.last) : null,
    burn: burnOf(pricing, local, now),
    liveAt: null,
    liveAtTime: null,
    stale: false,
  };

  // Every computer together.
  const account = accountUsage(db, pricing, now, windows, local, others);
  let combined: LiveCombined | null = null;
  if (account.combined) {
    const spans = account.spans;
    const last = spans.at(-1);
    const running = account.current;
    const before = running ? spans.at(-2) : last;
    // Its previous window only when every computer's minutes cover all of it.
    const covered = minutesCovered(now, account.shared);
    // The computers with usage in it (or in the last one, when none runs).
    const shownSpan = running ?? last;
    const used = (points: readonly LivePoint[]) =>
      shownSpan !== undefined &&
      points.some((point) => point.ts >= shownSpan.start && point.ts < shownSpan.end);
    combined = {
      status: running ? 'active' : 'idle',
      window: running && windowOf(pricing, account.points, running, now, timeOf),
      previous:
        before && before.start >= covered
          ? windowOf(pricing, account.points, before, before.end - 1, timeOf)
          : null,
      burn: account.burn,
      machines: [
        ...(used(local) ? [{ machineId: db.machineId, name: db.machineName }] : []),
        ...account.shared
          .filter((other) => used(other.points))
          .map((other) => ({ machineId: other.machine.id, name: other.machine.name })),
      ],
    };
  }

  remember(db, account, now);
  const { estimate, reference } = accountEstimate(
    db,
    pricing,
    now,
    windows,
    current,
    account,
    others,
    claude,
  );
  reference.scope = {
    counted: account.counted.map((other) => ({
      name: other.machine.name,
      liveAtTime: other.fresh || !other.file ? null : timeOf(other.file.writtenAt),
    })),
    others: others.length,
  };

  const machines: LiveMachine[] = [];
  for (const machine of db.listMachines()) {
    if (!selected(machine.id)) continue;
    const base = {
      machineId: machine.id,
      name: machine.name,
      platform: machine.platform,
      isLocal: machine.isLocal,
    };
    if (machine.isLocal) {
      machines.push({ ...base, ...localState });
      continue;
    }
    const other = others.find((item) => item.machine.id === machine.id);
    if (!other) continue;
    const state = otherMachineState(pricing, other, now, timeOf, newer.includes(machine.id));
    machines.push({ ...base, ...state });
  }

  return {
    hasData: hasAnyUsage(db, machineIds) || shown.length > 0,
    now,
    hours,
    series,
    minutes,
    active,
    machines,
    combined,
    estimate,
    reference,
  };
}

/**
 * The account's estimate and the reference card's data. The limit comes from Claude's %
 * while it is fresh, else from the chosen reference; Claude's % and a calibration count
 * the units of `account` (every computer counted, else this one).
 */
function accountEstimate(
  db: UsageDatabase,
  pricing: Pricing,
  now: number,
  windows: readonly UsageWindow[],
  current: UsageWindow | null,
  account: AccountUsage,
  others: readonly OtherMachine[],
  claude: ClaudeSource,
): { estimate: LiveEstimate | null; reference: LiveReferenceInfo } {
  const timeOf = (ms: number) => db.localDayTime(ms);

  const choice = getReferenceChoice(db);
  const stored = storedCalibration(db);
  const calibrationUnits = stored && calibrationLimit(db, pricing, windows, stored);
  // The largest finished window known: this computer's, or one of several computers
  // together that this app saw finish.
  type Candidate = { start: number; units: number; tokens: number; computers: number };
  const larger = (best: Candidate | null, candidate: Candidate) =>
    candidate.units > 0 &&
    (!best ||
      candidate.units > best.units ||
      (candidate.units === best.units && candidate.start > best.start))
      ? candidate
      : best;
  let combinedLargest: Candidate | null = null;
  for (const window of storedCombinedWindows(db)) {
    combinedLargest = larger(combinedLargest, {
      start: window.start,
      units: unitsOfRows(pricing, window.models),
      tokens: totalOfRows(window.models),
      computers: window.computers,
    });
  }
  const own = largestWindow(windows, current);
  const largest = own
    ? larger(combinedLargest, {
        start: own.start,
        units: own.units,
        tokens: totalOf(own.tokens),
        computers: 1,
      })
    : combinedLargest;
  const largestReference: LiveReference | null = largest && {
    kind: 'largestWindow',
    units: largest.units,
    at: largest.start,
    atTime: timeOf(largest.start),
    tokens: largest.tokens,
    percent: null,
  };
  const calibrationReference: LiveReference | null =
    stored && calibrationUnits
      ? {
          kind: 'calibration',
          units: calibrationUnits,
          at: stored.at,
          atTime: timeOf(stored.at),
          tokens: null,
          percent: stored.percent,
        }
      : null;
  // The chosen one, or the largest window while the calibration gives no limit.
  const chosen =
    choice === 'calibration' && calibrationReference ? calibrationReference : largestReference;

  const usage = claude.enabled ? claude.usage : null;
  const fresh = usage !== null && isFresh(usage, now);
  const running = account.current;
  const unitsOf = (from: number, to: number) => unitsOfPoints(pricing, account.points, from, to);

  let basis: EstimateBasis | null = null;
  if (running && usage && fresh) {
    // Claude's own %, plus the usage counted since. Its limit, like a calibration: the
    // units counted in Claude's window up to that moment ÷ that %. Only from 5% on (a
    // rounded 1% is too coarse), and never below the largest finished window known: usage
    // stops at the limit, so the limit is at least that. A smaller result means part of
    // Claude's % came from usage not counted here (claude.ai, a computer without live data).
    // With other computers, only a combined window is a sure floor: one computer's own
    // window can span two of the account's windows, so hold up to twice the limit.
    const claudeStart = usage.resetsAt - WINDOW_MS;
    const before = unitsOf(claudeStart, usage.fetchedAt);
    const derived = usage.percent >= MIN_CLAUDE_PERCENT ? limitFrom(before, usage.percent) : null;
    const floor = (others.length > 0 ? combinedLargest : largest)?.units ?? 0;
    basis = {
      reference: {
        kind: 'claude',
        units: derived !== null ? Math.max(derived, floor) : (chosen?.units ?? null),
        at: usage.fetchedAt,
        atTime: timeOf(usage.fetchedAt),
        tokens: null,
        percent: usage.percent,
      },
      basePercent: usage.percent,
      units: unitsOf(usage.fetchedAt + 1, now),
      resetsAt: usage.resetsAt,
    };
  } else if (running && chosen) {
    basis = { reference: chosen, basePercent: 0, units: running.units, resetsAt: running.end };
  }

  return {
    estimate: basis && estimate(basis, account.burn, now, timeOf),
    reference: {
      choice,
      largest: largest && {
        start: largest.start,
        startAt: timeOf(largest.start),
        units: largest.units,
        computers: largest.computers,
      },
      calibration: stored && {
        at: stored.at,
        atTime: timeOf(stored.at),
        percent: stored.percent,
        units: calibrationUnits,
        computers: stored.combined?.computers ?? 1,
      },
      claudeEnabled: claude.enabled,
      claude: usage && { ...usage, fetchedAtTime: timeOf(usage.fetchedAt), fresh },
      canCalibrate: running !== null && running.units > 0,
      scope: { counted: [], others: 0 },
    },
  };
}
