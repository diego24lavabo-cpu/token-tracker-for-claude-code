/**
 * Sync between two machines through a fake Google Drive folder.
 *
 * The "Mac" reads the macOS fixture (its own projects, every kind of subagent, and
 * `demo-app`), the "PC" reads the Windows fixture (`demo-app` too, with one subagent).
 * Both write to the same temporary `My Drive/ClaudeTokenTracker` and read each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgents,
  getCalendar,
  getMachinesDetail,
  getModels,
  getOverview,
  getProjectDetail,
  getProjects,
  getSessionDetail,
  getSessions,
} from '../electron/aggregate';
import { UsageDatabase } from '../electron/db';
import { scanLogs } from '../electron/scanner';
import {
  EXPORT_DEBOUNCE_MS,
  EXPORT_MIN_INTERVAL_MS,
  SyncService,
  writeReadme,
} from '../electron/sync';
import {
  buildYearFiles,
  classifySyncFile,
  parseDeletionsFile,
  parseMachineFile,
  parseYearFile,
  README_TEXT,
  README_VERSION,
  readmeVersion,
  serializeYearFile,
  SYNC_SCHEMA_VERSION,
} from '../electron/syncFormat';
import { staleDays } from '../shared/sync';
import type { Filters, Overview, Platform, Pricing, SessionSort } from '../shared/types';
import { cleanupTempDirs, fixtureRoot, tempDir, tokenTotal } from './helpers';

const open: UsageDatabase[] = [];
const services: SyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

const flat = { input: 1, output: 10, cacheWrite: 2, cacheWrite1h: 4, cacheRead: 0.5 };
const PRICING: Pricing = {
  lastChecked: null,
  models: {
    'Opus 5.5': flat,
    'Sonnet 5.5': { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
    'Haiku 5.5': { input: 0.5, output: 2, cacheWrite: 0.6, cacheWrite1h: 1, cacheRead: 0.05 },
    'Fable 5.2': flat,
  },
};
const PERIOD: Filters = { from: '2026-11-08', to: '2026-11-10' };
const EVENING = Date.parse('2026-11-10T20:00:00Z');
const BY_START: SessionSort = { key: 'start', direction: 'desc' };

function database(name: string, platform: Platform): UsageDatabase {
  const db = new UsageDatabase(':memory:', { timeZone: 'UTC', machineName: name, platform });
  open.push(db);
  return db;
}

function syncFor(db: UsageDatabase, platform: Platform, now?: () => number) {
  const events = { data: 0, status: 0 };
  const service = new SyncService({
    database: () => db,
    appVersion: '0.1.0',
    platform,
    serial: <T>(task: () => T | Promise<T>) => Promise.resolve().then(task),
    onDataChanged: () => events.data++,
    onStatusChanged: () => events.status++,
    now,
  });
  services.push(service);
  return { service, events };
}

/** A fake "My Drive" with the app's folder in it. */
function fakeDrive(): { myDrive: string; folder: string } {
  const myDrive = path.join(tempDir(), 'My Drive');
  fs.mkdirSync(myDrive, { recursive: true });
  return { myDrive, folder: path.join(myDrive, 'ClaudeTokenTracker') };
}

const noDrive = async () => [];

/** A Mac and a PC with their own logs, both syncing through the same folder. */
async function twoMachines() {
  const { folder } = fakeDrive();
  const mac = database('MacBook', 'darwin');
  const pc = database('Tower', 'win32');
  await scanLogs(mac, [fixtureRoot('mac')]);
  await scanLogs(pc, [fixtureRoot('win')]);

  const macSync = syncFor(mac, 'darwin');
  const pcSync = syncFor(pc, 'win32');
  macSync.service.setFolder(folder, true);
  pcSync.service.setFolder(folder, true);
  await macSync.service.setEnabled(true, noDrive);
  await pcSync.service.setEnabled(true, noDrive);
  // The Mac wrote first, so it reads the PC only now.
  await macSync.service.readNow();
  return { folder, mac, pc, macSync, pcSync };
}

const macDir = (folder: string, mac: UsageDatabase) => path.join(folder, 'machines', mac.machineId);

/** A machine's own tokens: once synced, its database also holds the other machine's. */
const own = (db: UsageDatabase) => tokenTotal(db, 'hourly', `machine_id = '${db.machineId}'`);

/** The Overview without the Machines shortcut, which ignores the machine filter. */
function overviewOf(
  db: UsageDatabase,
  filters: Filters,
): Omit<Overview, 'shortcuts'> & {
  shortcuts: Omit<Overview['shortcuts'], 'machines'>;
} {
  const overview = getOverview(db, PRICING, filters, EVENING);
  const shortcuts: Partial<Overview['shortcuts']> = { ...overview.shortcuts };
  delete shortcuts.machines;
  return { ...overview, shortcuts: shortcuts as Omit<Overview['shortcuts'], 'machines'> };
}

describe('two machines through a sync folder', () => {
  it('writes each machine in its own folder, atomically, with a README', async () => {
    const { folder, mac, pc } = await twoMachines();
    expect(fs.readdirSync(path.join(folder, 'machines')).sort()).toEqual(
      [mac.machineId, pc.machineId].sort(),
    );
    expect(fs.readdirSync(macDir(folder, mac)).sort()).toEqual(['2026.json', 'machine.json']);
    expect(fs.existsSync(path.join(folder, 'README.txt'))).toBe(true);

    const machine = parseMachineFile(
      fs.readFileSync(path.join(macDir(folder, mac), 'machine.json'), 'utf8'),
      mac.machineId,
    );
    expect(machine.ok && machine.value).toMatchObject({
      schemaVersion: SYNC_SCHEMA_VERSION,
      machineId: mac.machineId,
      name: 'MacBook',
      platform: 'darwin',
      appVersion: '0.1.0',
      years: [2026],
    });
  });

  it('rewrites an outdated README, and never one from a newer app', () => {
    const folder = tempDir();
    const readme = path.join(folder, 'README.txt');
    const read = () => fs.readFileSync(readme, 'utf8');

    writeReadme(folder);
    expect(read()).toBe(README_TEXT.replace(/\n/g, '\r\n'));
    expect(readmeVersion(read())).toBe(README_VERSION);

    // The first README had no marker: it is replaced.
    fs.writeFileSync(readme, 'Token Tracker for Claude Code - sync folder\r\n\r\nOld text.\r\n');
    writeReadme(folder);
    expect(readmeVersion(read())).toBe(README_VERSION);

    // An older marker is replaced too; a newer one is kept as it is.
    fs.writeFileSync(readme, `Old.\r\nREADME version: ${README_VERSION - 1}\r\n`);
    writeReadme(folder);
    expect(read()).toBe(README_TEXT.replace(/\n/g, '\r\n'));
    const newer = `Newer.\r\nREADME version: ${README_VERSION + 1}\r\n`;
    fs.writeFileSync(readme, newer);
    writeReadme(folder);
    expect(read()).toBe(newer);
    expect(fs.readdirSync(folder)).toEqual(['README.txt']);
  });

  it('never writes text, descriptions or paths', async () => {
    const { folder, mac } = await twoMachines();
    const text = fs.readFileSync(path.join(macDir(folder, mac), '2026.json'), 'utf8');
    // The fixture's meta files have descriptions; its records have paths and text.
    expect(text).not.toMatch(/\/Users\/|C:\\\\|Synthetic|description|toolu_|cwd/);
    const descriptions = mac.raw
      .prepare('SELECT description FROM agent_meta WHERE description IS NOT NULL')
      .pluck()
      .all() as string[];
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) expect(text).not.toContain(description);
  });

  it("shows the other machine's numbers exactly as that machine does, on every page", async () => {
    const { mac, pc } = await twoMachines();
    const onlyMac: Filters = { ...PERIOD, machineIds: [mac.machineId] };

    expect(overviewOf(pc, onlyMac)).toEqual(overviewOf(mac, onlyMac));
    expect(getProjects(pc, onlyMac)).toEqual(getProjects(mac, onlyMac));
    for (const project of ['demo-app', 'other-tool']) {
      expect(getProjectDetail(pc, PRICING, project, onlyMac)).toEqual(
        getProjectDetail(mac, PRICING, project, onlyMac),
      );
    }
    expect(getModels(pc, PRICING, onlyMac)).toEqual(getModels(mac, PRICING, onlyMac));
    expect(getCalendar(pc, [mac.machineId], EVENING)).toEqual(
      getCalendar(mac, [mac.machineId], EVENING),
    );
    expect(getAgents(pc, PRICING, onlyMac)).toEqual(getAgents(mac, PRICING, onlyMac));

    for (const key of ['start', 'cost', 'project', 'duration'] as const) {
      const sort: SessionSort = { key, direction: 'desc' };
      expect(getSessions(pc, PRICING, onlyMac, 0, sort)).toEqual(
        getSessions(mac, PRICING, onlyMac, 0, sort),
      );
    }
    for (const day of ['2026-11-09', '2026-11-10']) {
      const ofDay = { ...onlyMac, day };
      expect(getSessions(pc, PRICING, ofDay, 0, BY_START)).toEqual(
        getSessions(mac, PRICING, ofDay, 0, BY_START),
      );
    }
    const sessions = getSessions(mac, PRICING, onlyMac, 0, BY_START).rows;
    expect(sessions.length).toBeGreaterThan(1);
    for (const session of sessions) {
      expect(getSessionDetail(pc, PRICING, mac.machineId, session.id)).toEqual(
        getSessionDetail(mac, PRICING, mac.machineId, session.id),
      );
    }
  });

  it("prices the other machine's sessions and agent types model by model", async () => {
    const { mac, pc } = await twoMachines();
    const onlyMac: Filters = { ...PERIOD, machineIds: [mac.machineId] };
    const sessions = getSessions(pc, PRICING, onlyMac, 0, BY_START);
    const sessionCost = sessions.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    expect(sessionCost).toBeCloseTo(getOverview(pc, PRICING, onlyMac, EVENING).kpis.cost!, 12);

    // The Mac has sessions that used more than one model.
    const mixed = pc.raw
      .prepare(
        `SELECT COUNT(*) FROM (SELECT session_id FROM session_models WHERE machine_id = ?
                               GROUP BY session_id HAVING COUNT(*) > 1)`,
      )
      .pluck()
      .get(mac.machineId) as number;
    expect(mixed).toBeGreaterThan(0);

    const agents = getAgents(pc, PRICING, onlyMac);
    const typeCost = agents.byType.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    const subagentCost = getOverview(
      pc,
      PRICING,
      { ...onlyMac, kinds: ['task', 'workflow', 'aside', 'warmup'] },
      EVENING,
    ).kpis.cost!;
    expect(typeCost).toBeCloseTo(subagentCost, 12);
  });

  it('adds both machines together, and every total agrees', async () => {
    const { mac, pc } = await twoMachines();
    const macTotal = own(mac);
    const pcTotal = own(pc);
    expect(pcTotal).toBeGreaterThan(0);

    const overview = getOverview(pc, PRICING, PERIOD, EVENING);
    expect(overview.kpis.totalTokens).toBe(macTotal + pcTotal);
    const projects = getProjects(pc, PERIOD);
    expect(projects.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(macTotal + pcTotal);
    const models = getModels(pc, PRICING, PERIOD);
    expect(models.cards.reduce((sum, card) => sum + card.tokens, 0)).toBe(macTotal + pcTotal);
    const machines = getMachinesDetail(pc, PRICING, PERIOD);
    expect(machines.cards.map((card) => card.name)).toEqual(['Tower', 'MacBook']);
    expect(machines.cards.reduce((sum, card) => sum + card.tokens, 0)).toBe(macTotal + pcTotal);
    expect(machines.cards.reduce((sum, card) => sum + card.share, 0)).toBeCloseTo(1, 12);
    expect(overview.shortcuts.machines.map((machine) => machine.name).sort()).toEqual([
      'MacBook',
      'Tower',
    ]);

    // Costs add up too: the cards are priced like the Overview.
    const cardCost = machines.cards.reduce((sum, card) => sum + (card.cost ?? 0), 0);
    expect(cardCost).toBeCloseTo(overview.kpis.cost!, 12);
    // Sessions too, each machine counted once.
    const sessions = getSessions(pc, PRICING, PERIOD, 0, BY_START);
    expect(machines.cards.reduce((sum, card) => sum + card.sessions, 0)).toBe(sessions.total);
    expect(overview.shortcuts.sessions.count).toBe(sessions.total);
  });

  it('merges a project with the same name, with a breakdown per machine', async () => {
    const { mac, pc } = await twoMachines();
    const onMac = getProjects(mac, { ...PERIOD, machineIds: [mac.machineId] }).rows.find(
      (row) => row.name === 'demo-app',
    )!;
    const onPc = getProjects(pc, { ...PERIOD, machineIds: [pc.machineId] }).rows.find(
      (row) => row.name === 'demo-app',
    )!;
    const merged = getProjects(pc, PERIOD).rows.filter((row) => row.name === 'demo-app');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tokens).toBe(onMac.tokens + onPc.tokens);
    expect(merged[0]!.sessions).toBe(onMac.sessions + onPc.sessions);

    const detail = getProjectDetail(pc, PRICING, 'demo-app', PERIOD);
    expect(detail.machines.map((machine) => [machine.name, machine.tokens])).toEqual(
      [
        ['MacBook', onMac.tokens],
        ['Tower', onPc.tokens],
      ].sort((a, b) => (b[1] as number) - (a[1] as number)),
    );

    const byMachine = getMachinesDetail(pc, PRICING, PERIOD).projects.find(
      (project) => project.name === 'demo-app',
    )!;
    // Cards: this machine first.
    expect(byMachine.machines).toEqual([onPc.tokens, onMac.tokens]);
    // A project only the Mac has is on the Mac's side only.
    const otherTool = getMachinesDetail(pc, PRICING, PERIOD).projects.find(
      (project) => project.name === 'other-tool',
    )!;
    expect(otherTool.machines[0]).toBe(0);
    expect(otherTool.machines[1]).toBeGreaterThan(0);
  });

  it('counts sessions per day on both machines', async () => {
    const { mac, pc } = await twoMachines();
    const both = getCalendar(pc, undefined, EVENING);
    const macOnly = getCalendar(mac, undefined, EVENING);
    const day = (calendar: typeof both, wanted: string) =>
      calendar.heatmap.weeks.flatMap((week) => week.days).find((item) => item?.day === wanted);
    expect(day(both, '2026-11-08')!.sessions).toBe(1);
    expect(day(both, '2026-11-10')!.sessions).toBe(day(macOnly, '2026-11-10')!.sessions);
    expect(day(both, '2026-11-10')!.sessions).toBeGreaterThan(0);
  });

  it('lists subagent runs of the other machine with its name', async () => {
    const { mac, pc } = await twoMachines();
    const agents = getAgents(pc, PRICING, PERIOD);
    expect(agents.top.some((run) => run.machine === 'MacBook')).toBe(true);
    expect(agents.top.some((run) => run.machine === 'Tower')).toBe(true);
    expect(agents.kinds.find((kind) => kind.kind === 'workflow')!.runs).toBe(
      getAgents(mac, PRICING, PERIOD).kinds.find((kind) => kind.kind === 'workflow')!.runs,
    );
  });

  it('lists the machines with their platform and last sync', async () => {
    const { mac, pc, pcSync } = await twoMachines();
    const machines = pc.listMachines();
    expect(machines.map((machine) => [machine.name, machine.platform, machine.isLocal])).toEqual([
      ['Tower', 'win32', true],
      ['MacBook', 'darwin', false],
    ]);
    expect(machines.every((machine) => machine.lastSync !== null)).toBe(true);
    expect(pcSync.service.status()).toMatchObject({ enabled: true, state: 'synced', machines: 2 });
    expect(pcSync.service.machines().find((machine) => machine.id === mac.machineId)).toMatchObject(
      { problem: null, conflictCopies: 0, hidden: false, appVersion: '0.1.0' },
    );
  });
});

describe('writing', () => {
  it('rewrites only the years whose content changed, and a year file that disappeared', async () => {
    const { folder, mac, macSync } = await twoMachines();
    const file = path.join(macDir(folder, mac), '2026.json');
    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(0), new Date(0));

    expect(macSync.service.writeOwnFiles(false)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(0);

    fs.rmSync(file);
    macSync.service.writeOwnFiles(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(before).toBeGreaterThan(0);
    // No temporary file is left behind.
    expect(fs.readdirSync(macDir(folder, mac)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('puts each year in its own file', () => {
    const files = buildYearFiles(
      {
        hourly: [
          {
            day: '2025-12-31',
            hour: 23,
            project: 'demo-app',
            model: 'Opus 5.5',
            kind: 'main',
            agentType: '',
            input: 1,
            output: 2,
            cacheWrite: 3,
            cacheRead: 4,
            cacheWrite1h: 1,
            messages: 1,
          },
          {
            day: '2026-01-01',
            hour: 0,
            project: 'demo-app',
            model: 'Opus 5.5',
            kind: 'main',
            agentType: '',
            input: 1,
            output: 2,
            cacheWrite: 3,
            cacheRead: 4,
            cacheWrite1h: 0,
            messages: 1,
          },
        ],
        sessions: [],
        subagents: [],
      },
      'machine-0001',
    );
    expect([...files.keys()]).toEqual([2025, 2026]);
    const text = serializeYearFile(files.get(2025)!);
    const parsed = parseYearFile(text, 'machine-0001', 2025);
    expect(parsed.ok && parsed.value.hourly).toEqual([
      ['2025-12-31', 23, 'demo-app', 'Opus 5.5', 'main', '', 1, 2, 3, 4, 1, 1],
    ]);
  });

  it('waits 60 s after a change and at least 5 minutes after the last write', async () => {
    let now = Date.parse('2026-11-10T12:00:00Z');
    const { folder } = fakeDrive();
    const db = database('Tower', 'win32');
    const { service } = syncFor(db, 'win32', () => now);
    service.setFolder(folder, true);
    db.setSetting('sync_enabled', '1');
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_handler: () => void, delay: number) => {
      delays.push(delay);
      return realSetTimeout(() => undefined, 0);
    }) as typeof setTimeout;
    try {
      service.localDataChanged();
      // A second change while one is waiting does not push the write back.
      service.localDataChanged();
      expect(delays).toEqual([EXPORT_DEBOUNCE_MS]);
      service.stop();

      service.writeOwnFiles(false);
      now += 1_000;
      service.localDataChanged();
      expect(delays[1]).toBe(EXPORT_MIN_INTERVAL_MS - 1_000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      service.stop();
    }
  });

  it('is pending, and creates nothing, while the Drive folder is missing', async () => {
    const missing = path.join(tempDir(), 'G-drive-not-mounted', 'My Drive', 'ClaudeTokenTracker');
    const db = database('Tower', 'win32');
    const { service } = syncFor(db, 'win32');
    service.setFolder(missing, true);
    await service.setEnabled(true, noDrive);
    expect(service.status().state).toBe('pending');
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('writes again once Google Drive is back after a failed write', async () => {
    const { myDrive, folder } = fakeDrive();
    const db = database('Tower', 'win32');
    await scanLogs(db, [fixtureRoot('win')]);
    const { service } = syncFor(db, 'win32');
    service.setFolder(folder, true);
    await service.setEnabled(true, noDrive);
    const machineFile = path.join(folder, 'machines', db.machineId, 'machine.json');
    expect(fs.existsSync(machineFile)).toBe(true);

    // Drive is not mounted yet (the app was launched at login): the write fails.
    fs.rmSync(myDrive, { recursive: true });
    expect(service.writeOwnFiles(false)).toBe(false);
    expect(service.status().state).toBe('pending');

    // Drive mounts; the next read finds it and schedules the write, without a local change.
    fs.mkdirSync(myDrive);
    await service.readNow();
    service.flushOnQuit();
    expect(fs.existsSync(machineFile)).toBe(true);
    expect(fs.existsSync(path.join(folder, 'machines', db.machineId, '2026.json'))).toBe(true);
  });

  it('needs a folder when Google Drive is not found, and picks the only one found', async () => {
    const db = database('Tower', 'win32');
    const { service } = syncFor(db, 'win32');
    await service.setEnabled(true, noDrive);
    expect(service.status().state).toBe('needsFolder');

    const { myDrive } = fakeDrive();
    await service.setEnabled(true, async () => [
      { path: myDrive, display: myDrive, account: null },
    ]);
    expect(service.folder).toBe(path.join(myDrive, 'ClaudeTokenTracker'));
    expect(service.status().state).toBe('synced');

    await service.setEnabled(false);
    expect(service.status().state).toBe('off');
  });
});

describe('reading', () => {
  it('keeps the last good copy of a broken or partial file, and retries later', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const before = getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens;
    const file = path.join(macDir(folder, mac), '2026.json');
    const good = fs.readFileSync(file, 'utf8');

    // Drive still downloading: half a file.
    fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.problem).toBe(
      'unreadable',
    );

    // Not JSON at all, then the complete file again.
    fs.writeFileSync(file, 'not json');
    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    fs.writeFileSync(file, good);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.problem).toBeNull();
  });

  it('ignores Drive conflict copies', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const before = getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens;
    const dir = macDir(folder, mac);
    const good = fs.readFileSync(path.join(dir, '2026.json'), 'utf8');
    fs.writeFileSync(path.join(dir, '2026 (1).json'), good);
    fs.writeFileSync(path.join(dir, 'machine (1).json'), '{}');
    fs.writeFileSync(path.join(dir, 'desktop.ini'), '[.ShellClassInfo]');

    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.conflictCopies).toBe(2);
    expect(classifySyncFile('2026.json (1)')).toEqual({ kind: 'conflict' });
    expect(classifySyncFile('2026.json.tmp')).toEqual({ kind: 'ignored' });
    expect(classifySyncFile('2026.json.gz')).toEqual({ kind: 'year', year: 2026, gzip: true });
  });

  it('flags a machine that has not synced for more than 7 days', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const file = path.join(macDir(folder, mac), 'machine.json');
    const machine = JSON.parse(fs.readFileSync(file, 'utf8')) as { lastSync: string };
    const now = Date.parse('2026-11-20T12:00:00Z');
    machine.lastSync = '2026-11-10T12:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(machine));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    await pcSync.service.readNow();

    const stored = pc.listMachines().find((item) => item.id === mac.machineId)!;
    expect(stored.lastSync).toBe('2026-11-10T12:00:00.000Z');
    expect(staleDays(stored.lastSync, now)).toBe(10);
    expect(staleDays(stored.lastSync, Date.parse('2026-11-16T12:00:00Z'))).toBeNull();
    expect(staleDays(null, now)).toBeNull();
    // Its numbers stay.
    expect(
      getOverview(pc, PRICING, { ...PERIOD, machineIds: [mac.machineId] }, now).kpis.totalTokens,
    ).toBe(own(mac));
  });

  it('refuses files of a newer format, and files that belong to another machine', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const before = getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens;
    const file = path.join(macDir(folder, mac), '2026.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    fs.writeFileSync(file, JSON.stringify({ ...good, schemaVersion: SYNC_SCHEMA_VERSION + 1 }));
    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.problem).toBe(
      'newerVersion',
    );

    expect(parseYearFile(JSON.stringify(good), pc.machineId, 2026)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(parseYearFile(JSON.stringify(good), mac.machineId, 2025)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('skips malformed rows and keeps the others', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const file = path.join(macDir(folder, mac), '2026.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8')) as { hourly: unknown[][] };
    const first = good.hourly[0]!;
    const firstTokens = (first.slice(6, 10) as number[]).reduce((sum, value) => sum + value, 0);
    good.hourly[0] = [...first.slice(0, 6), -5, ...first.slice(7)];
    (good.hourly as unknown[]).push(
      ['2025-01-01', 1, 'x', 'y', 'main', '', 1, 1, 1, 1, 0, 1],
      'nonsense',
    );
    fs.writeFileSync(file, JSON.stringify(good));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));

    await pcSync.service.readNow();
    expect(tokenTotal(pc, 'hourly', `machine_id = '${mac.machineId}'`)).toBe(
      own(mac) - firstTokens,
    );
  });

  it('reads gzipped year files, the newer one winning over a plain one', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const dir = macDir(folder, mac);
    const plain = path.join(dir, '2026.json');
    const good = JSON.parse(fs.readFileSync(plain, 'utf8')) as { hourly: unknown[][] };
    // An older plain copy without its hourly rows, and a newer complete gzipped copy.
    fs.writeFileSync(plain, JSON.stringify({ ...good, hourly: [] }));
    fs.utimesSync(plain, new Date(), new Date(Date.now() - 60_000));
    fs.writeFileSync(path.join(dir, '2026.json.gz'), gzipSync(JSON.stringify(good)));
    fs.utimesSync(path.join(dir, '2026.json.gz'), new Date(), new Date(Date.now() + 5_000));

    await pcSync.service.readNow();
    expect(tokenTotal(pc, 'hourly', `machine_id = '${mac.machineId}'`)).toBe(own(mac));
  });

  it('waits for machine.json before showing a machine', async () => {
    const { folder, mac, pc } = await twoMachines();
    const third = database('Laptop', 'linux');
    await scanLogs(third, [fixtureRoot('win')]);
    const thirdSync = syncFor(third, 'linux');
    thirdSync.service.setFolder(folder, true);
    await thirdSync.service.setEnabled(true, noDrive);
    fs.rmSync(path.join(folder, 'machines', third.machineId, 'machine.json'));

    const fresh = database('Fresh', 'win32');
    const freshSync = syncFor(fresh, 'win32');
    freshSync.service.setFolder(folder, true);
    await freshSync.service.setEnabled(true, noDrive);
    expect(
      fresh
        .listMachines()
        .map((machine) => machine.name)
        .sort(),
    ).toEqual(['Fresh', 'MacBook', 'Tower']);
    expect(pc.listMachines()).toHaveLength(2);
    expect(mac.machineId).not.toBe(third.machineId);
  });

  it('says a machine is missing when its folder is gone, and keeps its numbers', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    fs.rmSync(macDir(folder, mac), { recursive: true });
    await pcSync.service.readNow();
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.problem).toBe('missing');
    expect(tokenTotal(pc, 'hourly', `machine_id = '${mac.machineId}'`)).toBe(own(mac));
  });
});

describe('hiding a machine', () => {
  it('hides it everywhere, and shows it again without reading Drive', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const pcOnly = own(pc);
    await pcSync.service.hideMachine(mac.machineId);
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(pcOnly);
    expect(pc.listMachines().map((machine) => machine.name)).toEqual(['Tower']);
    expect(pcSync.service.machines().find((m) => m.id === mac.machineId)!.hidden).toBe(true);
    // Its files are still on Drive, and reading does not bring it back.
    expect(fs.existsSync(macDir(folder, mac))).toBe(true);
    await pcSync.service.readNow();
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(pcOnly);

    fs.rmSync(folder, { recursive: true });
    await pcSync.service.restoreMachine(mac.machineId);
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(pcOnly + own(mac));
  });

  it('never hides this machine, and leaves Drive alone', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    await pcSync.service.hideMachine(pc.machineId);
    expect(pc.listMachines()).toHaveLength(2);
    await pcSync.service.hideMachine(mac.machineId);
    expect(fs.existsSync(macDir(folder, mac))).toBe(true);
  });
});

/** Rows of a machine left in the derived tables, the stored sync files and the machine list. */
function rowsOf(db: UsageDatabase, machineId: string): number {
  const tables = [
    'hourly',
    'sessions',
    'session_projects',
    'session_days',
    'session_models',
    'subagents',
    'subagent_models',
    'remote_files',
  ];
  let total = 0;
  for (const table of tables) {
    total += db.raw
      .prepare(`SELECT COUNT(*) FROM ${table} WHERE machine_id = ?`)
      .pluck()
      .get(machineId) as number;
  }
  return total + (db.hasMachine(machineId) ? 1 : 0);
}

/** The Mac writes its files again later, as a computer still running the app would. */
async function macSyncsAgain(
  folder: string,
  mac: UsageDatabase,
  macSync: { service: SyncService },
) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await macSync.service.syncNow();
  // Some file systems keep mtimes coarse: make sure the change is seen.
  const file = path.join(macDir(folder, mac), 'machine.json');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
}

/** A third computer, reading the same folder. */
async function laptopOn(folder: string) {
  const laptop = database('Laptop', 'linux');
  const laptopSync = syncFor(laptop, 'linux');
  laptopSync.service.setFolder(folder, true);
  await laptopSync.service.setEnabled(true, noDrive);
  return { laptop, laptopSync };
}

describe('deleting a machine', () => {
  it('deletes it from this computer only, and its old files do not bring it back', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    const pcOnly = own(pc);
    const lastSync = pc.listAllMachines().find((m) => m.id === mac.machineId)!.lastSync;
    expect(rowsOf(pc, mac.machineId)).toBeGreaterThan(1);

    expect(pcSync.service.hasDriveFolder(mac.machineId)).toBe(true);
    expect(await pcSync.service.deleteMachine(mac.machineId, false)).toBe(true);
    expect(rowsOf(pc, mac.machineId)).toBe(0);
    expect(pcSync.service.machines().map((m) => m.name)).toEqual(['Tower']);
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(pcOnly);
    expect(pc.deletedMachine(mac.machineId)).toMatchObject({ lastSync, everywhere: false });

    // Drive is untouched, nothing tells the others, and reading again changes nothing.
    expect(fs.existsSync(macDir(folder, mac))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'machines', pc.machineId, 'deleted.json'))).toBe(false);
    await pcSync.service.readNow();
    await pcSync.service.readNow();
    expect(rowsOf(pc, mac.machineId)).toBe(0);
    expect(mac.listMachines()).toHaveLength(2);
  });

  it('brings it back with all its usage once it syncs again', async () => {
    const { folder, mac, pc, pcSync, macSync } = await twoMachines();
    const before = getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens;
    await pcSync.service.deleteMachine(mac.machineId, false);
    await pcSync.service.readNow();

    await macSyncsAgain(folder, mac, macSync);
    await pcSync.service.readNow();
    expect(pc.listMachines().map((m) => m.name)).toEqual(['Tower', 'MacBook']);
    expect(getOverview(pc, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(before);
    expect(pc.deletedMachine(mac.machineId)).toBeNull();
  });

  it('deletes its Drive folder, so it disappears on every computer, until it syncs again', async () => {
    const { folder, mac, pc, pcSync, macSync } = await twoMachines();
    const { laptop, laptopSync } = await laptopOn(folder);
    expect(laptop.listMachines()).toHaveLength(3);
    const laptopBefore = getOverview(laptop, PRICING, PERIOD, EVENING).kpis.totalTokens;

    expect(await pcSync.service.deleteMachine(mac.machineId, true)).toBe(true);
    expect(fs.existsSync(macDir(folder, mac))).toBe(false);
    expect(pcSync.service.hasDriveFolder(mac.machineId)).toBe(false);
    const list = JSON.parse(
      fs.readFileSync(path.join(folder, 'machines', pc.machineId, 'deleted.json'), 'utf8'),
    ) as { machineId: string; deleted: { id: string }[] };
    expect(list.machineId).toBe(pc.machineId);
    expect(list.deleted.map((entry) => entry.id)).toEqual([mac.machineId]);

    // The laptop deletes it too, instead of keeping it as "missing".
    await laptopSync.service.readNow();
    expect(laptop.listMachines().map((m) => m.name)).toEqual(['Laptop', 'Tower']);
    expect(rowsOf(laptop, mac.machineId)).toBe(0);
    expect(getOverview(laptop, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(
      laptopBefore - own(mac),
    );
    expect(laptop.deletedMachine(mac.machineId)).toMatchObject({ everywhere: false });

    // The Mac never deletes itself.
    await macSync.service.readNow();
    expect(mac.listMachines().map((m) => m.name)).toEqual(['MacBook', 'Laptop', 'Tower']);

    // Still running the app, the Mac writes its files again: it is back everywhere.
    await macSyncsAgain(folder, mac, macSync);
    await pcSync.service.readNow();
    await laptopSync.service.readNow();
    expect(pc.listMachines()).toHaveLength(3);
    expect(getOverview(laptop, PRICING, PERIOD, EVENING).kpis.totalTokens).toBe(laptopBefore);
    // The PC's next write drops it from its list, which no longer applies anyway.
    pcSync.service.writeOwnFiles(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(folder, 'machines', pc.machineId, 'deleted.json'), 'utf8'),
      ),
    ).toMatchObject({ deleted: [] });
  });

  it('keeps a computer that joins later from showing a machine deleted elsewhere', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    await pcSync.service.deleteMachine(mac.machineId, false);
    // Its folder is still on Drive (another computer has not caught up), and a deletion list says no.
    pc.deleteMachine(mac.machineId, {
      lastSync: mac.listAllMachines()[0]!.lastSync,
      at: new Date().toISOString(),
      everywhere: true,
    });
    pcSync.service.writeOwnFiles(true);
    expect(fs.existsSync(macDir(folder, mac))).toBe(true);

    const { laptop } = await laptopOn(folder);
    expect(laptop.listMachines().map((m) => m.name)).toEqual(['Laptop', 'Tower']);
    expect(rowsOf(laptop, mac.machineId)).toBe(0);
  });

  it('never deletes this machine, even when another computer lists it', async () => {
    const { folder, pc, pcSync, macSync } = await twoMachines();
    expect(pcSync.service.hasDriveFolder(pc.machineId)).toBe(false);
    await pcSync.service.deleteMachine(pc.machineId, true);
    expect(pc.listMachines()).toHaveLength(2);
    expect(fs.existsSync(path.join(folder, 'machines', pc.machineId))).toBe(true);
    pc.deleteMachine(pc.machineId, {
      lastSync: null,
      at: new Date().toISOString(),
      everywhere: true,
    });
    expect(pc.deletedMachines()).toEqual([]);

    // The Mac lists the PC in its own deletions: the PC keeps itself.
    await macSync.service.deleteMachine(pc.machineId, true);
    await pcSync.service.readNow();
    expect(pc.listMachines().map((m) => m.name)).toEqual(['Tower', 'MacBook']);
    expect(own(pc)).toBeGreaterThan(0);
  });

  it('deletes a hidden machine too', async () => {
    const { mac, pc, pcSync } = await twoMachines();
    await pcSync.service.hideMachine(mac.machineId);
    await pcSync.service.deleteMachine(mac.machineId, false);
    expect(rowsOf(pc, mac.machineId)).toBe(0);
    await pcSync.service.readNow();
    expect(pc.listAllMachines()).toHaveLength(1);
  });

  it('leaves Drive alone while sync is off, and says the Drive part failed', async () => {
    const { folder, mac, pc, pcSync } = await twoMachines();
    await pcSync.service.setEnabled(false);
    expect(pcSync.service.hasDriveFolder(mac.machineId)).toBe(false);
    expect(await pcSync.service.deleteMachine(mac.machineId, true)).toBe(false);
    expect(rowsOf(pc, mac.machineId)).toBe(0);
    expect(fs.existsSync(macDir(folder, mac))).toBe(true);
  });
});

describe('deleted.json', () => {
  it('is checked entry by entry, and its conflict copies are ignored', () => {
    const id = 'f4627a72-0000-4000-8000-000000000001';
    const good = {
      id: 'c33d0000-0000-4000-8000-000000000002',
      lastSync: '2026-11-01T10:00:00Z',
      at: '2026-11-14T09:00:00Z',
    };
    const parsed = parseDeletionsFile(
      JSON.stringify({
        schemaVersion: 1,
        machineId: id,
        deleted: [
          good,
          { id: '../x', lastSync: null, at: good.at },
          'nonsense',
          { ...good, lastSync: null },
        ],
      }),
      id,
    );
    expect(parsed).toEqual({
      ok: true,
      skippedRows: 2,
      value: {
        schemaVersion: 1,
        machineId: id,
        deleted: [
          { id: good.id, lastSync: '2026-11-01T10:00:00.000Z', at: '2026-11-14T09:00:00.000Z' },
          { id: good.id, lastSync: null, at: '2026-11-14T09:00:00.000Z' },
        ],
      },
    });
    expect(parseDeletionsFile('{"schemaVersion":1', id)).toEqual({ ok: false, reason: 'json' });
    expect(
      parseDeletionsFile(JSON.stringify({ schemaVersion: 1, machineId: good.id, deleted: [] }), id),
    ).toEqual({ ok: false, reason: 'mismatch' });
    expect(classifySyncFile('deleted.json')).toEqual({ kind: 'deletions' });
    expect(classifySyncFile('deleted (1).json')).toEqual({ kind: 'conflict' });
    expect(classifySyncFile('deleted.json.tmp')).toEqual({ kind: 'ignored' });
  });

  it('a broken list deletes nothing', async () => {
    const { folder, mac, pc, macSync } = await twoMachines();
    const { laptop, laptopSync } = await laptopOn(folder);
    fs.writeFileSync(path.join(folder, 'machines', pc.machineId, 'deleted.json'), '{"schema');
    await laptopSync.service.readNow();
    await macSync.service.readNow();
    expect(laptop.listMachines()).toHaveLength(3);
    expect(mac.listMachines()).toHaveLength(3);
  });
});
