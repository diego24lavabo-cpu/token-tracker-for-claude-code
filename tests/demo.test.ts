/**
 * Demo mode: the sample data generator (scripts/demo-data.mjs) and the demo folder with its
 * fake second computer (electron/demo.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MARKER, generateDemoData } from '../scripts/demo-data.mjs';
import { getMachinesDetail, getOverview } from '../electron/aggregate';
import { UsageDatabase } from '../electron/db';
import { createDemoEnvironment, generateDemoWorld, removeDemoEnvironment } from '../electron/demo';
import { DEFAULT_PRICING } from '../electron/pricing';
import { scanLogs } from '../electron/scanner';
import { SyncService } from '../electron/sync';
import { cleanupTempDirs, tempDir, tokenTotal } from './helpers';

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

describe('generateDemoData', () => {
  it('gives the same data for the same seed and day', () => {
    const a = path.join(tempDir(), 'projects');
    const b = path.join(tempDir(), 'projects');
    expect(generateDemoData(a, { endDay: '2026-11-10' })).toBe(56);
    generateDemoData(b, { endDay: '2026-11-10' });
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('never repeats a session over a year', () => {
    const root = path.join(tempDir(), 'projects');
    const sessions = generateDemoData(root, { endDay: '2026-11-10', days: 365 });
    expect(sessions).toBeGreaterThan(500);
    const mainFiles = [...snapshot(root).keys()].filter(
      (file) => file.endsWith('.jsonl') && !file.includes('subagents'),
    );
    expect(mainFiles).toHaveLength(sessions);
  });

  it('uses distinct message ids for distinct seeds', () => {
    const a = path.join(tempDir(), 'projects');
    const b = path.join(tempDir(), 'projects');
    generateDemoData(a, { endDay: '2026-11-10', seed: 1 });
    generateDemoData(b, { endDay: '2026-11-10', seed: 2 });
    const ids = (root: string) =>
      new Set(jsonlLines(root).map((line) => (line.message as { id: string }).id));
    const first = ids(a);
    expect([...ids(b)].some((id) => first.has(id))).toBe(false);
  });

  it('writes fake Windows or macOS paths only', () => {
    const win = path.join(tempDir(), 'projects');
    const mac = path.join(tempDir(), 'projects');
    generateDemoData(win, { endDay: '2026-11-10' });
    generateDemoData(mac, { endDay: '2026-11-10', paths: 'posix', projects: ['demo-app'] });

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
    generateDemoData(root, { endDay: '2026-11-10' });
    expect(() => generateDemoData(root, { endDay: '2026-11-09' })).not.toThrow();

    const other = tempDir();
    fs.writeFileSync(path.join(other, 'keep.txt'), 'mine');
    expect(() => generateDemoData(other)).toThrow(/not empty/);
    expect(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a real Claude Code log folder, even one it wrote', () => {
    const config = tempDir();
    const projects = path.join(config, 'projects');
    generateDemoData(projects, { endDay: '2026-11-10' });
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    expect(() => generateDemoData(projects)).toThrow(/real Claude Code log folder/);
    expect(fs.existsSync(path.join(projects, DEMO_MARKER))).toBe(true);
  });
});

describe('demo environment', () => {
  it('builds two computers that sync through the demo folder', async () => {
    const env = createDemoEnvironment('darwin', tempDir());
    await generateDemoWorld(env, 'darwin', '0.1.0');

    const db = new UsageDatabase(':memory:', { machineName: env.machineName, platform: 'darwin' });
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
  }, 60_000);

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
