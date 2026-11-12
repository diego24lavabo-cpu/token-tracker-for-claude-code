/**
 * CSV exports of the tables behind the pages. Each export comes from the same aggregation
 * as its page, so the numbers match what the app shows. Values are raw: token counts as
 * integers, shares as fractions (0.25 = 25%), costs in US dollars.
 */
import type { CsvKind, Filters, Pricing, ProjectRow } from '../shared/types';
import { getAgents, getDailyExport, getModels, getProjects } from './aggregate';
import type { UsageDatabase } from './db';

export const CSV_KINDS: readonly CsvKind[] = ['daily', 'projects', 'models', 'agentTypes'];

type Cell = string | number | null;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export interface CsvTable {
  header: string[];
  rows: Cell[][];
}

/** Shares keep four decimals, costs and averages up to four. */
const round = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const money = (value: number | null) => (value === null ? null : round(value));

/** The projects of the table without the folder rows, largest first. */
function projectLeaves(rows: readonly ProjectRow[]): ProjectRow[] {
  return rows
    .flatMap((row) => row.children ?? [row])
    .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Builds the table of one export. */
export function buildCsvTable(
  kind: CsvKind,
  db: UsageDatabase,
  pricing: Pricing,
  filters: Filters,
): CsvTable {
  switch (kind) {
    case 'daily':
      return {
        header: [
          'date',
          'input',
          'output',
          'cache_write',
          'cache_read',
          'total_tokens',
          'subagent_tokens',
          'api_calls',
          'estimated_cost_usd',
        ],
        rows: getDailyExport(db, pricing, filters).map((row) => [
          row.day,
          row.tokens.input,
          row.tokens.output,
          row.tokens.cacheWrite,
          row.tokens.cacheRead,
          row.tokens.input + row.tokens.output + row.tokens.cacheWrite + row.tokens.cacheRead,
          row.subagentTokens,
          row.messages,
          money(row.cost),
        ]),
      };

    case 'projects':
      return {
        header: [
          'project',
          'tokens',
          'share',
          'total_input',
          'output',
          'output_input_ratio',
          'subagent_share',
          'sessions',
          'tokens_per_session',
          'active_days',
          'main_model',
          'last_used',
        ],
        // One line per project: a container folder's subfolders as `VS Code › name`.
        rows: projectLeaves(getProjects(db, filters).rows).map((row) => [
          row.name,
          row.tokens,
          round(row.share),
          row.input,
          row.output,
          round(row.outputInputRatio),
          round(row.subagentShare),
          row.sessions,
          row.tokensPerSession === null ? null : Math.round(row.tokensPerSession),
          row.activeDays,
          row.mainModel,
          row.lastUsed,
        ]),
      };

    case 'models':
      return {
        header: [
          'model',
          'tokens',
          'share',
          'input',
          'output',
          'cache_write',
          'cache_read',
          'cache_hit_rate',
          'api_calls',
          'output_per_call',
          'subagent_share',
          'top_project',
          'estimated_cost_usd',
        ],
        rows: getModels(db, pricing, filters).cards.map((card) => [
          card.name,
          card.tokens,
          round(card.share),
          card.breakdown.input,
          card.breakdown.output,
          card.breakdown.cacheWrite,
          card.breakdown.cacheRead,
          round(card.cacheHitRate),
          card.messages,
          card.outputPerMessage === null ? null : round(card.outputPerMessage, 1),
          round(card.subagentShare),
          card.topProject,
          money(card.cost),
        ]),
      };

    case 'agentTypes':
      return {
        header: [
          'agent_type',
          'kind',
          'runs',
          'tokens',
          'share',
          'avg_tokens',
          'avg_startup_input',
          'avg_active_seconds',
          'avg_api_calls',
          'output_share',
          'main_model',
          'estimated_cost_usd',
        ],
        rows: getAgents(db, pricing, filters).byType.map((row) => [
          row.type,
          row.kind,
          row.runs,
          row.tokens,
          round(row.share),
          Math.round(row.averageTokens),
          Math.round(row.averageStartup),
          round(row.averageActiveMs / 1000, 1),
          round(row.averageCalls, 1),
          round(row.outputShare),
          row.mainModel,
          money(row.cost),
        ]),
      };
  }
}

/**
 * One cell, quoted when needed. Text that a spreadsheet would run as a formula (starting
 * with `=`, `+`, `-`, `@`, a tab or a carriage return) is prefixed with an apostrophe.
 */
function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The CSV text of a table: comma separated, CRLF line ends (RFC 4180), and a byte order
 * mark so spreadsheet apps read non-ASCII project names as UTF-8.
 */
export function toCsv(table: CsvTable): string {
  const lines = [table.header, ...table.rows].map((row) => row.map(csvCell).join(','));
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}

/** The suggested file name of an export, for example `token-tracker-daily-2026-10-14-to-2026-11-12.csv`. */
export function csvFileName(kind: CsvKind, filters: Filters): string {
  const name = kind === 'agentTypes' ? 'agent-types' : kind;
  return `token-tracker-${name}-${filters.from}-to-${filters.to}.csv`;
}
