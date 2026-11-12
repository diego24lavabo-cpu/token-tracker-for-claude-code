import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getOverview, getProjectDetail, getProjects, getSessions } from '../electron/aggregate';
import { buildCsvTable } from '../electron/csv';
import type { UsageDatabase } from '../electron/db';
import { scanLogs } from '../electron/scanner';
import { containerOf, PROJECT_SEPARATOR, subfolderOf } from '../shared/projects';
import type { Filters, Pricing, ProjectRow } from '../shared/types';
import {
  assistantLine,
  cleanupTempDirs,
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

const FOLDER_CWD = 'C:\\Users\\alex\\VS Code';
const FOLDER = 'C--Users-alex-VS-Code';
const SESSION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAYS: Filters = { from: '2026-11-09', to: '2026-11-10' };
const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
const PRICING: Pricing = {
  lastChecked: null,
  models: { 'Opus 5.5': flat, 'Sonnet 5.5': flat },
};

/**
 * A "VS Code" container folder on Windows with two subfolders and some top-level usage,
 * plus an ordinary project. Session A works in both subfolders, so the folder must count
 * it once.
 */
async function containerDb(): Promise<UsageDatabase> {
  const root = path.join(tempDir(), 'projects');
  writeLines(path.join(root, FOLDER, `${SESSION_A}.jsonl`), [
    assistantLine({
      id: 'a1',
      ts: '2026-11-09T10:00:00Z',
      cwd: `${FOLDER_CWD}\\Astro`,
      u: [100, 10, 0, 0],
    }),
    assistantLine({
      id: 'a2',
      ts: '2026-11-09T10:05:00Z',
      cwd: `${FOLDER_CWD}\\Astro\\src`,
      u: [100, 10, 0, 0],
    }),
    assistantLine({
      id: 'a3',
      ts: '2026-11-10T09:00:00Z',
      cwd: `${FOLDER_CWD}\\Blog`,
      u: [50, 5, 0, 0],
      model: 'claude-sonnet-5-5',
    }),
  ]);
  writeLines(path.join(root, FOLDER, `${SESSION_B}.jsonl`), [
    assistantLine({
      id: 'b1',
      session: SESSION_B,
      ts: '2026-11-10T11:00:00Z',
      cwd: FOLDER_CWD,
      u: [20, 2, 0, 0],
    }),
  ]);
  writeLines(path.join(root, 'C--Users-alex-dev-tool', `${SESSION_C}.jsonl`), [
    assistantLine({
      id: 'c1',
      session: SESSION_C,
      ts: '2026-11-10T12:00:00Z',
      cwd: 'C:\\Users\\alex\\dev\\tool',
      u: [400, 40, 0, 0],
    }),
  ]);

  const db = openMemoryDb();
  open.push(db);
  await scanLogs(db, [root]);
  db.setContainerProjects(['VS Code']);
  return db;
}

const sum = (rows: readonly ProjectRow[], pick: (row: ProjectRow) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

describe('project names of container folders', () => {
  it('names a subfolder "<folder> › <subfolder>"', () => {
    expect(PROJECT_SEPARATOR).toBe(' › ');
    expect(containerOf('VS Code › Astrophotography_TM')).toBe('VS Code');
    expect(subfolderOf('VS Code › Astrophotography_TM')).toBe('Astrophotography_TM');
    expect(containerOf('VS Code')).toBeNull();
    expect(subfolderOf('tool')).toBe('tool');
  });

  it('shows the full name on the other pages and in the CSV', async () => {
    const db = await containerDb();
    expect(getOverview(db, PRICING, DAYS).shortcuts.project?.name).toBe('tool');
    const sessions = getSessions(db, PRICING, DAYS, 0, { key: 'start', direction: 'asc' });
    expect(sessions.projects).toContain('VS Code › Astro');
    expect(sessions.rows.find((row) => row.id === SESSION_A)?.project).toBe('VS Code › Astro');

    const csv = buildCsvTable('projects', db, PRICING, DAYS);
    expect(csv.rows.map((row) => row[0])).toEqual([
      'tool',
      'VS Code › Astro',
      'VS Code › Blog',
      'VS Code',
    ]);
  });
});

describe('getProjects with container folders', () => {
  it('nests the subfolders and the top-level usage under one folder row', async () => {
    const db = await containerDb();
    const { rows, kpis } = getProjects(db, DAYS);

    expect(rows.map((row) => row.name)).toEqual(['tool', 'VS Code']);
    const folder = rows[1]!;
    expect(folder.children?.map((child) => child.name)).toEqual([
      'VS Code › Astro',
      'VS Code › Blog',
      'VS Code',
    ]);
    expect(rows[0]?.children).toBeUndefined();
    // The KPIs count projects, not folders.
    expect(kpis.activeProjects).toBe(4);
    expect(kpis.mainProject?.name).toBe('tool');
  });

  it('gives the folder row the sum of its children', async () => {
    const db = await containerDb();
    const { rows } = getProjects(db, DAYS);
    const folder = rows.find((row) => row.children)!;
    const children = folder.children!;

    expect(folder.tokens).toBe(sum(children, (row) => row.tokens));
    expect(folder.tokens).toBe(220 + 55 + 22);
    expect(folder.input).toBe(sum(children, (row) => row.input));
    expect(folder.output).toBe(sum(children, (row) => row.output));
    expect(folder.share).toBeCloseTo(
      sum(children, (row) => row.share),
      12,
    );
    expect(folder.outputInputRatio).toBeCloseTo(folder.output / folder.input, 12);
    // Every row still adds up to the period's total.
    expect(sum(rows, (row) => row.tokens)).toBe(getOverview(db, PRICING, DAYS).kpis.totalTokens);

    // Session A worked in two subfolders: once for the folder, once in each subfolder.
    expect(children.map((child) => child.sessions)).toEqual([1, 1, 1]);
    expect(folder.sessions).toBe(2);
    expect(folder.tokensPerSession).toBe(folder.tokens / 2);
    expect(folder.activeDays).toBe(2);
    expect(folder.mainModel).toBe('Opus 5.5');
    expect(folder.lastUsed).toBe('2026-11-10');
  });

  it('shows the whole folder or one subfolder in the analysis panel', async () => {
    const db = await containerDb();
    const whole = getProjectDetail(db, PRICING, 'VS Code', DAYS, true);
    const astro = getProjectDetail(db, PRICING, 'VS Code › Astro', DAYS);
    const blog = getProjectDetail(db, PRICING, 'VS Code › Blog', DAYS);
    const top = getProjectDetail(db, PRICING, 'VS Code', DAYS);

    expect(whole.folder).toBe(true);
    expect(top.folder).toBe(false);
    expect(whole.summary.tokens).toBe(
      astro.summary.tokens + blog.summary.tokens + top.summary.tokens,
    );
    expect(top.summary.tokens).toBe(22);
    expect(whole.summary.sessions).toBe(2);
    expect(whole.summary.cost).toBeCloseTo(
      (astro.summary.cost ?? 0) + (blog.summary.cost ?? 0) + (top.summary.cost ?? 0),
      12,
    );
    expect(whole.models.map((model) => model.name)).toEqual(['Opus 5.5', 'Sonnet 5.5']);
    const daily = whole.daily.reduce((total, day) => total + day.main + day.subagent, 0);
    expect(daily).toBe(whole.summary.tokens);
  });

  it('does not group anything when no folder is flagged', async () => {
    const db = await containerDb();
    db.setContainerProjects([]);
    const { rows } = getProjects(db, DAYS);
    expect(rows.map((row) => row.name)).toEqual(['tool', 'VS Code']);
    expect(rows.every((row) => row.children === undefined)).toBe(true);
  });
});
