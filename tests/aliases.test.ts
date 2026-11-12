/**
 * Project aliases: an old project name mapped to a new one, applied to this machine's
 * usage, to other machines' usage, to container folders and to the sync files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getOverview, getProjectDetail, getProjects } from '../electron/aggregate';
import { UsageDatabase } from '../electron/db';
import { scanLogs } from '../electron/scanner';
import { getContainerCandidates, parseProjectAliases } from '../electron/settings';
import { SyncService } from '../electron/sync';
import {
  aliasMap,
  aliasProblem,
  applyAliases,
  resolveAlias,
  type ProjectAlias,
} from '../shared/projects';
import type { Filters, Platform, Pricing } from '../shared/types';
import {
  assistantLine,
  cleanupTempDirs,
  fixtureRoot,
  SESSION_A,
  SESSION_B,
  tempDir,
  tokenTotal,
  writeLines,
} from './helpers';

const open: UsageDatabase[] = [];
const services: SyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

const DAYS: Filters = { from: '2026-11-08', to: '2026-11-12' };
const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
const PRICING: Pricing = { lastChecked: null, models: { 'Opus 5.5': flat } };
const EVENING = Date.parse('2026-11-12T20:00:00Z');

function database(name = 'Tower', platform: Platform = 'win32'): UsageDatabase {
  const db = new UsageDatabase(':memory:', { timeZone: 'UTC', machineName: name, platform });
  open.push(db);
  return db;
}

const map = (pairs: [string, string][]) => aliasMap(pairs.map(([from, to]) => ({ from, to })));

describe('alias rules', () => {
  it('follows chains and stops on a cycle', () => {
    const aliases = map([
      ['A', 'B'],
      ['B', 'C'],
    ]);
    expect(resolveAlias('A', aliases)).toBe('C');
    expect(resolveAlias('B', aliases)).toBe('C');
    expect(resolveAlias('C', aliases)).toBe('C');
    expect(resolveAlias('X', aliases)).toBe('X');
    // A cycle cannot be saved, but a stored one never loops forever.
    expect(
      resolveAlias(
        'A',
        map([
          ['A', 'B'],
          ['B', 'A'],
        ]),
      ),
    ).toBe('B');
  });

  it('renames the folder part of a subfolder project', () => {
    const aliases = map([
      ['VS Code', 'Code-2026'],
      ['Code-2026 › Old', 'New'],
    ]);
    expect(applyAliases('VS Code', aliases)).toBe('Code-2026');
    expect(applyAliases('VS Code › Astro_TM', aliases)).toBe('Code-2026 › Astro_TM');
    // An alias of the full name wins, after the folder was renamed too.
    expect(applyAliases('VS Code › Old', aliases)).toBe('New');
    expect(applyAliases('Other › Astro', aliases)).toBe('Other › Astro');
    // Names that are object keys are ordinary names.
    expect(applyAliases('constructor', aliases)).toBe('constructor');
    expect(applyAliases('__proto__', map([['__proto__', 'proto']]))).toBe('proto');
  });

  it('refuses empty, identical, duplicate and circular aliases', () => {
    const list: ProjectAlias[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];
    expect(aliasProblem(list, '', 'X')).toBe('empty');
    expect(aliasProblem(list, 'X', 'X')).toBe('same');
    expect(aliasProblem(list, 'A', 'D')).toBe('duplicate');
    expect(aliasProblem(list, 'C', 'A')).toBe('cycle');
    expect(aliasProblem(list, 'C', 'B')).toBe('cycle');
    expect(aliasProblem(list, 'C', 'D')).toBeNull();
    expect(aliasProblem(list, 'D', 'A')).toBeNull();
    expect(aliasProblem(list, 'x'.repeat(1001), 'y')).toBe('tooLong');
  });

  it('checks a list received from the UI', () => {
    expect(parseProjectAliases([{ from: ' VS Code ', to: 'Code-2026 ' }])).toEqual([
      { from: 'VS Code', to: 'Code-2026' },
    ]);
    expect(() =>
      parseProjectAliases([
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ]),
    ).toThrow(/cycle/);
    expect(() => parseProjectAliases([{ from: 'A', to: '' }])).toThrow(/empty/);
    expect(() => parseProjectAliases('A=B')).toThrow();
    expect(() => parseProjectAliases([{ from: 'A' }])).toThrow();
  });
});

const OLD_FOLDER = 'C:\\Users\\alex\\VS Code';
const NEW_FOLDER = 'C:\\Users\\alex\\Code-2026';

/**
 * A container folder renamed from `VS Code` to `Code-2026`: session A used the old
 * name (a subfolder and the top), session B the new one (the same subfolder).
 */
async function renamedFolderDb(): Promise<UsageDatabase> {
  const root = path.join(tempDir(), 'projects');
  writeLines(path.join(root, 'C--Users-alex-VS-Code', `${SESSION_A}.jsonl`), [
    assistantLine({
      id: 'a1',
      ts: '2026-11-09T10:00:00Z',
      cwd: `${OLD_FOLDER}\\Astro`,
      u: [100, 10, 0, 0],
    }),
    assistantLine({ id: 'a2', ts: '2026-11-09T10:05:00Z', cwd: OLD_FOLDER, u: [20, 2, 0, 0] }),
  ]);
  writeLines(path.join(root, 'C--Users-alex-Code-2026', `${SESSION_B}.jsonl`), [
    assistantLine({
      id: 'b1',
      session: SESSION_B,
      ts: '2026-11-11T09:00:00Z',
      cwd: `${NEW_FOLDER}\\Astro\\src`,
      u: [300, 30, 0, 0],
    }),
  ]);
  const db = database();
  await scanLogs(db, [root]);
  db.setContainerProjects(['VS Code']);
  return db;
}

const names = (db: UsageDatabase) =>
  db.raw.prepare('SELECT DISTINCT project FROM hourly ORDER BY 1').pluck().all() as string[];

describe('aliases on this machine', () => {
  it('merges a renamed container folder, its subfolders included, and keeps its flag', async () => {
    const db = await renamedFolderDb();
    expect(names(db)).toEqual(['Code-2026', 'VS Code', 'VS Code › Astro']);

    db.setProjectAliases([{ from: 'VS Code', to: 'Code-2026' }]);
    // The flag set on "VS Code" now splits "Code-2026" too.
    expect(names(db)).toEqual(['Code-2026', 'Code-2026 › Astro']);
    for (const table of ['sessions', 'session_projects', 'subagents']) {
      const rows = db.raw.prepare(`SELECT DISTINCT project FROM ${table}`).pluck().all();
      expect(rows).not.toContain('VS Code');
      expect(rows).not.toContain('VS Code › Astro');
    }

    const projects = getProjects(db, DAYS);
    expect(projects.rows).toHaveLength(1);
    const folder = projects.rows[0]!;
    expect(folder.name).toBe('Code-2026');
    expect(folder.tokens).toBe(110 + 22 + 330);
    expect(folder.children!.map((child) => [child.name, child.tokens, child.sessions])).toEqual([
      ['Code-2026 › Astro', 110 + 330, 2],
      ['Code-2026', 22, 1],
    ]);
    expect(getProjectDetail(db, PRICING, 'Code-2026', DAYS, true).summary.sessions).toBe(2);
    // Nothing is lost or counted twice.
    expect(getOverview(db, PRICING, DAYS, EVENING).kpis.totalTokens).toBe(tokenTotal(db));

    // The container switches list the folder once, under its new name, flagged.
    const candidates = getContainerCandidates(db);
    expect(candidates.map((item) => [item.name, item.flagged, item.subfolderCount])).toEqual([
      ['Code-2026', true, 1],
    ]);
    expect(candidates[0]!.tokens).toBe(110 + 22 + 330);
  });

  it('keeps the flag when it was set under the new name, and undoes everything when removed', async () => {
    const db = await renamedFolderDb();
    db.setProjectAliases([{ from: 'VS Code', to: 'Code-2026' }]);
    db.setContainerProjects(['Code-2026']);
    expect(names(db)).toEqual(['Code-2026', 'Code-2026 › Astro']);

    // Without the alias, the flag covers the new folder only (used in a subfolder only).
    db.setProjectAliases([]);
    expect(names(db)).toEqual(['Code-2026 › Astro', 'VS Code']);
    db.setContainerProjects(['VS Code']);
    expect(names(db)).toEqual(['Code-2026', 'VS Code', 'VS Code › Astro']);
  });

  it('can rename one subfolder project', async () => {
    const db = await renamedFolderDb();
    db.setProjectAliases([
      { from: 'VS Code', to: 'Code-2026' },
      { from: 'VS Code › Astro', to: 'Astronomy' },
    ]);
    expect(names(db)).toEqual(['Astronomy', 'Code-2026', 'Code-2026 › Astro']);
  });
});

describe('aliases and sync', () => {
  function syncFor(db: UsageDatabase, platform: Platform) {
    const service = new SyncService({
      database: () => db,
      appVersion: '0.1.0',
      platform,
      serial: <T>(task: () => T | Promise<T>) => Promise.resolve().then(task),
      onDataChanged: () => undefined,
      onStatusChanged: () => undefined,
    });
    services.push(service);
    return service;
  }

  async function twoMachines() {
    const myDrive = path.join(tempDir(), 'Mon Drive');
    fs.mkdirSync(myDrive);
    const folder = path.join(myDrive, 'ClaudeTokenTracker');
    const mac = database('MacBook', 'darwin');
    const pc = database('Tower', 'win32');
    await scanLogs(mac, [fixtureRoot('mac')]);
    await scanLogs(pc, [fixtureRoot('win')]);
    const macSync = syncFor(mac, 'darwin');
    const pcSync = syncFor(pc, 'win32');
    for (const service of [macSync, pcSync]) {
      service.setFolder(folder, true);
      await service.setEnabled(true, async () => []);
    }
    return { folder, mac, pc, macSync, pcSync };
  }

  const projectsOf = (db: UsageDatabase, machineId: string) =>
    db.raw
      .prepare('SELECT DISTINCT project FROM hourly WHERE machine_id = ? ORDER BY 1')
      .pluck()
      .all(machineId) as string[];

  it("applies this machine's aliases to the other machines' usage", async () => {
    const { mac, pc, pcSync } = await twoMachines();
    expect(projectsOf(pc, mac.machineId)).toEqual(['demo-app', 'other-tool', 'scratch-pad']);
    const macTokens = tokenTotal(pc, 'hourly', `machine_id = '${mac.machineId}'`);

    pc.setProjectAliases([
      { from: 'other-tool', to: 'tools' },
      { from: 'scratch-pad', to: 'tools' },
    ]);
    pcSync.materializeAll(pc);
    expect(projectsOf(pc, mac.machineId)).toEqual(['demo-app', 'tools']);
    expect(tokenTotal(pc, 'hourly', `machine_id = '${mac.machineId}'`)).toBe(macTokens);
    for (const table of ['sessions', 'session_projects', 'subagents']) {
      const rows = pc.raw
        .prepare(`SELECT DISTINCT project FROM ${table} WHERE machine_id = ?`)
        .pluck()
        .all(mac.machineId);
      expect(rows).not.toContain('other-tool');
    }
    // Sessions that worked in both old names count once in the new one.
    const sessions = pc.raw
      .prepare(`SELECT COUNT(*) FROM session_projects WHERE machine_id = ? AND project = 'tools'`)
      .pluck()
      .get(mac.machineId) as number;
    const before = mac.raw
      .prepare(
        `SELECT COUNT(DISTINCT session_id) FROM session_projects
         WHERE project IN ('other-tool', 'scratch-pad')`,
      )
      .pluck()
      .get() as number;
    expect(sessions).toBe(before);
  });

  it('writes the names as this machine reports them', async () => {
    const { folder, mac, pc, macSync } = await twoMachines();
    mac.setProjectAliases([{ from: 'other-tool', to: 'tools' }]);
    macSync.writeOwnFiles(false);
    const text = fs.readFileSync(path.join(folder, 'machines', mac.machineId, '2026.json'), 'utf8');
    expect(text).toContain('"tools"');
    expect(text).not.toContain('"other-tool"');

    const pcSync = services[1]!;
    await pcSync.readNow();
    expect(projectsOf(pc, mac.machineId)).toContain('tools');
  });
});
