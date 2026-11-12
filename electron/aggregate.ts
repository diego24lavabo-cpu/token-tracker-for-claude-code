/**
 * The aggregations behind each IPC endpoint. Everything the UI shows is computed here,
 * in SQL over the derived tables, never in the components.
 */
import {
  addDays,
  daysInRange,
  eachDay,
  isDay,
  lastWeeks,
  previousRange,
  weekStart,
} from '../shared/period';
import type {
  AgentKind,
  Agents,
  AgentTypeRow,
  Calendar,
  CalendarKpis,
  DailyPoint,
  HeatLevel,
  HeatmapDay,
  HeatmapWeek,
  MonthPoint,
  Filters,
  MainSubagentPoint,
  ModelCard,
  Models,
  Overview,
  OverviewShortcuts,
  PeriodChange,
  Pricing,
  ProjectDetail,
  ProjectRow,
  Projects,
  SessionDetail,
  SessionFilters,
  SessionRow,
  Sessions,
  SessionSort,
  SessionSortKey,
  SessionSubagent,
  ShareItem,
  Streak,
  SubagentKind,
  TokenBreakdown,
} from '../shared/types';
import type { UsageDatabase } from './db';
import { costOf } from './pricing';

const TOKENS = 'input + output + cache_write + cache_read';
const INPUT_TOKENS = 'input + cache_write + cache_read';

const KINDS: readonly AgentKind[] = ['main', 'task', 'workflow', 'aside', 'warmup'];
/** Below this share of the current usage, the period before is too small to compare with. */
const NEW_ACTIVITY_THRESHOLD = 0.05;
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

/**
 * Condition on the `hourly` table for a set of filters. `alias` prefixes the columns when
 * the table is joined, for example `h`.
 */
function hourlyWhere(filters: Filters, alias?: string): Where {
  const p = alias ? `${alias}.` : '';
  const where: Where = {
    sql: `${p}local_day BETWEEN ? AND ?`,
    params: [filters.from, filters.to],
  };
  return withListFilters(filters, where, p);
}

/** Condition on the `hourly` table for every filter except the period. */
function anyDayWhere(filters: Filters): Where {
  return withListFilters(filters, { sql: '1', params: [] }, '');
}

/** Adds the machine, project, model, agent type and kind filters; `p` prefixes the columns. */
function withListFilters(filters: Filters, where: Where, p: string): Where {
  inList(`${p}machine_id`, filters.machineIds, where);
  inList(`${p}project`, filters.projects, where);
  inList(`${p}model`, filters.models, where);
  inList(`${p}agent_type`, filters.agentTypes, where);
  inList(`${p}kind`, filters.kinds, where);
  return where;
}

/**
 * Condition on a table with one row per session or invocation, such as `sessions`: a row
 * counts on its start day, and belongs to a single project.
 */
function startDayWhere(filters: Filters): Where {
  const where: Where = { sql: 'start_day BETWEEN ? AND ?', params: [filters.from, filters.to] };
  inList('machine_id', filters.machineIds, where);
  inList('project', filters.projects, where);
  return where;
}

/** The longest project name a request may carry. */
const MAX_NAME_LENGTH = 1_000;

/** Checks a project name received over IPC. */
export function parseProjectName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH) {
    throw new InvalidRequestError('project must be a non-empty string');
  }
  return value;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Compares a total with the one of the period just before. */
export function comparePeriods(current: number, previous: number): PeriodChange {
  if (current <= 0 && previous <= 0) return { kind: 'none' };
  if (previous < current * NEW_ACTIVITY_THRESHOLD) return { kind: 'new' };
  return { kind: 'change', ratio: (current - previous) / previous };
}

interface ModelTotals {
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
}

const MODEL_TOTALS = `model, SUM(input) AS input, SUM(output) AS output,
  SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read,
  SUM(cache_write_1h) AS cache_write_1h`;

/**
 * The estimated cost of per-model totals. Prices are per model, so the cost is summed
 * model by model. `cost` is null when no model with usage has a price.
 */
function costOfModels(
  pricing: Pricing,
  models: readonly ModelTotals[],
): { cost: number | null; costIsPartial: boolean } {
  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  for (const row of models) {
    if (row.input + row.output + row.cache_write + row.cache_read === 0) continue;
    const modelCost = costOf(pricing, row.model, {
      input: row.input,
      output: row.output,
      cacheWrite: row.cache_write,
      cacheRead: row.cache_read,
      cacheWrite1h: row.cache_write_1h,
    });
    if (modelCost === null) {
      unpriced++;
    } else {
      priced++;
      cost += modelCost;
    }
  }
  return { cost: priced > 0 ? cost : null, costIsPartial: priced > 0 && unpriced > 0 };
}

/** The item with the most tokens; ties go to the first name in alphabetical order. */
function largest<T extends { name: string; tokens: number }>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (
      !best ||
      item.tokens > best.tokens ||
      (item.tokens === best.tokens && item.name < best.name)
    ) {
      best = item;
    }
  }
  return best;
}

/** Sorts largest first, ties by name, so every list comes back in a stable order. */
function byTokens(a: { name: string; tokens: number }, b: { name: string; tokens: number }) {
  return b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** True when the database holds any usage for the selected machines, whatever the period. */
function hasAnyUsage(db: UsageDatabase, machineIds?: string[]): boolean {
  const where: Where = { sql: '1', params: [] };
  inList('machine_id', machineIds, where);
  return (
    db.raw
      .prepare(`SELECT 1 FROM hourly WHERE ${where.sql} LIMIT 1`)
      .pluck()
      .get(...where.params) !== undefined
  );
}

/**
 * Consecutive days with usage, counted back from today. A day that has not seen any
 * usage yet does not break the streak: it then ends yesterday. Null without such a run.
 */
function currentStreak(db: UsageDatabase, today: string, machineIds?: string[]): Streak | null {
  const where: Where = { sql: `local_day <= ? AND ${TOKENS} > 0`, params: [today] };
  inList('machine_id', machineIds, where);
  const days = db.raw
    .prepare(`SELECT DISTINCT local_day FROM hourly WHERE ${where.sql} ORDER BY local_day DESC`)
    .pluck()
    .iterate(...where.params) as IterableIterator<string>;

  let streak = null as Streak | null;
  let expected = today;
  for (const day of days) {
    if (day !== expected) {
      if (!streak && day === addDays(today, -1)) {
        expected = day;
      } else {
        break;
      }
    }
    streak = { days: (streak?.days ?? 0) + 1, from: day, to: streak?.to ?? day };
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
    .prepare(`SELECT ${MODEL_TOTALS} FROM hourly WHERE ${where.sql} GROUP BY model`)
    .all(...where.params) as ModelTotals[];

  let inputTokens = 0;
  let outputTokens = 0;
  let mainModel: OverviewShortcuts['model'] = null;
  let mainModelTokens = -1;
  for (const row of models) {
    const input = row.input + row.cache_write + row.cache_read;
    const total = input + row.output;
    if (total === 0) continue;
    inputTokens += input;
    outputTokens += row.output;

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

  return {
    hasData: hasAnyUsage(db, filters.machineIds),
    kpis: {
      totalTokens,
      inputTokens,
      outputTokens,
      totalChange: comparePeriods(totalTokens, previousTotal),
      ...costOfModels(pricing, models),
    },
    daily,
    shortcuts: {
      project: project
        ? { name: project.name, share: ratio(project.tokens, totalTokens), tokens: project.tokens }
        : null,
      model: mainModel,
      activity: {
        currentStreak: currentStreak(db, db.localDay(now), filters.machineIds)?.days ?? 0,
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
      totalChange: { kind: 'none' },
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

// ── Projects ──────────────────────────────────────────────────────────────────

interface ProjectTotals {
  name: string;
  tokens: number;
  input: number;
  output: number;
  subagent: number;
  active_days: number;
}

/**
 * Sessions with activity in a project, counted on their start day like every session
 * count. A session that worked in two projects counts in both.
 */
function sessionsPerProject(
  db: UsageDatabase,
  filters: Filters,
): Map<string, { count: number; tokens: number }> {
  const started = startDayWhere(filters);
  const rows = db.raw
    .prepare(
      `SELECT project, COUNT(*) AS count, SUM(tokens) AS tokens
       FROM session_projects WHERE ${started.sql} GROUP BY project`,
    )
    .all(...started.params) as { project: string; count: number; tokens: number }[];
  return new Map(rows.map((row) => [row.project, row]));
}

/** The Projects page: KPI row and the table of every project used in the period. */
export function getProjects(db: UsageDatabase, filters: Filters): Projects {
  const where = hourlyWhere(filters);
  const raw = db.raw;

  const totals = raw
    .prepare(
      `SELECT project AS name, SUM(${TOKENS}) AS tokens, SUM(${INPUT_TOKENS}) AS input,
              SUM(output) AS output,
              SUM(CASE WHEN kind <> 'main' THEN ${TOKENS} ELSE 0 END) AS subagent,
              COUNT(DISTINCT CASE WHEN ${TOKENS} > 0 THEN local_day END) AS active_days
       FROM hourly WHERE ${where.sql} GROUP BY project HAVING tokens > 0`,
    )
    .all(...where.params) as ProjectTotals[];
  totals.sort(byTokens);

  // The last day with usage, whatever the period.
  const anyDay = anyDayWhere(filters);
  const lastUsed = new Map(
    (
      raw
        .prepare(
          `SELECT project, MAX(local_day) AS day FROM hourly
           WHERE ${anyDay.sql} AND ${TOKENS} > 0 GROUP BY project`,
        )
        .all(...anyDay.params) as { project: string; day: string }[]
    ).map((row) => [row.project, row.day]),
  );

  const modelsByProject = new Map<string, { name: string; tokens: number }[]>();
  const modelRows = raw
    .prepare(
      `SELECT project, model AS name, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY project, model HAVING tokens > 0`,
    )
    .all(...where.params) as { project: string; name: string; tokens: number }[];
  for (const row of modelRows) {
    const list = modelsByProject.get(row.project) ?? [];
    list.push(row);
    modelsByProject.set(row.project, list);
  }

  const sessionsByProject = sessionsPerProject(db, filters);
  // The KPI counts each session once.
  const started = startDayWhere(filters);
  const allSessions = raw
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(${TOKENS}), 0) AS tokens
       FROM sessions WHERE ${started.sql}`,
    )
    .get(...started.params) as { count: number; tokens: number };

  const totalTokens = totals.reduce((sum, row) => sum + row.tokens, 0);
  const totalInput = totals.reduce((sum, row) => sum + row.input, 0);
  const totalOutput = totals.reduce((sum, row) => sum + row.output, 0);
  const top3Tokens = totals.slice(0, 3).reduce((sum, row) => sum + row.tokens, 0);

  const rows: ProjectRow[] = totals.map((row) => {
    const sessions = sessionsByProject.get(row.name);
    return {
      name: row.name,
      tokens: row.tokens,
      share: ratio(row.tokens, totalTokens),
      input: row.input,
      output: row.output,
      outputInputRatio: ratio(row.output, row.input),
      subagentShare: ratio(row.subagent, row.tokens),
      sessions: sessions?.count ?? 0,
      tokensPerSession: sessions && sessions.count > 0 ? sessions.tokens / sessions.count : null,
      activeDays: row.active_days,
      mainModel: largest(modelsByProject.get(row.name) ?? [])?.name ?? '',
      lastUsed: lastUsed.get(row.name) ?? '',
    };
  });

  const main = rows[0];
  return {
    hasData: hasAnyUsage(db, filters.machineIds),
    kpis: {
      activeProjects: rows.length,
      mainProject: main ? { name: main.name, share: main.share } : null,
      tokensPerSession: allSessions.count > 0 ? allSessions.tokens / allSessions.count : null,
      outputInputRatio: ratio(totalOutput, totalInput),
      top3Share: ratio(top3Tokens, totalTokens),
    },
    rows,
  };
}

/** What the Projects page shows when there is no database to read. */
export function emptyProjects(): Projects {
  return {
    hasData: false,
    kpis: {
      activeProjects: 0,
      mainProject: null,
      tokensPerSession: null,
      outputInputRatio: 0,
      top3Share: 0,
    },
    rows: [],
  };
}

/** The analysis panel of one project over the period. */
export function getProjectDetail(
  db: UsageDatabase,
  pricing: Pricing,
  project: string,
  filters: Filters,
): ProjectDetail {
  const scoped: Filters = { ...filters, projects: [project] };
  const where = hourlyWhere(scoped);
  const raw = db.raw;

  const models = raw
    .prepare(`SELECT ${MODEL_TOTALS} FROM hourly WHERE ${where.sql} GROUP BY model`)
    .all(...where.params) as ModelTotals[];
  const modelTokens = models
    .map((row) => ({
      name: row.model,
      tokens: row.input + row.output + row.cache_write + row.cache_read,
    }))
    .filter((row) => row.tokens > 0)
    .sort(byTokens);
  const tokens = modelTokens.reduce((sum, row) => sum + row.tokens, 0);
  const output = models.reduce((sum, row) => sum + row.output, 0);

  const dailyRows = raw
    .prepare(
      `SELECT local_day AS day,
              SUM(CASE WHEN kind = 'main' THEN ${TOKENS} ELSE 0 END) AS main,
              SUM(CASE WHEN kind <> 'main' THEN ${TOKENS} ELSE 0 END) AS subagent
       FROM hourly WHERE ${where.sql} GROUP BY local_day`,
    )
    .all(...where.params) as MainSubagentPoint[];
  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = eachDay(filters.from, filters.to).map(
    (day) => byDay.get(day) ?? { day, main: 0, subagent: 0 },
  );
  const subagentTokens = dailyRows.reduce((sum, row) => sum + row.subagent, 0);

  const joined = hourlyWhere(scoped, 'h');
  const machines = raw
    .prepare(
      `SELECT h.machine_id AS id, COALESCE(m.name, h.machine_id) AS name, SUM(${TOKENS}) AS tokens
       FROM hourly h LEFT JOIN machines m ON m.id = h.machine_id
       WHERE ${joined.sql} GROUP BY h.machine_id HAVING tokens > 0`,
    )
    .all(...joined.params) as { id: string; name: string; tokens: number }[];
  machines.sort(byTokens);

  // Tokens come from `hourly`, which follows every filter; invocations from `subagents`.
  const typeRows = raw
    .prepare(
      `SELECT agent_type AS name, kind, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} AND kind <> 'main'
       GROUP BY agent_type, kind HAVING tokens > 0`,
    )
    .all(...where.params) as { name: string; kind: SubagentKind; tokens: number }[];
  typeRows.sort(byTokens);
  const started = startDayWhere(scoped);
  const invocationRows = raw
    .prepare(
      `SELECT agent_type AS name, kind, COUNT(*) AS count
       FROM subagents WHERE ${started.sql} AND kind <> 'warmup'
       GROUP BY agent_type, kind`,
    )
    .all(...started.params) as { name: string; kind: SubagentKind; count: number }[];
  const typeKey = (row: { name: string; kind: SubagentKind }) => `${row.kind}:${row.name}`;
  const invocations = new Map(invocationRows.map((row) => [typeKey(row), row.count]));

  const hourRows = raw
    .prepare(
      `SELECT local_hour AS hour, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY local_hour`,
    )
    .all(...where.params) as { hour: number; tokens: number }[];
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of hourRows) {
    if (row.hour >= 0 && row.hour < 24) hours[row.hour] = row.tokens;
  }

  // Like the table: every session with activity in the project.
  const sessions = sessionsPerProject(db, scoped).get(project)?.count ?? 0;

  return {
    name: project,
    summary: {
      tokens,
      sessions,
      outputShare: ratio(output, tokens),
      subagentShare: ratio(subagentTokens, tokens),
      ...costOfModels(pricing, models),
    },
    daily,
    models: modelTokens.map((row) => ({ ...row, share: ratio(row.tokens, tokens) })),
    machines: machines.map((row) => ({ ...row, share: ratio(row.tokens, tokens) })),
    agentTypes: typeRows.map((row) => ({
      ...row,
      share: ratio(row.tokens, subagentTokens),
      invocations: invocations.get(typeKey(row)) ?? 0,
    })),
    hours,
  };
}

/** What the analysis panel shows when there is no database to read. */
export function emptyProjectDetail(project: string, filters: Filters): ProjectDetail {
  return {
    name: project,
    summary: {
      tokens: 0,
      sessions: 0,
      outputShare: 0,
      subagentShare: 0,
      cost: null,
      costIsPartial: false,
    },
    daily: eachDay(filters.from, filters.to).map((day) => ({ day, main: 0, subagent: 0 })),
    models: [],
    machines: [],
    agentTypes: [],
    hours: Array.from({ length: 24 }, () => 0),
  };
}

// ── Models ────────────────────────────────────────────────────────────────────

/** The weekly share chart covers this many weeks, whatever the period. */
export const WEEKLY_WEEKS = 12;

/** The Models page: one card per model, and the share of each model week by week. */
export function getModels(db: UsageDatabase, pricing: Pricing, filters: Filters): Models {
  const where = hourlyWhere(filters);
  const raw = db.raw;

  const totals = raw
    .prepare(
      `SELECT ${MODEL_TOTALS}, SUM(messages) AS messages,
              SUM(CASE WHEN kind <> 'main' THEN ${TOKENS} ELSE 0 END) AS subagent
       FROM hourly WHERE ${where.sql} GROUP BY model HAVING SUM(${TOKENS}) > 0`,
    )
    .all(...where.params) as (ModelTotals & { messages: number; subagent: number })[];

  const projectsByModel = new Map<string, { name: string; tokens: number }[]>();
  const projectRows = raw
    .prepare(
      `SELECT model, project AS name, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY model, project HAVING tokens > 0`,
    )
    .all(...where.params) as { model: string; name: string; tokens: number }[];
  for (const row of projectRows) {
    const list = projectsByModel.get(row.model) ?? [];
    list.push(row);
    projectsByModel.set(row.model, list);
  }

  const sized = totals.map((row) => ({
    row,
    name: row.model,
    tokens: row.input + row.output + row.cache_write + row.cache_read,
  }));
  sized.sort(byTokens);
  const totalTokens = sized.reduce((sum, item) => sum + item.tokens, 0);

  const cards: ModelCard[] = sized.map(({ row, tokens }) => {
    const input = row.input + row.cache_write + row.cache_read;
    return {
      name: row.model,
      tokens,
      share: ratio(tokens, totalTokens),
      breakdown: {
        input: row.input,
        output: row.output,
        cacheWrite: row.cache_write,
        cacheRead: row.cache_read,
      },
      input,
      output: row.output,
      cacheHitRate: ratio(row.cache_read, input),
      cost: costOfModels(pricing, [row]).cost,
      messages: row.messages,
      outputPerMessage: row.messages > 0 ? row.output / row.messages : null,
      subagentShare: ratio(row.subagent, tokens),
      topProject: largest(projectsByModel.get(row.model) ?? [])?.name ?? '',
    };
  });

  return { hasData: hasAnyUsage(db, filters.machineIds), cards, ...weeklyShares(db, filters) };
}

/** Tokens per model and week over the weeks that end with the week of `filters.to`. */
function weeklyShares(
  db: UsageDatabase,
  filters: Filters,
): Pick<Models, 'weekly' | 'weeklyModels'> {
  const weeks = lastWeeks(filters.to, WEEKLY_WEEKS);
  const where = hourlyWhere({ ...filters, from: weeks[0]!, to: addDays(weeks.at(-1)!, 6) });
  const rows = db.raw
    .prepare(
      `SELECT local_day AS day, model, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY local_day, model HAVING tokens > 0`,
    )
    .all(...where.params) as { day: string; model: string; tokens: number }[];

  const modelTotals = new Map<string, number>();
  for (const row of rows) {
    modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + row.tokens);
  }
  const weeklyModels = [...modelTotals]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort(byTokens)
    .map((model) => model.name);
  const modelIndex = new Map(weeklyModels.map((name, index) => [name, index]));
  const weekIndex = new Map(weeks.map((week, index) => [week, index]));

  const weekly = weeks.map((week) => ({
    week,
    tokens: weeklyModels.map(() => 0),
  }));
  for (const row of rows) {
    const point = weekly[weekIndex.get(weekStart(row.day)) ?? -1];
    const model = modelIndex.get(row.model);
    if (point && model !== undefined) point.tokens[model] = (point.tokens[model] ?? 0) + row.tokens;
  }
  return { weekly, weeklyModels };
}

/** What the Models page shows when there is no database to read. */
export function emptyModels(filters: Filters): Models {
  return {
    hasData: false,
    cards: [],
    weekly: lastWeeks(filters.to, WEEKLY_WEEKS).map((week) => ({ week, tokens: [] })),
    weeklyModels: [],
  };
}

// ── Calendar ──────────────────────────────────────────────────────────────────

/** The calendar covers today and the days before it, this many in all. */
export const CALENDAR_DAYS = 365;
/** Columns of the heatmap. 365 days ending today always span exactly 53 Monday weeks. */
export const HEATMAP_WEEKS = 53;
const MONTHS = 12;

/** Checks the machine list of `getCalendar` received over IPC. */
export function parseMachineIds(value: unknown): string[] | undefined {
  return stringList(value, 'machineIds');
}

/** The first and last day of the calendar: 365 days ending today. */
function calendarRange(today: string): { from: string; to: string } {
  return { from: addDays(today, 1 - CALENDAR_DAYS), to: today };
}

/** `YYYY-MM` of the 12 calendar months ending with the month of `today`, oldest first. */
function lastMonths(today: string): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: MONTHS }, (_, index) => {
    const offset = year * 12 + month - (MONTHS - 1) + index;
    return `${Math.floor(offset / 12)}-${String((offset % 12) + 1).padStart(2, '0')}`;
  });
}

/** Monday = 0 … Sunday = 6. */
function weekdayOf(day: string): number {
  return daysInRange(weekStart(day), day) - 1;
}

/**
 * Where levels 2, 3 and 4 start: the quartiles of the active days' tokens. Quartiles keep
 * one big day from turning every other day into level 1.
 */
function heatThresholds(activeTokens: readonly number[]): number[] {
  if (activeTokens.length === 0) return [];
  const sorted = [...activeTokens].sort((a, b) => a - b);
  const n = sorted.length;
  return [1, 2, 3].map((k) => sorted[Math.min(n - 1, Math.ceil((n * k) / 4))]!);
}

function heatLevel(tokens: number, thresholds: readonly number[]): HeatLevel {
  if (tokens <= 0) return 0;
  let level = 1;
  for (const threshold of thresholds) {
    if (tokens >= threshold) level++;
  }
  return level as HeatLevel;
}

/** The 53 weeks of the heatmap, with null for the days outside `from` … `to`. */
function heatmapWeeks(from: string, to: string, dayOf: (day: string) => HeatmapDay): HeatmapWeek[] {
  const first = weekStart(from);
  return Array.from({ length: HEATMAP_WEEKS }, (_, week) => {
    const start = addDays(first, 7 * week);
    return {
      start,
      days: Array.from({ length: 7 }, (_, weekday) => {
        const day = addDays(start, weekday);
        return day < from || day > to ? null : dayOf(day);
      }),
    };
  });
}

/** The longest run of consecutive days in an ascending list; the latest one on a tie. */
function longestRun(days: readonly string[]): Streak | null {
  // `as` keeps the declared type: an annotation would narrow both to `null` in the loop.
  let best = null as Streak | null;
  let run = null as Streak | null;
  for (const day of days) {
    run =
      run && addDays(run.to, 1) === day
        ? { days: run.days + 1, from: run.from, to: day }
        : { days: 1, from: day, to: day };
    if (!best || run.days >= best.days) best = run;
  }
  return best;
}

/**
 * The Calendar page: the last 12 months, whatever the period. Only the machine filter
 * applies. `now` is the current instant; it decides which day is today.
 */
export function getCalendar(
  db: UsageDatabase,
  machineIds?: string[],
  now: number = Date.now(),
): Calendar {
  const today = db.localDay(now);
  const { from, to } = calendarRange(today);
  const raw = db.raw;
  const range: Filters = { from, to, machineIds };
  const where = hourlyWhere(range);

  const dayRows = raw
    .prepare(
      `SELECT local_day AS day, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY local_day HAVING tokens > 0 ORDER BY local_day`,
    )
    .all(...where.params) as { day: string; tokens: number }[];
  // Sessions with activity that day, subagents included, so a session that runs past
  // midnight counts on both days. `messages` holds this machine's responses only.
  const sessionRows =
    !machineIds || machineIds.includes(db.machineId)
      ? (raw
          .prepare(
            `SELECT local_day AS day, COUNT(DISTINCT session_id) AS count FROM messages
             WHERE local_day BETWEEN ? AND ? GROUP BY local_day`,
          )
          .all(from, to) as { day: string; count: number }[])
      : [];

  const tokensByDay = new Map(dayRows.map((row) => [row.day, row.tokens]));
  const sessionsByDay = new Map(sessionRows.map((row) => [row.day, row.count]));
  const thresholds = heatThresholds(dayRows.map((row) => row.tokens));
  const weeks = heatmapWeeks(from, to, (day) => {
    const tokens = tokensByDay.get(day) ?? 0;
    return {
      day,
      tokens,
      sessions: sessionsByDay.get(day) ?? 0,
      level: heatLevel(tokens, thresholds),
    };
  });

  const byWeekday = Array.from({ length: 7 }, () => 0);
  let total = 0;
  let bestDay: CalendarKpis['bestDay'] = null;
  for (const row of dayRows) {
    byWeekday[weekdayOf(row.day)]! += row.tokens;
    total += row.tokens;
    // Days come in ascending order, so `>=` keeps the latest of equal days.
    if (!bestDay || row.tokens >= bestDay.tokens) bestDay = { day: row.day, tokens: row.tokens };
  }
  let bestWeekday: number | null = null;
  byWeekday.forEach((tokens, index) => {
    if (tokens > 0 && (bestWeekday === null || tokens > byWeekday[bestWeekday]!)) {
      bestWeekday = index;
    }
  });

  const hourRows = raw
    .prepare(
      `SELECT local_hour AS hour, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY local_hour`,
    )
    .all(...where.params) as { hour: number; tokens: number }[];
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const row of hourRows) {
    if (row.hour >= 0 && row.hour < 24) byHour[row.hour] = row.tokens;
  }

  const months = lastMonths(today);
  const monthWhere = hourlyWhere({ from: `${months[0]}-01`, to, machineIds });
  const monthRows = raw
    .prepare(
      `SELECT substr(local_day, 1, 7) AS month, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${monthWhere.sql} GROUP BY month`,
    )
    .all(...monthWhere.params) as MonthPoint[];
  const tokensByMonth = new Map(monthRows.map((row) => [row.month, row.tokens]));

  return {
    hasData: hasAnyUsage(db, machineIds),
    today,
    heatmap: { from, to, weeks, thresholds },
    kpis: {
      activeDays: dayRows.length,
      totalDays: CALENDAR_DAYS,
      currentStreak: currentStreak(db, today, machineIds),
      longestStreak: longestRun(dayRows.map((row) => row.day)),
      bestDay,
      averagePerActiveDay: dayRows.length > 0 ? total / dayRows.length : null,
    },
    byWeekday,
    bestWeekday,
    byHour,
    byMonth: months.map((month) => ({ month, tokens: tokensByMonth.get(month) ?? 0 })),
  };
}

/** What the Calendar page shows when there is no database to read. */
export function emptyCalendar(today: string): Calendar {
  const { from, to } = calendarRange(today);
  return {
    hasData: false,
    today,
    heatmap: {
      from,
      to,
      weeks: heatmapWeeks(from, to, (day) => ({ day, tokens: 0, sessions: 0, level: 0 })),
      thresholds: [],
    },
    kpis: {
      activeDays: 0,
      totalDays: CALENDAR_DAYS,
      currentStreak: null,
      longestStreak: null,
      bestDay: null,
      averagePerActiveDay: null,
    },
    byWeekday: Array.from({ length: 7 }, () => 0),
    bestWeekday: null,
    byHour: Array.from({ length: 24 }, () => 0),
    byMonth: lastMonths(today).map((month) => ({ month, tokens: 0 })),
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** Rows per page of the sessions table. */
export const SESSIONS_PAGE_SIZE = 25;
/** Upper bounds (excluded) of the first four size bins; the fifth has none. */
const SIZE_BOUNDS = [50_000, 200_000, 500_000, 1_000_000];
/** Upper bounds (excluded) of the first four duration bins, in milliseconds. */
const DURATION_BOUNDS = [10, 30, 60, 120].map((minutes) => minutes * 60_000);
const SESSION_SORT_KEYS: readonly SessionSortKey[] = [
  'start',
  'machine',
  'project',
  'model',
  'duration',
  'messages',
  'subagents',
  'input',
  'output',
  'cost',
];
const MAX_PAGE = 1_000_000;

/** Checks the filters of `getSessions` received over IPC. */
export function parseSessionFilters(value: unknown): SessionFilters {
  const filters = parseFilters(value);
  const day = (value as Record<string, unknown>).day;
  if (day === undefined || day === null) return filters;
  if (!isDay(day)) throw new InvalidRequestError('day must be a day written as YYYY-MM-DD');
  return { ...filters, day };
}

/** Checks a page number received over IPC (from 0). */
export function parsePage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_PAGE) {
    throw new InvalidRequestError('page must be a whole number from 0');
  }
  return value;
}

/** Checks the sort order of the sessions table received over IPC. */
export function parseSessionSort(value: unknown): SessionSort {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const { key, direction } = input;
  if (typeof key !== 'string' || !(SESSION_SORT_KEYS as readonly string[]).includes(key)) {
    throw new InvalidRequestError('sort.key is not a column of the sessions table');
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new InvalidRequestError('sort.direction must be asc or desc');
  }
  return { key: key as SessionSortKey, direction };
}

/** Checks a machine id and a session id received over IPC. */
export function parseSessionKey(
  machineId: unknown,
  sessionId: unknown,
): { machineId: string; sessionId: string } {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
  if (!valid(machineId) || !valid(sessionId)) {
    throw new InvalidRequestError('machineId and sessionId must be non-empty strings');
  }
  return { machineId, sessionId };
}

/**
 * Condition on `sessions s` for the Sessions page. Without a day, a session counts on its
 * start day, like every session count. With a day, the sessions with activity that day
 * count, subagents included, as the Calendar shows them: a session that runs past
 * midnight is on both days. `messages` holds this machine's responses only, so other
 * machines have no sessions by day until sync carries them.
 * `lists` = false leaves out the project and model filters, for the filter menus.
 */
function sessionsWhere(db: UsageDatabase, filters: SessionFilters, lists = true): Where {
  const where: Where = filters.day
    ? {
        sql: `s.machine_id = ? AND s.session_id IN (
                SELECT session_id FROM messages WHERE local_day = ?)`,
        params: [db.machineId, filters.day],
      }
    : { sql: 's.start_day BETWEEN ? AND ?', params: [filters.from, filters.to] };
  inList('s.machine_id', filters.machineIds, where);
  if (!lists) return where;

  // A session belongs to every project it has activity in, as on the Projects page.
  if (filters.projects) {
    if (filters.projects.length === 0) {
      where.sql += ' AND 0';
    } else {
      where.sql += ` AND EXISTS (SELECT 1 FROM session_projects sp
        WHERE sp.machine_id = s.machine_id AND sp.session_id = s.session_id
          AND sp.project IN (${filters.projects.map(() => '?').join(', ')}))`;
      where.params.push(...filters.projects);
    }
  }
  // The model column: the main session's model.
  inList('s.model', filters.models, where);
  return where;
}

interface SessionDbRow {
  machine_id: string;
  session_id: string;
  machine: string;
  project: string;
  model: string;
  start_ts: number;
  end_ts: number;
  start_day: string;
  messages: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
  subagent_count: number;
  active_ms: number;
}

const SESSION_COLUMNS = `s.machine_id, s.session_id, COALESCE(m.name, s.machine_id) AS machine,
  s.project, s.model, s.start_ts, s.end_ts, s.start_day, s.messages,
  s.input, s.output, s.cache_write, s.cache_read, s.cache_write_1h,
  s.subagent_count, s.active_ms`;

const sessionKey = (machineId: string, sessionId: string) => `${machineId}\n${sessionId}`;

type CostResult = { cost: number | null; costIsPartial: boolean };

/**
 * The estimated cost of sessions, keyed by `sessionKey`. This machine's sessions are
 * priced model by model from their responses; a session of another machine only has its
 * main model, which then prices all its tokens.
 */
function sessionCosts(
  db: UsageDatabase,
  pricing: Pricing,
  rows: readonly SessionDbRow[],
  where: Where,
): Map<string, CostResult> {
  const byModel = new Map<string, ModelTotals[]>();
  const local = db.raw
    .prepare(
      `SELECT session_id, ${MODEL_TOTALS} FROM messages
       WHERE session_id IN (SELECT s.session_id FROM sessions s
                            WHERE ${where.sql} AND s.machine_id = ?)
       GROUP BY session_id, model`,
    )
    .all(...where.params, db.machineId) as (ModelTotals & { session_id: string })[];
  for (const row of local) {
    const list = byModel.get(row.session_id) ?? [];
    list.push(row);
    byModel.set(row.session_id, list);
  }

  const costs = new Map<string, CostResult>();
  for (const row of rows) {
    const models = (row.machine_id === db.machineId ? byModel.get(row.session_id) : undefined) ?? [
      row,
    ];
    costs.set(sessionKey(row.machine_id, row.session_id), costOfModels(pricing, models));
  }
  return costs;
}

function median(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const middle = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function average(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Counts values per bin; `bounds` are the excluded upper bounds of all bins but the last. */
function histogram(values: readonly number[], bounds: readonly number[]): number[] {
  const bins = Array.from({ length: bounds.length + 1 }, () => 0);
  for (const value of values) {
    const index = bounds.findIndex((bound) => value < bound);
    bins[index === -1 ? bounds.length : index]!++;
  }
  return bins;
}

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

function sessionSortValue(row: SessionRow, key: SessionSortKey): number | string | null {
  switch (key) {
    case 'start':
      return row.start;
    case 'machine':
      return row.machine;
    case 'project':
      return row.project;
    case 'model':
      return row.model;
    case 'duration':
      return row.activeMs;
    case 'messages':
      return row.messages;
    case 'subagents':
      return row.subagents;
    case 'input':
      return row.input;
    case 'output':
      return row.output;
    case 'cost':
      return row.cost;
  }
}

/** Sorts in place. No value (a cost without price) goes last; ties go to the latest start. */
function sortSessions(rows: SessionRow[], sort: SessionSort): void {
  const sign = sort.direction === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const left = sessionSortValue(a, sort.key);
    const right = sessionSortValue(b, sort.key);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left), String(right));
      if (order !== 0) return sign * order;
    }
    return b.start - a.start || collator.compare(a.id, b.id);
  });
}

/**
 * The Sessions page: KPIs and histograms of every matching session, and one page of the
 * table. Token columns include the subagents; durations are active time.
 */
export function getSessions(
  db: UsageDatabase,
  pricing: Pricing,
  filters: SessionFilters,
  page: number,
  sort: SessionSort,
): Sessions {
  const raw = db.raw;
  const where = sessionsWhere(db, filters);
  const dbRows = raw
    .prepare(
      `SELECT ${SESSION_COLUMNS}
       FROM sessions s LEFT JOIN machines m ON m.id = s.machine_id
       WHERE ${where.sql}`,
    )
    .all(...where.params) as SessionDbRow[];
  const costs = sessionCosts(db, pricing, dbRows, where);

  const rows: SessionRow[] = dbRows.map((row) => {
    const input = row.input + row.cache_write + row.cache_read;
    return {
      id: row.session_id,
      machineId: row.machine_id,
      machine: row.machine,
      project: row.project,
      model: row.model,
      start: row.start_ts,
      startDay: row.start_day,
      startTime: db.localDayTime(row.start_ts).time,
      activeMs: row.active_ms,
      messages: row.messages,
      subagents: row.subagent_count,
      input,
      output: row.output,
      tokens: input + row.output,
      cost: costs.get(sessionKey(row.machine_id, row.session_id))?.cost ?? null,
    };
  });

  const tokens = rows.map((row) => row.tokens).sort((a, b) => a - b);
  const durations = rows.map((row) => row.activeMs).sort((a, b) => a - b);
  const activeDays = filters.day
    ? Math.min(rows.length, 1)
    : new Set(rows.map((row) => row.startDay)).size;
  let biggest: SessionRow | undefined;
  for (const row of rows) {
    if (
      !biggest ||
      row.tokens > biggest.tokens ||
      (row.tokens === biggest.tokens && row.start > biggest.start)
    ) {
      biggest = row;
    }
  }

  sortSessions(rows, sort);
  const lastPage = Math.max(0, Math.ceil(rows.length / SESSIONS_PAGE_SIZE) - 1);
  const shown = Math.min(page, lastPage);

  // The filter menus list what the period offers, whatever is picked in them.
  const scope = sessionsWhere(db, filters, false);
  const projects = raw
    .prepare(
      `SELECT DISTINCT sp.project FROM session_projects sp
       JOIN sessions s ON s.machine_id = sp.machine_id AND s.session_id = sp.session_id
       WHERE ${scope.sql}`,
    )
    .pluck()
    .all(...scope.params) as string[];
  const models = raw
    .prepare(`SELECT DISTINCT s.model FROM sessions s WHERE ${scope.sql}`)
    .pluck()
    .all(...scope.params) as string[];

  return {
    hasData: hasAnyUsage(db, filters.machineIds),
    kpis: {
      sessions: rows.length,
      activeDays,
      sessionsPerActiveDay: activeDays > 0 ? rows.length / activeDays : null,
      averageActiveMs: average(durations),
      medianActiveMs: median(durations),
      averageTokens: average(tokens),
      medianTokens: median(tokens),
      averageMessages: average(rows.map((row) => row.messages)),
      biggest: biggest
        ? {
            id: biggest.id,
            machineId: biggest.machineId,
            project: biggest.project,
            day: biggest.startDay,
            tokens: biggest.tokens,
          }
        : null,
    },
    sizeHist: histogram(tokens, SIZE_BOUNDS),
    durationHist: histogram(durations, DURATION_BOUNDS),
    rows: rows.slice(shown * SESSIONS_PAGE_SIZE, (shown + 1) * SESSIONS_PAGE_SIZE),
    total: rows.length,
    page: shown,
    pageSize: SESSIONS_PAGE_SIZE,
    projects: projects.sort(collator.compare),
    models: models.sort(collator.compare),
  };
}

/** What the Sessions page shows when there is no database to read. */
export function emptySessions(): Sessions {
  return {
    hasData: false,
    kpis: {
      sessions: 0,
      activeDays: 0,
      sessionsPerActiveDay: null,
      averageActiveMs: null,
      medianActiveMs: null,
      averageTokens: null,
      medianTokens: null,
      averageMessages: null,
      biggest: null,
    },
    sizeHist: histogram([], SIZE_BOUNDS),
    durationHist: histogram([], DURATION_BOUNDS),
    rows: [],
    total: 0,
    page: 0,
    pageSize: SESSIONS_PAGE_SIZE,
    projects: [],
    models: [],
  };
}

interface SubagentDbRow {
  agent_id: string;
  agent_type: string;
  kind: SessionSubagent['kind'];
  model: string;
  start_ts: number;
  end_ts: number;
  active_ms: number;
  calls: number;
  startup_input: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

/** The drawer of one session: main vs subagent tokens, and its subagent invocations. */
export function getSessionDetail(
  db: UsageDatabase,
  pricing: Pricing,
  machineId: string,
  sessionId: string,
): SessionDetail | null {
  const raw = db.raw;
  const session = raw
    .prepare(
      `SELECT ${SESSION_COLUMNS}
       FROM sessions s LEFT JOIN machines m ON m.id = s.machine_id
       WHERE s.machine_id = ? AND s.session_id = ?`,
    )
    .get(machineId, sessionId) as SessionDbRow | undefined;
  if (!session) return null;

  const agents = raw
    .prepare(
      `SELECT agent_id, agent_type, kind, model, start_ts, end_ts, active_ms, calls,
              startup_input, input, output, cache_write, cache_read
       FROM subagents WHERE machine_id = ? AND session_id = ?
       ORDER BY start_ts, agent_id`,
    )
    .all(machineId, sessionId) as SubagentDbRow[];

  const subagentTokens: TokenBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let from = session.start_ts;
  let to = session.end_ts;
  const subagents: SessionSubagent[] = agents.map((agent) => {
    subagentTokens.input += agent.input;
    subagentTokens.output += agent.output;
    subagentTokens.cacheWrite += agent.cache_write;
    subagentTokens.cacheRead += agent.cache_read;
    from = Math.min(from, agent.start_ts);
    to = Math.max(to, agent.end_ts);
    const { day, time } = db.localDayTime(agent.start_ts);
    return {
      agentId: agent.agent_id,
      type: agent.agent_type,
      kind: agent.kind,
      model: agent.model,
      start: agent.start_ts,
      end: agent.end_ts,
      startDay: day,
      startTime: time,
      activeMs: agent.active_ms,
      calls: agent.calls,
      startupInput: agent.startup_input,
      tokens: agent.input + agent.output + agent.cache_write + agent.cache_read,
    };
  });

  const total = session.input + session.output + session.cache_write + session.cache_read;
  const projectRows = raw
    .prepare(
      `SELECT project AS name, tokens FROM session_projects
       WHERE machine_id = ? AND session_id = ?`,
    )
    .all(machineId, sessionId) as { name: string; tokens: number }[];
  projectRows.sort(byTokens);

  const keyWhere: Where = {
    sql: 's.machine_id = ? AND s.session_id = ?',
    params: [machineId, sessionId],
  };
  const cost = sessionCosts(db, pricing, [session], keyWhere).get(
    sessionKey(machineId, sessionId),
  )!;

  return {
    id: sessionId,
    machineId,
    machine: session.machine,
    project: session.project,
    model: session.model,
    start: session.start_ts,
    end: session.end_ts,
    startDay: session.start_day,
    startTime: db.localDayTime(session.start_ts).time,
    activeMs: session.active_ms,
    spanMs: session.end_ts - session.start_ts,
    messages: session.messages,
    subagentCount: session.subagent_count,
    main: {
      input: session.input - subagentTokens.input,
      output: session.output - subagentTokens.output,
      cacheWrite: session.cache_write - subagentTokens.cacheWrite,
      cacheRead: session.cache_read - subagentTokens.cacheRead,
    },
    subagentTokens,
    ...cost,
    projects: projectRows.map((row) => ({ ...row, share: ratio(row.tokens, total) })),
    subagents,
    timeline: { from, to },
  };
}

// ── Agents ────────────────────────────────────────────────────────────────────

/** Kinds of subagent runs, in the order the Kinds breakdown lists them. */
const SUBAGENT_KINDS: readonly SubagentKind[] = ['task', 'workflow', 'aside', 'warmup'];
/** Rows of the "Biggest invocations" table. */
export const TOP_INVOCATIONS = 10;

/**
 * Condition on `subagents s`: a run counts on its start day, like a session, and in the
 * project it spent the most tokens in.
 */
function subagentsWhere(filters: Filters): Where {
  const where: Where = { sql: 's.start_day BETWEEN ? AND ?', params: [filters.from, filters.to] };
  inList('s.machine_id', filters.machineIds, where);
  inList('s.project', filters.projects, where);
  return where;
}

interface AgentRunRow {
  machine_id: string;
  machine: string;
  session_id: string;
  agent_id: string;
  project: string;
  agent_type: string;
  kind: SubagentKind;
  model: string;
  start_ts: number;
  start_day: string;
  active_ms: number;
  calls: number;
  startup_input: number;
  output: number;
  tokens: number;
}

const typeKeyOf = (type: string, kind: SubagentKind) => `${kind}\n${type}`;

const SUBAGENT_MODEL_TOTALS = (p: string) => `SUM(${p}.input) AS input, SUM(${p}.output) AS output,
  SUM(${p}.cache_write) AS cache_write, SUM(${p}.cache_read) AS cache_read,
  SUM(${p}.cache_write_1h) AS cache_write_1h`;

/**
 * Tokens per agent type, kind and model, to price each type and find its main model.
 * This machine's runs are split model by model from their responses; a run of another
 * machine only has its main model, which then gets all its tokens.
 */
function agentTypeModels(db: UsageDatabase, where: Where): Map<string, Map<string, ModelTotals>> {
  const local = db.raw
    .prepare(
      `SELECT s.agent_type, s.kind, m.model, ${SUBAGENT_MODEL_TOTALS('m')}
       FROM subagents s
       JOIN messages m ON m.session_id = s.session_id AND m.agent_id = s.agent_id
       WHERE ${where.sql} AND s.machine_id = ?
       GROUP BY s.agent_type, s.kind, m.model`,
    )
    .all(...where.params, db.machineId);
  const others = db.raw
    .prepare(
      `SELECT s.agent_type, s.kind, s.model, ${SUBAGENT_MODEL_TOTALS('s')}
       FROM subagents s WHERE ${where.sql} AND s.machine_id <> ?
       GROUP BY s.agent_type, s.kind, s.model`,
    )
    .all(...where.params, db.machineId);

  const byType = new Map<string, Map<string, ModelTotals>>();
  for (const row of [...local, ...others] as (ModelTotals & {
    agent_type: string;
    kind: SubagentKind;
  })[]) {
    const key = typeKeyOf(row.agent_type, row.kind);
    const models = byType.get(key) ?? new Map<string, ModelTotals>();
    const sum = models.get(row.model);
    models.set(
      row.model,
      sum
        ? {
            model: row.model,
            input: sum.input + row.input,
            output: sum.output + row.output,
            cache_write: sum.cache_write + row.cache_write,
            cache_read: sum.cache_read + row.cache_read,
            cache_write_1h: sum.cache_write_1h + row.cache_write_1h,
          }
        : { ...row },
    );
    byType.set(key, models);
  }
  return byType;
}

/** Items with tokens, largest first, with each one's share of their total. */
function shareItems(rows: readonly { name: string; tokens: number }[]): ShareItem[] {
  const items = rows.filter((row) => row.tokens > 0).sort(byTokens);
  const total = items.reduce((sum, row) => sum + row.tokens, 0);
  return items.map((row) => ({
    name: row.name,
    tokens: row.tokens,
    share: ratio(row.tokens, total),
  }));
}

/**
 * The Agents page. Tokens per day, the subagent share and the models come from `hourly`,
 * like the Overview; everything per run (types, kinds, averages, top 10) from
 * `subagents`, where a run counts on its start day.
 */
export function getAgents(db: UsageDatabase, pricing: Pricing, filters: Filters): Agents {
  const raw = db.raw;
  const where = hourlyWhere(filters);

  const dailyRows = raw
    .prepare(
      `SELECT local_day AS day,
              SUM(CASE WHEN kind = 'main' THEN ${TOKENS} ELSE 0 END) AS main,
              SUM(CASE WHEN kind <> 'main' THEN ${TOKENS} ELSE 0 END) AS subagent
       FROM hourly WHERE ${where.sql} GROUP BY local_day`,
    )
    .all(...where.params) as MainSubagentPoint[];
  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = eachDay(filters.from, filters.to).map(
    (day) => byDay.get(day) ?? { day, main: 0, subagent: 0 },
  );
  const mainTokens = dailyRows.reduce((sum, row) => sum + row.main, 0);
  const subagentTokens = dailyRows.reduce((sum, row) => sum + row.subagent, 0);

  const modelRows = raw
    .prepare(
      `SELECT model AS name, kind = 'main' AS is_main, SUM(${TOKENS}) AS tokens
       FROM hourly WHERE ${where.sql} GROUP BY model, kind = 'main'`,
    )
    .all(...where.params) as { name: string; is_main: number; tokens: number }[];
  const modelTotals = new Map<string, number>();
  for (const row of modelRows) {
    modelTotals.set(row.name, (modelTotals.get(row.name) ?? 0) + row.tokens);
  }

  const runWhere = subagentsWhere(filters);
  const runs = raw
    .prepare(
      `SELECT s.machine_id, COALESCE(m.name, s.machine_id) AS machine, s.session_id, s.agent_id,
              s.project, s.agent_type, s.kind, s.model, s.start_ts, s.start_day, s.active_ms,
              s.calls, s.startup_input, s.output,
              s.input + s.output + s.cache_write + s.cache_read AS tokens
       FROM subagents s LEFT JOIN machines m ON m.id = s.machine_id
       WHERE ${runWhere.sql}`,
    )
    .all(...runWhere.params) as AgentRunRow[];

  // KPIs: invocations leave warm-ups out; the averages keep only tasks and workflows.
  const invocations = runs.filter((run) => run.kind !== 'warmup');
  const agentRuns = invocations.filter((run) => run.kind === 'task' || run.kind === 'workflow');
  const runTokens = agentRuns.map((run) => run.tokens).sort((a, b) => a - b);

  const started = startDayWhere(filters);
  const sessions = raw
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subagent_count > 0), 0) AS with_subagents
       FROM sessions WHERE ${started.sql}`,
    )
    .get(...started.params) as { count: number; with_subagents: number };

  // By agent type and kind.
  const typeModels = agentTypeModels(db, runWhere);
  const groups = new Map<string, AgentRunRow[]>();
  for (const run of runs) {
    const key = typeKeyOf(run.agent_type, run.kind);
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }
  const allRunTokens = runs.reduce((sum, run) => sum + run.tokens, 0);
  const sumOf = (list: readonly AgentRunRow[], pick: (run: AgentRunRow) => number) =>
    list.reduce((sum, run) => sum + pick(run), 0);
  const byType: AgentTypeRow[] = [...groups.values()].map((list) => {
    const { agent_type: type, kind } = list[0]!;
    const tokens = sumOf(list, (run) => run.tokens);
    const models = [...(typeModels.get(typeKeyOf(type, kind))?.values() ?? [])];
    const main = largest(
      models.map((row) => ({
        name: row.model,
        tokens: row.input + row.output + row.cache_write + row.cache_read,
      })),
    );
    return {
      type,
      kind,
      runs: list.length,
      tokens,
      share: ratio(tokens, allRunTokens),
      averageTokens: tokens / list.length,
      averageStartup: sumOf(list, (run) => run.startup_input) / list.length,
      averageActiveMs: sumOf(list, (run) => run.active_ms) / list.length,
      averageCalls: sumOf(list, (run) => run.calls) / list.length,
      outputShare: ratio(
        sumOf(list, (run) => run.output),
        tokens,
      ),
      mainModel: main?.name ?? list[0]!.model,
      cost: costOfModels(pricing, models).cost,
    };
  });
  const byKindAndType = (
    a: { kind: SubagentKind; type: string },
    b: { kind: SubagentKind; type: string },
  ) =>
    SUBAGENT_KINDS.indexOf(a.kind) - SUBAGENT_KINDS.indexOf(b.kind) ||
    collator.compare(a.type, b.type);
  byType.sort((a, b) => b.tokens - a.tokens || byKindAndType(a, b));

  const startupByType = byType
    .filter((row) => row.kind !== 'warmup')
    .map((row) => ({
      type: row.type,
      kind: row.kind,
      runs: row.runs,
      averageStartup: row.averageStartup,
    }))
    .sort((a, b) => b.averageStartup - a.averageStartup || byKindAndType(a, b));

  const kinds = SUBAGENT_KINDS.map((kind) => {
    const list = runs.filter((run) => run.kind === kind);
    const tokens = sumOf(list, (run) => run.tokens);
    return { kind, runs: list.length, tokens, share: ratio(tokens, allRunTokens) };
  });

  const top = [...invocations]
    .sort((a, b) => b.tokens - a.tokens || b.start_ts - a.start_ts)
    .slice(0, TOP_INVOCATIONS)
    .map((run) => ({
      machineId: run.machine_id,
      machine: run.machine,
      sessionId: run.session_id,
      agentId: run.agent_id,
      project: run.project,
      type: run.agent_type,
      kind: run.kind,
      model: run.model,
      start: run.start_ts,
      startDay: run.start_day,
      startTime: db.localDayTime(run.start_ts).time,
      activeMs: run.active_ms,
      calls: run.calls,
      startupInput: run.startup_input,
      tokens: run.tokens,
    }));

  const anyRun: Where = { sql: '1', params: [] };
  inList('machine_id', filters.machineIds, anyRun);
  const hasSubagents =
    raw
      .prepare(`SELECT 1 FROM subagents WHERE ${anyRun.sql} LIMIT 1`)
      .pluck()
      .get(...anyRun.params) !== undefined;

  const modelsOf = (main: boolean) =>
    shareItems(
      modelRows
        .filter((row) => (row.is_main === 1) === main)
        .map(({ name, tokens }) => ({ name, tokens })),
    );

  return {
    hasData: hasAnyUsage(db, filters.machineIds),
    hasSubagents,
    kpis: {
      subagentTokens,
      subagentShare: ratio(subagentTokens, mainTokens + subagentTokens),
      invocations: invocations.length,
      sessions: sessions.count,
      invocationsPerSession: sessions.count > 0 ? invocations.length / sessions.count : null,
      averageTokens: average(runTokens),
      medianTokens: median(runTokens),
      averageStartup: average(agentRuns.map((run) => run.startup_input)),
      averageActiveMs: average(agentRuns.map((run) => run.active_ms)),
      sessionsWithSubagents: sessions.with_subagents,
      sessionsWithSubagentsShare:
        sessions.count > 0 ? sessions.with_subagents / sessions.count : null,
    },
    daily,
    byType,
    startupByType,
    top,
    kinds,
    modelsMainVsSub: {
      models: shareItems([...modelTotals].map(([name, tokens]) => ({ name, tokens }))).map(
        (item) => item.name,
      ),
      main: modelsOf(true),
      subagents: modelsOf(false),
    },
  };
}

/** What the Agents page shows when there is no database to read. */
export function emptyAgents(filters: Filters): Agents {
  return {
    hasData: false,
    hasSubagents: false,
    kpis: {
      subagentTokens: 0,
      subagentShare: 0,
      invocations: 0,
      sessions: 0,
      invocationsPerSession: null,
      averageTokens: null,
      medianTokens: null,
      averageStartup: null,
      averageActiveMs: null,
      sessionsWithSubagents: 0,
      sessionsWithSubagentsShare: null,
    },
    daily: eachDay(filters.from, filters.to).map((day) => ({ day, main: 0, subagent: 0 })),
    byType: [],
    startupByType: [],
    top: [],
    kinds: SUBAGENT_KINDS.map((kind) => ({ kind, runs: 0, tokens: 0, share: 0 })),
    modelsMainVsSub: { models: [], main: [], subagents: [] },
  };
}
