// Demo mode (`npm run dev:demo`, `TOKEN_TRACKER_DEMO=1` or `--demo`): the app shows
// generated sample data and never reads or writes the real history, logs, Claude Code
// settings or Google Drive. Everything lives in one temporary folder, emptied on quit:
//
//   token-tracker-demo-XXXX/
//   ├─ user-data/                    the app's data folder (database, pricing.json, Chromium)
//   ├─ logs/<this machine>/projects  this machine's fake Claude Code logs
//   ├─ logs/<other machine>/projects a second computer's fake logs
//   └─ My Drive/ClaudeTokenTracker   the sync folder both machines write to
//
// The second computer is scanned into its own in-memory database and writes its sync files
// like a real one, so the Machines page, the machine selector and the title bar show sync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateDemoData } from '../scripts/demo-data.mjs';
import type { Platform } from '../shared/types';
import { UsageDatabase } from './db';
import { scanLogs } from './scanner';
import { SyncService } from './sync';
import { SYNC_FOLDER_NAME } from './syncFormat';

const FOLDER_PREFIX = 'token-tracker-demo-';
const MARKER = '.token-tracker-demo';
/** Demo folders left behind by a crash are deleted once they are this old. */
const STALE_MS = 24 * 3600_000;
/** An emptied folder is left alone this long: a demo starting right now has no logs yet. */
const EMPTIED_GRACE_MS = 60_000;

interface FakeMachine {
  name: string;
  platform: Platform;
  paths: 'windows' | 'posix';
}

export interface DemoEnvironment {
  root: string;
  userData: string;
  /** This machine's fake `projects` folder. */
  logRoot: string;
  /** The `ClaudeTokenTracker` folder in the fake "My Drive". */
  syncFolder: string;
  /** Where Claude Code's settings would be: a file that never exists. */
  claudeSettingsFile: string;
  machineName: string;
}

function machinesFor(platform: Platform): { local: FakeMachine; other: FakeMachine } {
  const mac: FakeMachine = { name: 'MacBook Pro', platform: 'darwin', paths: 'posix' };
  const pc: FakeMachine = { name: 'Desktop PC', platform: 'win32', paths: 'windows' };
  if (platform === 'darwin') return { local: mac, other: pc };
  if (platform === 'win32') return { local: pc, other: mac };
  return { local: { name: 'Laptop', platform, paths: 'posix' }, other: pc };
}

/** Deletes the demo folders of earlier runs that did not quit cleanly. */
function removeStaleFolders(parent: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(FOLDER_PREFIX)) continue;
    const folder = path.join(parent, name);
    try {
      const age = now - fs.statSync(path.join(folder, MARKER)).mtimeMs;
      // Without its logs, the run quit and emptied it; with them it crashed, or still runs.
      const emptied = !fs.existsSync(path.join(folder, 'logs'));
      if (age > STALE_MS || (emptied && age > EMPTIED_GRACE_MS)) {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    } catch {
      // Not a demo folder, or already gone.
    }
  }
}

/**
 * Creates the temporary folder. Called before the app is ready, so the data folder can be
 * moved into it before Chromium starts.
 */
export function createDemoEnvironment(
  platform: Platform,
  parent = os.tmpdir(),
  now = Date.now(),
): DemoEnvironment {
  removeStaleFolders(parent, now);
  const root = fs.mkdtempSync(path.join(parent, FOLDER_PREFIX));
  fs.writeFileSync(path.join(root, MARKER), 'Token Tracker for Claude Code demo data\n');
  const { local } = machinesFor(platform);
  return {
    root,
    userData: path.join(root, 'user-data'),
    logRoot: path.join(root, 'logs', 'this-machine', 'projects'),
    syncFolder: path.join(root, 'My Drive', SYNC_FOLDER_NAME),
    claudeSettingsFile: path.join(root, 'claude', 'settings.json'),
    machineName: local.name,
  };
}

/**
 * Writes the sample logs of this machine (a year) and of a second computer (four months,
 * partly the same projects), then the second computer's sync files.
 */
export async function generateDemoWorld(
  env: DemoEnvironment,
  platform: Platform,
  appVersion: string,
): Promise<void> {
  const { local, other } = machinesFor(platform);
  generateDemoData(env.logRoot, { days: 365, seed: 42, paths: local.paths });

  const otherRoot = path.join(env.root, 'logs', 'other-machine', 'projects');
  generateDemoData(otherRoot, {
    days: 120,
    seed: 7,
    paths: other.paths,
    projects: ['demo-app', 'web-shop', 'infra-scripts'],
    sessionsPerDay: [1, 2],
    dayOffRate: 0.35,
  });
  fs.mkdirSync(path.dirname(env.syncFolder), { recursive: true });

  const db = new UsageDatabase(':memory:', { machineName: other.name, platform: other.platform });
  const sync = new SyncService({
    database: () => db,
    appVersion,
    platform: other.platform,
    serial: <T>(task: () => T | Promise<T>) => Promise.resolve().then(task),
    onDataChanged: () => undefined,
    onStatusChanged: () => undefined,
  });
  try {
    await scanLogs(db, [otherRoot]);
    sync.setFolder(env.syncFolder, true);
    await sync.setEnabled(true, async () => []);
  } finally {
    sync.stop();
    db.close();
  }
}

/**
 * Deletes the sample data. The marker stays: Chromium writes a few files into its data
 * folder until the very end of the process, after any code of the app can run, so the
 * folder itself is deleted by a later demo run (see `removeStaleFolders`).
 */
export function removeDemoEnvironment(env: DemoEnvironment): void {
  let names: string[];
  try {
    names = fs.readdirSync(env.root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === MARKER) continue;
    try {
      fs.rmSync(path.join(env.root, name), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file still open (Windows): the next demo run deletes it.
    }
  }
}
