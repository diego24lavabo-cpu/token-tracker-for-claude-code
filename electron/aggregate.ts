/**
 * The aggregations behind each IPC endpoint. Everything the UI shows is computed here,
 * in SQL over the derived tables, never in the components.
 */
import { addDays, daysInRange, eachDay, isDay, previousRange } from '../shared/period';
import type {
  AgentKind,
  DailyPoint,
  Filters,
  Overview,
  OverviewShortcuts,
  Pricing,
} from '../shared/types';
import type { UsageDatabase } from './db';
import { costOf } from './pricing';

const TOKENS = 'input + output + cache_write + cache_read';
const INPUT_TOKENS = 'input + cache_write + cache_read';

const KINDS: readonly AgentKind[] = ['main', 'task', 'workflow', 'aside', 'warmup'];
/** The longest range a query accepts, to keep a wrong request from building a huge result. */
const MAX_RANGE_DAYS = 3 * 366;
const MAX_LIST_LENGTH = 500;

/** Thrown when a request from the UI does not have the expected shape. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_LIST_LENGTH ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new InvalidRequestError(`${name} must be a list of strings`);
  }
  return value as string[];
}

/** Checks filters received over IPC and returns a clean copy. */
export function parseFilters(value: unknown): Filters {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidRequestError('filters must be an object');
  }
  const input = value as Record<string, unknown>;
  const { from, to } = input;
  if (!isDay(from) || !isDay(to)) {
    throw new InvalidRequestError('from and to must be days written as YYYY-MM-DD');
  }
  const length = daysInRange(from, to);
  if (length < 1 || length > MAX_RANGE_DAYS) {
    throw new InvalidRequestError('the range must cover between 1 day and 3 years');
  }

  const kinds = stringList(input.kinds, 'kinds');
  if (kinds && !kinds.every((kind) => (KINDS as readonly string[]).includes(kind))) {
    throw new InvalidRequestError('kinds contains an unknown value');
  }
  return {
    from,
    to,
    machineIds: stringList(input.machineIds, 'machineIds'),
    projects: stringList(input.projects, 'projects'),
    models: stringList(input.models, 'models'),
    agentTypes: stringList(input.agentTypes, 'agentTypes'),
    kinds: kinds as AgentKind[] | undefined,
  };
}

interface Where {
  sql: string;
  params: (string | number)[];
}

function inList(column: string, values: readonly string[] | undefined, where: Where): void {
  if (!values) return;
  if (values.length === 0) {
    where.sql += ' AND 0';
    return;
  }
  where.sql += ` AND ${column} IN (${values.map(() => '?').join(', ')})`;
  where.params.push(...values);
}

/** Condition on the `hourly` table for a set of filters. */
function hourlyWhere(filters: Filters): Where {
  const where: Where = { sql: 'local_day BETWEEN ? AND ?', params: [filters.from, filters.to] };
  inList('machine_id', filters.machineIds, where);
  inList('project', filters.projects, where);
  inList('model', filters.models, where);
  inList('agent_type', filters.agentTypes, where);
  inList('kind', filters.kinds, where);
  return where;
}

/** Condition on a table that only has a start day and a machine, such as `sessions`. */
function startDayWhere(filters: Filters): Where {
  const where: Where = { sql: 'start_day BETWEEN ? AND ?', params: [filters.from, filters.to] };
  inList('machine_id', filters.machineIds, where);
  return where;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

interface ModelTotals {
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
}

/**
 * Consecutive days with usage, counted back from today. A day that has not seen any
 * usage yet does not break the streak: it then ends yesterday.
 */
function currentStreak(db: UsageDatabase, today: string, machineIds?: string[]): number {
  const where: Where = { sql: 'local_day <= ?', params: [today] };
  inList('machine_id', machineIds, where);
  const days = db.raw
    .prepare(`SELECT DISTINCT local_day FROM hourly WHERE ${where.sql} ORDER BY local_day DESC`)
    .pluck()
    .iterate(...where.params) as IterableIterator<string>;

  let streak = 0;
  let expected = today;
  for (const day of days) {
    if (day !== expected) {
      if (streak === 0 && day === addDays(today, -1)) {
        expected = day;
      } else {
        break;
      }
    }
    streak++;
    expected = addDays(expected, -1);
  }
  return streak;
}

/**
 * The Overview page: KPI cards, tokens per day and the six shortcut cards.
 * `now` is the current instant; it decides which day counts as today for the streak.
 */
export function getOverview(
  db: UsageDatabase,
  pricing: Pricing,
  filters: Filters,
  now: number = Date.now(),
): Overview {
  const where = hourlyWhere(filters);
  const raw = db.raw;

  // Totals per model: they give the KPI cards, the cost and the main model.
  const models = raw
    .prepare(
      `SELECT model, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read,
              SUM(cache_write_1h) AS cache_write_1h
       FROM hourly WHERE ${where.sql} GROUP BY model`,
    )
    .all(...where.params) as ModelTotals[];

  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let pricedModels = 0;
  let unpricedModels = 0;
  let mainModel: OverviewShortcuts['model'] = null;
  let mainModelTokens = -1;
  for (const row of models) {
    const input = row.input + row.cache_write + row.cache_read;
    const total = input + row.output;
    if (total === 0) continue;
    inputTokens += input;
    outputTokens += row.output;

    const modelCost = costOf(pricing, row.model, {
      input: row.input,
      output: row.output,
      cacheWrite: row.cache_write,
      cacheRead: row.cache_read,
      cacheWrite1h: row.cache_write_1h,
    });
    if (modelCost === null) {
      unpricedModels++;
    } else {
      pricedModels++;
      cost += modelCost;
    }

    if (total > mainModelTokens || (total === mainModelTokens && row.model < mainModel!.name)) {
      mainModelTokens = total;
      mainModel = { name: row.model, share: 0, cacheHitRate: ratio(row.cache_read, input) };
    }
  }
  const totalTokens = inputTokens + outputTokens;
  if (mainModel) mainModel.share = ratio(mainModelTokens, totalTokens);

  const previous = hourlyWhere({ ...filters, ...previousRange(filters.from, filters.to) });
  const previousTotal = raw
    .prepare(`SELECT COALESCE(SUM(${TOKENS}), 0) FROM hourly WHERE ${previous.sql}`)
    .pluck()
    .get(...previous.params) as number;

  // Tokens per day, with a zero for the days without usage.
  const dailyRows = raw
    .prepare(
      `SELECT local_day AS day, SUM(${INPUT_TOKENS}) AS input, SUM(output) AS output,
              SUM(CASE WHEN kind <> 'main' THEN ${TOKENS} ELSE 0 END) AS subagent
       FROM hourly WHERE ${where.sql} GROUP BY local_day`,
    )
    .all(...where.params) as DailyPoint[];
  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = eachDay(filters.from, filters.to).map(
    (day) => byDay.get(day) ?? { day, input: 0, output: 0, subagent: 0 },
  );
  const subagentTokens = dailyRows.reduce((sum, row) => sum + row.subagent, 0);
  const activeDays = dailyRows.filter((row) => row.input + row.output > 0).length;

  const project = raw
    .prepare(
      `SELECT project AS name, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY project
       HAVING tokens > 0 ORDER BY tokens DESC, project LIMIT 1`,
    )
    .get(...where.params) as { name: string; tokens: number } | undefined;

  const started = startDayWhere(filters);
  const sessions = raw
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(${TOKENS}), 0) AS tokens
       FROM sessions WHERE ${started.sql}`,
    )
    .get(...started.params) as { count: number; tokens: number };
  const invocations = raw
    .prepare(`SELECT COUNT(*) FROM subagents WHERE ${started.sql} AND kind <> 'warmup'`)
    .pluck()
    .get(...started.params) as number;

  // The share of each machine is only meaningful across all of them.
  const machineRows = raw
    .prepare(
      `SELECT h.machine_id AS id, COALESCE(m.name, h.machine_id) AS name, SUM(${TOKENS}) AS tokens
       FROM hourly h LEFT JOIN machines m ON m.id = h.machine_id
       WHERE h.local_day BETWEEN ? AND ?
       GROUP BY h.machine_id HAVING tokens > 0 ORDER BY tokens DESC, name`,
    )
    .all(filters.from, filters.to) as { id: string; name: string; tokens: number }[];
  const allMachinesTokens = machineRows.reduce((sum, row) => sum + row.tokens, 0);

  const anyUsage: Where = { sql: '1', params: [] };
  inList('machine_id', filters.machineIds, anyUsage);
  const hasData =
    raw
      .prepare(`SELECT 1 FROM hourly WHERE ${anyUsage.sql} LIMIT 1`)
      .pluck()
      .get(...anyUsage.params) !== undefined;

  return {
    hasData,
    kpis: {
      totalTokens,
      inputTokens,
      outputTokens,
      totalChange: previousTotal > 0 ? (totalTokens - previousTotal) / previousTotal : null,
      cost: pricedModels > 0 ? cost : null,
      costIsPartial: pricedModels > 0 && unpricedModels > 0,
    },
    daily,
    shortcuts: {
      project: project
        ? { name: project.name, share: ratio(project.tokens, totalTokens), tokens: project.tokens }
        : null,
      model: mainModel,
      activity: {
        currentStreak: currentStreak(db, db.localDay(now), filters.machineIds),
        activeDays,
        periodDays: daysInRange(filters.from, filters.to),
      },
      sessions: { count: sessions.count, averageTokens: ratio(sessions.tokens, sessions.count) },
      subagents: { share: ratio(subagentTokens, totalTokens), invocations },
      machines: machineRows.map((row) => ({
        id: row.id,
        name: row.name,
        share: ratio(row.tokens, allMachinesTokens),
      })),
    },
  };
}

/** What the Overview shows when there is no database to read, in the same shape. */
export function emptyOverview(filters: Filters): Overview {
  return {
    hasData: false,
    kpis: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalChange: null,
      cost: null,
      costIsPartial: false,
    },
    daily: eachDay(filters.from, filters.to).map((day) => ({
      day,
      input: 0,
      output: 0,
      subagent: 0,
    })),
    shortcuts: {
      project: null,
      model: null,
      activity: {
        currentStreak: 0,
        activeDays: 0,
        periodDays: daysInRange(filters.from, filters.to),
      },
      sessions: { count: 0, averageTokens: 0 },
      subagents: { share: 0, invocations: 0 },
      machines: [],
    },
  };
}
