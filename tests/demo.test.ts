/**
 * Demo mode: the sample data generator (scripts/demo-data.mjs) and the demo folder with its
 * fake second computer (electron/demo.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRandom, DEMO_MARKER, generateDemoData } from '../scripts/demo-data.mjs';
import { getMachinesDetail, getOverview } from '../electron/aggregate';
import { UsageDatabase } from '../electron/db';
import { createDemoEnvironment, generateDemoWorld, removeDemoEnvironment } from '../electron/demo';
import { DEFAULT_PRICING } from '../electron/pricing';
import { scanLogs } from '../electron/scanner';
import { SyncService } from '../electron/sync';
import { cleanupTempDirs, tempDir, tokenTotal } from './helpers';

/**
 * Generating writes many small files, which is slow on Windows runners (a year of data took
 * 7 s there): the tests use a few days, and the two that need more files get this timeout.
 */
const SLOW_TEST_MS = 30_000;
const SMALL = { endDay: '2026-11-10', days: 10 } as const;
const SESSIONS_IN_SMALL = 16;

const open: UsageDatabase[] = [];
const services: SyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const db of open.splice(0)) db.close();
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

/** Every file under `root`, relative, sorted, with its content. */
function snapshot(root: string): Map<string, string> {
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
  const result = new Map<string, string>();
  for (const file of files) {
    const full = path.join(root, file);
    if (fs.statSync(full).isFile()) result.set(file, fs.readFileSync(full, 'utf8'));
  }
  return result;
}

function jsonlLines(root: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const [file, text] of snapshot(root)) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of text.split('\n')) if (line) lines.push(JSON.parse(line));
  }
  return lines;
}

describe('createRandom', () => {
  it('gives the same numbers for the same seed, others for another', () => {
    const draw = (seed: number) => Array.from({ length: 5 }, createRandom(seed));
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
    for (const value of draw(7)) expect(value >= 0 && value < 1).toBe(true);
  });

  it('does not repeat its sequence', () => {
    // The generator before it came back to an earlier state after about 10,000 draws, so
    // every later run of draws (session ids included) was a copy. 4 draws = 128 bits: two
    // equal windows in 200,000 draws would mean the sequence repeats.
    const rand = createRandom(42);
    const windows = new Set<string>();
    for (let i = 0; i < 50_000; i++) windows.add([rand(), rand(), rand(), rand()].join());
    expect(windows.size).toBe(50_000);
  });
});

describe('generateDemoData', () => {
  it('gives the same data for the same seed and day', () => {
    const a = path.join(tempDir(), 'projects');
    const b = path.join(tempDir(), 'projects');
    expect(generateDemoData(a, SMALL)).toBe(SESSIONS_IN_SMALL);
    generateDemoData(b, SMALL);
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it(
    'writes every session to its own file, also after many draws',
    () => {
      // 90 days are about 25,000 draws: well past the point where the old generator repeated.
      const root = path.join(tempDir(), 'projects');
      const sessions = generateDemoData(root, { endDay: '2026-11-10', days: 90 });
      expect(sessions).toBeGreaterThan(100);
      const mainFiles = [...snapshot(root).keys()].filter(
        (file) => file.endsWith('.jsonl') && !file.includes('subagents'),
      );
      expect(mainFiles).toHaveLength(sessions);
    },
    SLOW_TEST_MS,
  );

  it('uses distinct message ids for distinct seeds', () => {
    const a = path.join(tempDir(), 'projects');
    const b = path.join(tempDir(), 'projects');
    generateDemoData(a, { ...SMALL, seed: 1 });
    generateDemoData(b, { ...SMALL, seed: 2 });
    const ids = (root: string) =>
      new Set(jsonlLines(root).map((line) => (line.message as { id: string }).id));
    const first = ids(a);
    expect([...ids(b)].some((id) => first.has(id))).toBe(false);
  });

  it('writes fake Windows or macOS paths only', () => {
    const win = path.join(tempDir(), 'projects');
    const mac = path.join(tempDir(), 'projects');
    generateDemoData(win, SMALL);
    generateDemoData(mac, { ...SMALL, paths: 'posix', projects: ['demo-app'] });

    expect(fs.readdirSync(win).filter((name) => name !== DEMO_MARKER)).toContain(
      'C--Users-alex-dev-demo-app',
    );
    expect(fs.readdirSync(mac).filter((name) => name !== DEMO_MARKER)).toEqual([
      '-Users-alex-dev-demo-app',
    ]);
    const cwds = new Set(jsonlLines(mac).map((line) => line.cwd));
    expect([...cwds]).toEqual(['/Users/alex/dev/demo-app']);
    for (const line of jsonlLines(win)) {
      expect(line.cwd).toMatch(/^C:\\Users\\alex\\dev\\[a-z-]+$/);
    }
  });

  it('replaces its own data but refuses any other non-empty folder', () => {
    const root = path.join(tempDir(), 'projects');
    generateDemoData(root, SMALL);
    expect(() => generateDemoData(root, { ...SMALL, endDay: '2026-11-09' })).not.toThrow();

    const other = tempDir();
    fs.writeFileSync(path.join(other, 'keep.txt'), 'mine');
    expect(() => generateDemoData(other, SMALL)).toThrow(/not empty/);
    expect(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a real Claude Code log folder, even one it wrote', () => {
    const config = tempDir();
    const projects = path.join(config, 'projects');
    generateDemoData(projects, SMALL);
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    expect(() => generateDemoData(projects, SMALL)).toThrow(/real Claude Code log folder/);
    expect(fs.existsSync(path.join(projects, DEMO_MARKER))).toBe(true);
  });
});

describe('demo environment', () => {
  it(
    'builds two computers that sync through the demo folder',
    async () => {
      const env = createDemoEnvironment('darwin', tempDir());
      // A small world: the app's defaults (a year and four months) take seconds to write.
      await generateDemoWorld(env, 'darwin', '0.1.0', { localDays: 20, otherDays: 10 });

      const db = new UsageDatabase(':memory:', {
        machineName: env.machineName,
        platform: 'darwin',
      });
      open.push(db);
      await scanLogs(db, [env.logRoot]);
      const sync = new SyncService({
        database: () => db,
        appVersion: '0.1.0',
        platform: 'darwin',
        serial: <T>(task: () => T | Promise<T>) => Promise.resolve().then(task),
        onDataChanged: () => undefined,
        onStatusChanged: () => undefined,
      });
      services.push(sync);
      sync.setFolder(env.syncFolder, true);
      await sync.setEnabled(true, async () => []);

      const machines = db.listMachines();
      expect(machines.map((machine) => [machine.name, machine.platform, machine.isLocal])).toEqual([
        ['MacBook Pro', 'darwin', true],
        ['Desktop PC', 'win32', false],
      ]);
      expect(sync.status().state).toBe('synced');

      // A year of both machines: the Overview adds them up, and the Machines page splits them.
      const year = { from: '2025-11-01', to: '2026-12-31' };
      const overview = getOverview(db, DEFAULT_PRICING, year);
      const total = tokenTotal(db, 'hourly');
      expect(overview.kpis.totalTokens).toBe(total);
      const detail = getMachinesDetail(db, DEFAULT_PRICING, year);
      expect(detail.cards.map((card) => card.name)).toEqual(['MacBook Pro', 'Desktop PC']);
      expect(detail.cards.reduce((sum, card) => sum + card.tokens, 0)).toBe(total);
      expect(detail.cards.every((card) => card.tokens > 0)).toBe(true);

      removeDemoEnvironment(env);
      expect(fs.readdirSync(env.root)).toEqual(['.token-tracker-demo']);
    },
    SLOW_TEST_MS,
  );

  it('sweeps the folders of earlier runs, never other folders', () => {
    const parent = tempDir();
    const now = Date.now();
    const quit = createDemoEnvironment('win32', parent, now);
    removeDemoEnvironment(quit);
    const running = createDemoEnvironment('win32', parent, now);
    fs.mkdirSync(running.logRoot, { recursive: true });
    const unrelated = path.join(parent, 'token-tracker-demo-unrelated');
    fs.mkdirSync(unrelated);

    // A minute later the emptied folder goes; a folder with logs stays for a day.
    createDemoEnvironment('win32', parent, now + 2 * 60_000);
    expect(fs.existsSync(quit.root)).toBe(false);
    expect(fs.existsSync(running.root)).toBe(true);
    createDemoEnvironment('win32', parent, now + 25 * 3600_000);
    expect(fs.existsSync(running.root)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
