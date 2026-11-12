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
  ProjectAgentType,
  ProjectDetail,
  ProjectRow,
  Projects,
  Streak,
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

type SubagentKind = ProjectAgentType['kind'];

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
