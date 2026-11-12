import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgents,
  getDailyExport,
  getModels,
  getOverview,
  getProjects,
  InvalidRequestError,
} from '../electron/aggregate';
import { DEFAULT_CLEANUP_DAYS, readRetention, writeCleanupDays } from '../electron/claudeSettings';
import { buildCsvTable, csvFileName, toCsv } from '../electron/csv';
import type { UsageDatabase } from '../electron/db';
import { claudeSettingsFile, logFolderFromPick, samePath } from '../electron/paths';
import { DEFAULT_PRICING, validatePricing } from '../electron/pricing';
import { scanLogs } from '../electron/scanner';
import {
  getContainerCandidates,
  getExtraLogRoots,
  getFileWatching,
  getUsedModels,
  parseCsvKind,
  parseSettingsPatch,
  setExtraLogRoots,
  setFileWatching,
} from '../electron/settings';
import type { Filters, Pricing } from '../shared/types';
import {
  assistantLine,
  cleanupTempDirs,
  fixtureRoot,
  MAC_CWD,
  MAC_FOLDER,
  openMemoryDb,
  SESSION_A,
  SESSION_B,
  tempDir,
  tokenTotal,
  writeLines,
} from './helpers';

const open: UsageDatabase[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

function track(db: UsageDatabase): UsageDatabase {
  open.push(db);
  return db;
}

async function fixtureDb(): Promise<UsageDatabase> {
  const db = track(openMemoryDb());
  await scanLogs(db, [fixtureRoot('mac')]);
  return db;
}

const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
const PRICING: Pricing = {
  lastChecked: null,
  models: { 'Opus 5.5': flat, 'Sonnet 5.5': flat, 'Haiku 5.5': flat, 'Fable 5.2': flat },
};
const BOTH_DAYS: Filters = { from: '2026-11-09', to: '2026-11-10' };
const WEEK: Filters = { from: '2026-11-05', to: '2026-11-11' };

/** Parses the CSV text written by `toCsv` back into rows (no quoted line breaks here). */
function parseCsv(text: string): string[][] {
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.endsWith('\r\n')).toBe(true);
  return text
    .slice(1, -2)
    .split('\r\n')
    .map((line) => {
      const cells: string[] = [];
      const pattern = /("(?:[^"]|"")*"|[^,]*)(,|$)/g;
      for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
        const raw = match[1] ?? '';
        cells.push(raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw);
        if (match[2] === '') break;
      }
      return cells;
    });
}

describe('CSV export', () => {
  it('quotes cells, keeps formulas from running and writes empty cells for null', () => {
    const text = toCsv({
      header: ['name', 'value'],
      rows: [
        ['plain', 1],
        ['with, comma', 2.5],
        ['with "quotes"', null],
        ['=HYPERLINK("x")', 0],
        ['-rf', Number.NaN],
        ['line\nbreak', 3],
      ],
    });
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('name,value');
    expect(lines[1]).toBe('plain,1');
    expect(lines[2]).toBe('"with, comma",2.5');
    expect(lines[3]).toBe('"with ""quotes""",');
    expect(lines[4]).toBe(`"'=HYPERLINK(""x"")",0`);
    expect(lines[5]).toBe("'-rf,");
    expect(text).toContain('"line\nbreak",3');
  });

  it('exports one row per day with the same totals and cost as the Overview', async () => {
    const db = await fixtureDb();
    const rows = getDailyExport(db, PRICING, WEEK);
    expect(rows.map((row) => row.day)).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
    const overview = getOverview(db, PRICING, WEEK);
    const total = (row: (typeof rows)[number]) =>
      row.tokens.input + row.tokens.output + row.tokens.cacheWrite + row.tokens.cacheRead;
    expect(rows.reduce((sum, row) => sum + total(row), 0)).toBe(overview.kpis.totalTokens);
    expect(rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)).toBeCloseTo(
      overview.kpis.cost ?? Number.NaN,
      12,
    );
    for (const [index, point] of overview.daily.entries()) {
      const row = rows[index]!;
      expect(row.tokens.input + row.tokens.cacheWrite + row.tokens.cacheRead).toBe(point.input);
      expect(row.tokens.output).toBe(point.output);
      expect(row.subagentTokens).toBe(point.subagent);
    }
    // A day without usage costs nothing; a day with only unpriced models has no cost.
    expect(rows[0]?.cost).toBe(0);
    const unpriced = getDailyExport(db, { lastChecked: null, models: {} }, BOTH_DAYS);
    expect(unpriced.every((row) => row.cost === null)).toBe(true);
  });

  it('builds the four tables from the page aggregations', async () => {
    const db = await fixtureDb();

    const daily = parseCsv(toCsv(buildCsvTable('daily', db, PRICING, BOTH_DAYS)));
    expect(daily[0]).toEqual([
      'date',
      'input',
      'output',
      'cache_write',
      'cache_read',
      'total_tokens',
      'subagent_tokens',
      'api_calls',
      'estimated_cost_usd',
    ]);
    expect(daily).toHaveLength(3);
    const dailyTotal = daily.slice(1).reduce((sum, row) => sum + Number(row[5]), 0);
    expect(dailyTotal).toBe(tokenTotal(db, 'hourly'));

    const projects = buildCsvTable('projects', db, PRICING, BOTH_DAYS);
    const projectRows = getProjects(db, BOTH_DAYS).rows;
    expect(projects.rows.map((row) => row[0])).toEqual(projectRows.map((row) => row.name));
    expect(projects.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(dailyTotal);

    const models = buildCsvTable('models', db, PRICING, BOTH_DAYS);
    const cards = getModels(db, PRICING, BOTH_DAYS).cards;
    expect(models.rows.map((row) => row[0])).toEqual(cards.map((card) => card.name));
    expect(models.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(dailyTotal);
    expect(models.header).toHaveLength(models.rows[0]!.length);

    const types = buildCsvTable('agentTypes', db, PRICING, BOTH_DAYS);
    const byType = getAgents(db, PRICING, BOTH_DAYS).byType;
    expect(types.rows.map((row) => `${row[0]}/${row[1]}`)).toEqual(
      byType.map((row) => `${row.type}/${row.kind}`),
    );
    expect(types.header).toHaveLength(types.rows[0]!.length);
  });

  it('names the files after the export and the period', () => {
    expect(csvFileName('daily', BOTH_DAYS)).toBe(
      'token-tracker-daily-2026-11-09-to-2026-11-10.csv',
    );
    expect(csvFileName('agentTypes', BOTH_DAYS)).toBe(
      'token-tracker-agent-types-2026-11-09-to-2026-11-10.csv',
    );
  });
});

describe('validatePricing', () => {
  it('accepts a complete table and adds back the default models', () => {
    const pricing = validatePricing({
      lastChecked: '2026-11-12',
      models: { 'Opus 5.5': flat, 'Custom 1.0': { ...flat, output: 0 } },
    });
    expect(pricing.lastChecked).toBe('2026-11-12');
    expect(pricing.models['Opus 5.5']).toEqual(flat);
    expect(pricing.models['Custom 1.0']?.output).toBe(0);
    for (const model of Object.keys(DEFAULT_PRICING.models)) {
      expect(pricing.models[model]).toBeDefined();
    }
  });

  it('rejects anything it would have to drop or guess', () => {
    const bad = [
      null,
      [],
      { lastChecked: 'yesterday', models: {} },
      { lastChecked: null, models: [] },
      { lastChecked: null, models: { 'Opus 5.5': { ...flat, input: -1 } } },
      { lastChecked: null, models: { 'Opus 5.5': { ...flat, output: Number.NaN } } },
      { lastChecked: null, models: { 'Opus 5.5': { ...flat, cacheRead: '1' } } },
      { lastChecked: null, models: { 'Opus 5.5': { input: 1, output: 1 } } },
      { lastChecked: null, models: { 'Opus 5.5': { ...flat, input: 20_000 } } },
      { lastChecked: null, models: { ' ': flat } },
    ];
    for (const value of bad) expect(() => validatePricing(value)).toThrow();
  });
});

describe('settings', () => {
  it('keeps the file watching switch and the added folders', () => {
    const db = track(openMemoryDb());
    expect(getFileWatching(db)).toBe(true);
    setFileWatching(db, false);
    expect(getFileWatching(db)).toBe(false);

    expect(getExtraLogRoots(db)).toEqual([]);
    setExtraLogRoots(db, ['/data/projects', '/data/projects', '/other/projects']);
    expect(getExtraLogRoots(db)).toEqual(['/data/projects', '/other/projects']);
    db.setSetting('extra_log_roots', '{broken');
    expect(getExtraLogRoots(db)).toEqual([]);
  });

  it('lists the folders with usage in subfolders as container candidates', async () => {
    const db = track(openMemoryDb());
    const root = path.join(tempDir(), 'projects');
    writeLines(path.join(root, MAC_FOLDER, `${SESSION_A}.jsonl`), [
      assistantLine({ id: 'top', cwd: MAC_CWD, u: [10, 0, 0, 0] }),
      assistantLine({ id: 'a1', cwd: `${MAC_CWD}/alpha`, u: [30, 0, 0, 0] }),
      assistantLine({ id: 'a2', cwd: `${MAC_CWD}/alpha/src`, u: [30, 0, 0, 0] }),
      assistantLine({ id: 'b1', cwd: `${MAC_CWD}/beta`, u: [30, 0, 0, 0] }),
    ]);
    writeLines(path.join(root, '-Users-alex-dev-flat', `${SESSION_B}.jsonl`), [
      assistantLine({ id: 'flat', session: SESSION_B, cwd: '/Users/alex/dev/flat' }),
    ]);
    await scanLogs(db, [root]);

    expect(getContainerCandidates(db)).toEqual([
      {
        name: 'demo-app',
        flagged: false,
        tokens: 100,
        subfolderShare: 0.9,
        subfolderCount: 2,
        topSubfolders: ['alpha', 'beta'],
      },
    ]);

    // Flagging splits the project but the candidate stays listed, under its raw name.
    db.setContainerProjects(['demo-app', 'gone']);
    const candidates = getContainerCandidates(db);
    expect(candidates.map((item) => [item.name, item.flagged])).toEqual([
      ['demo-app', true],
      ['gone', true],
    ]);
    expect(candidates[1]).toMatchObject({ tokens: 0, subfolderCount: 0, subfolderShare: 0 });
    expect(
      getProjects(db, BOTH_DAYS)
        .rows.map((row) => row.name)
        .sort(),
    ).toEqual(['alpha', 'beta', 'demo-app', 'flat']);
    expect(getUsedModels(db)).toEqual([{ name: 'Opus 5.5', tokens: 100 + 115 }]);
  });

  it('rebuilds by reading every transcript again without losing any usage', async () => {
    const root = path.join(tempDir(), 'projects');
    fs.cpSync(fixtureRoot('mac'), root, { recursive: true });
    const db = track(openMemoryDb());
    await scanLogs(db, [root]);
    const before = tokenTotal(db, 'hourly');
    const messages = db.stats().messages;
    expect(db.filesPerRoot().get(root)).toBe(db.stats().files);

    // A transcript deleted by Claude Code: its history must survive the rebuild.
    fs.rmSync(path.join(root, '-Users-alex-dev-other-tool'), { recursive: true });
    db.resetFileStates();
    expect(db.stats().files).toBe(0);
    const summary = await scanLogs(db, [root]);
    expect(summary.filesRead).toBe(summary.filesFound);
    expect(summary.imported).toBe(0);
    expect(db.stats().messages).toBe(messages);
    expect(tokenTotal(db, 'hourly')).toBe(before);
  });

  it('checks the changes sent by the UI', () => {
    expect(parseSettingsPatch({})).toEqual({});
    expect(
      parseSettingsPatch({ fileWatching: false, launchAtLogin: true, containerProjects: ['a'] }),
    ).toEqual({ fileWatching: false, launchAtLogin: true, containerProjects: ['a'] });
    expect(parseSettingsPatch({ pricing: PRICING }).pricing?.models['Opus 5.5']).toEqual(flat);

    for (const bad of [
      null,
      'x',
      { fileWatching: 'yes' },
      { containerProjects: 'a' },
      { containerProjects: [''] },
      { containerProjects: [1] },
      { pricing: { lastChecked: null, models: { a: { input: -1 } } } },
    ]) {
      expect(() => parseSettingsPatch(bad)).toThrow(InvalidRequestError);
    }
    expect(parseCsvKind('models')).toBe('models');
    expect(() => parseCsvKind('sessions')).toThrow(InvalidRequestError);
  });
});

describe("Claude Code's cleanupPeriodDays", () => {
  it('reads the value, the default and an unreadable file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.json');
    expect(readRetention(file)).toEqual({ exists: false, readable: true, cleanupPeriodDays: null });

    fs.writeFileSync(file, '{"model": "opus"}');
    expect(readRetention(file).cleanupPeriodDays).toBeNull();
    fs.writeFileSync(file, `${String.fromCharCode(0xfeff)}{"cleanupPeriodDays": 90}`);
    expect(readRetention(file)).toEqual({ exists: true, readable: true, cleanupPeriodDays: 90 });
    fs.writeFileSync(file, '{"cleanupPeriodDays": -4}');
    expect(readRetention(file).cleanupPeriodDays).toBeNull();
    fs.writeFileSync(file, '{ broken, // comment');
    expect(readRetention(file)).toEqual({ exists: true, readable: false, cleanupPeriodDays: null });
    expect(DEFAULT_CLEANUP_DAYS).toBe(30);
  });

  it('sets the value and keeps every other setting', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(
      file,
      '{"model":"opus","permissions":{"allow":["Bash(ls)"]},"cleanupPeriodDays":30}',
    );
    writeCleanupDays(file, 365);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      cleanupPeriodDays: 365,
    });
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);

    // A missing file is created.
    const fresh = path.join(dir, 'fresh.json');
    writeCleanupDays(fresh, 120);
    expect(JSON.parse(fs.readFileSync(fresh, 'utf8'))).toEqual({ cleanupPeriodDays: 120 });
  });

  it('never writes a file it cannot parse', () => {
    const file = path.join(tempDir(), 'settings.json');
    const content = '{ "model": "opus", // a comment\n }';
    fs.writeFileSync(file, content);
    expect(() => writeCleanupDays(file, 365)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(() => writeCleanupDays(file, 0)).toThrow();
  });
});

describe('path helpers', () => {
  it("finds Claude Code's settings file", () => {
    expect(claudeSettingsFile({ home: '/Users/alex', env: {}, platform: 'darwin' })).toBe(
      '/Users/alex/.claude/settings.json',
    );
    expect(
      claudeSettingsFile({
        home: 'C:\\Users\\alex',
        env: { CLAUDE_CONFIG_DIR: ' D:\\claude , E:\\other' },
        platform: 'win32',
      }),
    ).toBe('D:\\claude\\settings.json');
  });

  it('turns a picked Claude folder into its projects folder', () => {
    const claude = path.join(tempDir(), '.claude');
    fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
    expect(logFolderFromPick(claude)).toBe(path.join(claude, 'projects'));
    expect(logFolderFromPick(path.join(claude, 'projects') + path.sep)).toBe(
      path.join(claude, 'projects'),
    );
    const other = tempDir();
    expect(logFolderFromPick(other)).toBe(other);
  });

  it('compares paths like the file system', () => {
    expect(samePath('C:\\Users\\Alex\\x', 'c:\\users\\alex\\x\\', 'win32')).toBe(true);
    expect(samePath('/Users/Alex', '/users/alex', 'darwin')).toBe(true);
    expect(samePath('/home/Alex', '/home/alex', 'linux')).toBe(false);
  });
});
