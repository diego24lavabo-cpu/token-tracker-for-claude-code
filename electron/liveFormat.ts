/**
 * `machines/<machineId>/live.json`: the last hours of a computer's usage minute by minute,
 * so the other computers' Live pages can show it and merge it into one 5-hour window
 * (Claude's limit is per account, not per computer).
 *
 * Like the year files it carries aggregated numbers only: times, project names (folder
 * names, never paths), model names and token counts. No session ids, no text.
 *
 * - `minutes`: one row per minute, project and model over the last 6 hours, with the
 *   first and last response time of the row, its tokens and how many responses.
 * - `activity`: the responses of the last 24 hours as runs `[first, last]` in which
 *   no two responses are more than a minute apart. It lets the reader chain the windows
 *   of several computers further back than the 6 hours of `minutes`.
 * - `window` / `previous`: the writer's own running window and the last one that has
 *   reset, rebuilt from its whole history, with their tokens per model. (Not its largest
 *   window: one computer's own window can span two of the account's windows.)
 *
 * Times are epoch milliseconds (UTC). Tokens are counted, never priced: the reader prices
 * them with its own `pricing.json`.
 *
 * It is rewritten at most once a minute while the computer is in use, and every 5 minutes
 * as a heartbeat while the app runs with sync on, so a reader can tell an idle computer
 * (still fresh) from one whose app is closed (stale after 15 minutes).
 */
export { LIVE_MIN_VERSION } from '../shared/sync';
import {
  isCount,
  isModelRow,
  isName,
  parseJson,
  type ModelRow,
  type ParseResult,
} from './syncFormat';

/** Version of the `live.json` format. A reader refuses files with a higher one. */
export const LIVE_SCHEMA_VERSION = 1;
/** Hours of `minutes` (the longest range of the Live chart). */
export const LIVE_MINUTE_HOURS = 6;
/** Hours of `activity`. */
export const LIVE_ACTIVITY_HOURS = 24;
/** Responses further apart than this start a new run of `activity`. */
export const ACTIVITY_GAP_MS = 60_000;
/** Shortest time between two writes while the computer is in use. */
export const LIVE_WRITE_INTERVAL_MS = 60_000;
/** The file is rewritten at least this often while the app runs, even when idle. */
export const LIVE_HEARTBEAT_MS = 5 * 60_000;
/** A file written longer ago than this is stale: its app is closed, or Drive is behind. */
export const LIVE_FRESH_MS = 15 * 60_000;
/** A file dated this far ahead of this computer's clock is not trusted as fresh. */
export const LIVE_SKEW_MS = 5 * 60_000;
/** Files larger than this are not read (6 hours of minutes are well under 1 MB). */
export const MAX_LIVE_FILE_BYTES = 16 * 1024 * 1024;
/** Rows kept from one list; more is not a file of this app. */
export const MAX_LIVE_ROWS = 100_000;

const WINDOW_MS = 5 * 60 * 60_000;
const MINUTE_MS = 60_000;
/** Times outside these years are not real response times. */
const EARLIEST = Date.parse('2020-01-01T00:00:00Z');
const LATEST = Date.parse('2100-01-01T00:00:00Z');

/**
 * `[first, last, project, model, input, output, cacheWrite, cacheRead, cacheWrite1h,
 * responses]`: one minute, project and model; `first` and `last` in the same minute.
 */
export type LiveMinuteRow = [
  number,
  number,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** A run of responses `[first, last]`, epoch milliseconds. */
export type ActivityRun = [number, number];

/** One of the writer's 5-hour windows; it resets at `start` + 5 hours. */
export interface LiveFileWindow {
  start: number;
  /** Its last response. */
  last: number;
  responses: number;
  /** Tokens per model, as in the year files (1-hour writes are part of `cacheWrite`). */
  models: ModelRow[];
}

export interface LiveFile {
  schemaVersion: number;
  machineId: string;
  /** When it was written, epoch milliseconds. */
  writtenAt: number;
  /** The start of the first minute `minutes` covers. */
  minutesFrom: number;
  /** The start of what `activity` covers. */
  activityFrom: number;
  /** The writer's window running at `writtenAt`, or null. */
  window: LiveFileWindow | null;
  /** The writer's last window that has reset by `writtenAt`, or null. */
  previous: LiveFileWindow | null;
  activity: ActivityRun[];
  minutes: LiveMinuteRow[];
}

// ── Writing ───────────────────────────────────────────────────────────────────

/** One row per line, so the file stays readable. */
export function serializeLiveFile(file: LiveFile): string {
  const list = (rows: readonly unknown[]) =>
    rows.length === 0 ? '[]' : `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]`;
  const head = {
    schemaVersion: file.schemaVersion,
    machineId: file.machineId,
    writtenAt: file.writtenAt,
    minutesFrom: file.minutesFrom,
    activityFrom: file.activityFrom,
  };
  return (
    `${JSON.stringify(head).slice(0, -1)},\n` +
    `"window":${JSON.stringify(file.window)},\n"previous":${JSON.stringify(file.previous)},\n` +
    `"activity":${list(file.activity)},\n"minutes":${list(file.minutes)}}\n`
  );
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** A response time this app could have written: a whole number of ms, 2020 to 2100. */
export function isTime(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= EARLIEST && value < LATEST
  );
}

function isWindow(value: unknown): value is LiveFileWindow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isTime(v.start) &&
    isTime(v.last) &&
    v.last >= v.start &&
    v.last < v.start + WINDOW_MS &&
    isCount(v.responses) &&
    v.responses > 0 &&
    Array.isArray(v.models) &&
    v.models.length > 0 &&
    v.models.length <= 1_000 &&
    v.models.every(isModelRow)
  );
}

function isRun(value: unknown, from: number, to: number): value is ActivityRun {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isTime(value[0]) &&
    isTime(value[1]) &&
    value[0] <= value[1] &&
    value[0] >= from &&
    value[1] <= to
  );
}

function isMinuteRow(value: unknown, from: number, to: number): value is LiveMinuteRow {
  if (!Array.isArray(value) || value.length !== 10) return false;
  const [first, last, project, model] = value as unknown[];
  return (
    isTime(first) &&
    isTime(last) &&
    first <= last &&
    first >= from &&
    last <= to &&
    Math.floor(first / MINUTE_MS) === Math.floor(last / MINUTE_MS) &&
    isName(project) &&
    isName(model) &&
    value.slice(4).every(isCount) &&
    (value[8] as number) <= (value[6] as number) &&
    (value[9] as number) > 0
  );
}

/**
 * Checks the `live.json` of the machine folder `machineId`. A file that is not JSON, of
 * another machine or of a newer format is refused; a malformed row is skipped.
 */
export function parseLiveFile(text: string, machineId: string): ParseResult<LiveFile> {
  const value = parseJson(text);
  if (value === undefined) return { ok: false, reason: 'json' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'format' };
  }
  const v = value as Record<string, unknown>;
  if (!isCount(v.schemaVersion) || v.schemaVersion < 1) return { ok: false, reason: 'format' };
  if (v.schemaVersion > LIVE_SCHEMA_VERSION) return { ok: false, reason: 'newerVersion' };
  if (v.machineId !== machineId) return { ok: false, reason: 'mismatch' };
  const { writtenAt, minutesFrom, activityFrom } = v;
  if (
    !isTime(writtenAt) ||
    !isTime(minutesFrom) ||
    !isTime(activityFrom) ||
    minutesFrom > writtenAt ||
    activityFrom > writtenAt ||
    (v.window !== null && !isWindow(v.window)) ||
    (v.previous !== null && !isWindow(v.previous)) ||
    !Array.isArray(v.activity) ||
    !Array.isArray(v.minutes)
  ) {
    return { ok: false, reason: 'format' };
  }

  let skippedRows = 0;
  const keep = <T>(rows: unknown[], check: (row: unknown) => row is T): T[] => {
    const kept = rows.slice(0, MAX_LIVE_ROWS).filter(check);
    skippedRows += rows.length - kept.length;
    return kept;
  };
  const activity = keep(v.activity, (row): row is ActivityRun =>
    isRun(row, activityFrom, writtenAt),
  ).map(([first, last]): ActivityRun => [first, last]);
  const minutes = keep(v.minutes, (row): row is LiveMinuteRow =>
    isMinuteRow(row, minutesFrom, writtenAt),
  ).map((row): LiveMinuteRow => [...row]);
  const copyWindow = (window: unknown): LiveFileWindow | null => {
    if (!isWindow(window)) return null;
    return {
      start: window.start,
      last: window.last,
      responses: window.responses,
      models: window.models.map((row): ModelRow => [...row]),
    };
  };
  return {
    ok: true,
    skippedRows,
    value: {
      schemaVersion: v.schemaVersion,
      machineId,
      writtenAt,
      minutesFrom,
      activityFrom,
      window: copyWindow(v.window),
      previous: copyWindow(v.previous),
      activity,
      minutes,
    },
  };
}

/** Written in the last 15 minutes, and not dated more than 5 minutes ahead of `now`. */
export function isLiveFresh(file: Pick<LiveFile, 'writtenAt'>, now: number): boolean {
  return file.writtenAt >= now - LIVE_FRESH_MS && file.writtenAt <= now + LIVE_SKEW_MS;
}

/** `[major, minor, patch]` of a version such as `0.1.2` or `0.1.2-beta.1`, or null. */
function versionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `version` is known and older than `minimum`. */
export function versionBefore(version: string | null | undefined, minimum: string): boolean {
  const a = version ? versionParts(version) : null;
  const b = versionParts(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]!;
  }
  return false;
}
