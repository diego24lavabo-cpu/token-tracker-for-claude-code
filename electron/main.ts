import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import { localDay } from '../shared/period';
import { en } from '../src/i18n/en';
import type {
  ActionResult,
  AddFolderResult,
  Agents,
  AppInfo,
  Calendar,
  ChooseFolderResult,
  ExportResult,
  LogFolder,
  Machine,
  MachinesDetail,
  Models,
  Overview,
  Platform,
  Pricing,
  ProjectDetail,
  Projects,
  SessionDetail,
  Sessions,
  SettingsData,
  SyncStatus,
} from '../shared/types';
import {
  emptyAgents,
  emptyCalendar,
  emptyMachinesDetail,
  emptyModels,
  emptyOverview,
  emptyProjectDetail,
  emptyProjects,
  emptySessions,
  getAgents,
  getCalendar,
  getMachinesDetail,
  getModels,
  getOverview,
  getProjectDetail,
  getProjects,
  getSessionDetail,
  getSessions,
  parseFilters,
  parseMachineIds,
  parsePage,
  parseProjectName,
  parseSessionFilters,
  parseSessionKey,
  parseSessionSort,
} from './aggregate';
import {
  cleanupChoices,
  DEFAULT_CLEANUP_DAYS,
  readRetention,
  writeCleanupDays,
} from './claudeSettings';
import { buildCsvTable, csvFileName, toCsv } from './csv';
import { UsageDatabase } from './db';
import {
  createDemoEnvironment,
  generateDemoWorld,
  removeDemoEnvironment,
  type DemoEnvironment,
} from './demo';
import { syncFolderFromPick } from './drive';
import { installAppMenu } from './menu';
import {
  claudeSettingsFile,
  defaultLogRoot,
  existingLogRoots,
  isDirectory,
  logFolderFromPick,
  samePath,
  tildify,
} from './paths';
import { DEFAULT_PRICING, loadPricing, savePricing } from './pricing';
import { formatSummary, scanLogs, type ScanSummary } from './scanner';
import {
  getContainerCandidates,
  getExtraLogRoots,
  getFileWatching,
  getKnownProjects,
  getUsedModels,
  parseCleanupDays,
  parseCsvKind,
  parseFolderPath,
  parseMachineIdArgument,
  parseSettingsPatch,
  setExtraLogRoots,
  setFileWatching,
} from './settings';
import { SyncService } from './sync';
import { SYNC_FOLDER_NAME } from './syncFormat';
import { LogWatcher, sameFolders } from './watcher';

const APP_ID = 'io.github.diego24lavabo-cpu.tokentracker';
const APP_NAME = 'Token Tracker for Claude Code';
const DATABASE_FILE = 'usage.db';

// Colors mirror src/theme.css: the window paints them before the UI loads.
const COLOR_BG_APP = '#0E0E0D';
const COLOR_BG_SIDEBAR = '#181816';
const COLOR_TEXT = '#F0EEE6';
const TITLE_BAR_HEIGHT = 44;

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);
const isDemo = process.env.TOKEN_TRACKER_DEMO === '1' || process.argv.includes('--demo');
/** The temporary sample data of demo mode, set up before the app is ready. */
let demo: DemoEnvironment | null = null;

const RENDERER_INDEX = path.join(__dirname, '..', 'dist', 'index.html');

/** How often the app looks for log folders that appeared or disappeared, while watching. */
const ROOTS_CHECK_MS = 60_000;

let mainWindow: BrowserWindow | null = null;
let database: UsageDatabase | null = null;
let quitting = false;
/** Prices for the cost estimate, replaced by the user's `pricing.json` once it is read. */
let pricing: Pricing = DEFAULT_PRICING;
/** The last finished scan, for Settings. */
let lastScan: { at: string; durationMs: number } | null = null;
let scansDone = 0;

/**
 * Scans, rebuilds and setting changes that touch the database run one after the other on
 * this chain, never at the same time.
 */
let taskChain: Promise<unknown> = Promise.resolve();
/** True while a scan waits on the chain: it will see any change made before it starts. */
let scanWaiting = false;

const watcher = new LogWatcher(() => void scanUsage(), {
  onError: (error) => console.warn(`[watch] ${errorText(error)}`),
});
let rootsTimer: ReturnType<typeof setInterval> | null = null;

function currentPlatform(): Platform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.message : 'unknown error';
}

function dataFolder(): string {
  return app.getPath('userData');
}

/** Opens the permanent usage history. The app still starts when that fails. */
function openDatabase(): void {
  try {
    const folder = dataFolder();
    fs.mkdirSync(folder, { recursive: true });
    pricing = loadPricing(folder);
    database = new UsageDatabase(path.join(folder, DATABASE_FILE), {
      machineName: demo?.machineName ?? os.hostname(),
      platform: currentPlatform(),
    });
  } catch (error) {
    console.error('[db] Could not open the usage database:', error);
  }
}

function notifyUsageUpdated(): void {
  mainWindow?.webContents.send(IPC.usageUpdated);
}

function notifySyncUpdated(): void {
  mainWindow?.webContents.send(IPC.syncUpdated);
}

/** Runs a task after every task queued before it. */
function serial<T>(task: () => T | Promise<T>): Promise<T> {
  const run = taskChain.then(task);
  taskChain = run.catch(() => undefined);
  return run;
}

const sync = new SyncService({
  database: () => database,
  appVersion: app.getVersion(),
  platform: currentPlatform(),
  serial,
  onDataChanged: notifyUsageUpdated,
  onStatusChanged: notifySyncUpdated,
});

/** The log folders found by the app; in demo mode only the sample data. */
function autoLogRoots(): string[] {
  return demo ? [demo.logRoot] : existingLogRoots();
}

/** Claude Code's settings file; in demo mode a file that does not exist. */
function claudeSettings(): string {
  return demo ? demo.claudeSettingsFile : claudeSettingsFile();
}

/** The folders found by the app plus those added in Settings, that exist. */
function currentLogRoots(): string[] {
  const roots = autoLogRoots();
  if (database) {
    for (const extra of getExtraLogRoots(database)) {
      if (isDirectory(extra) && !roots.some((root) => samePath(root, extra))) roots.push(extra);
    }
  }
  return roots;
}

function logScan(summary: ScanSummary): void {
  // The full summary once; later scans (the watcher runs them often) get one line.
  if (scansDone === 0) {
    for (const line of formatSummary(summary)) console.log(line);
  } else {
    console.log(
      `[scan] ${summary.filesRead} file(s) read, ${summary.imported} new record(s), ` +
        `${summary.durationMs} ms`,
    );
  }
  scansDone++;
}

/**
 * Reads what is new in the Claude Code logs, then tells the UI to refresh. `before` runs
 * first on the chain, for a rebuild. A request made while a scan already waits is merged
 * into that scan.
 */
function scanUsage(before?: (db: UsageDatabase) => void): Promise<void> {
  if (!database) return Promise.resolve();
  if (scanWaiting && !before) return taskChain.then(() => undefined);
  scanWaiting = true;
  return serial(async () => {
    scanWaiting = false;
    const db = database;
    if (!db || quitting) return;
    before?.(db);
    const roots = currentLogRoots();
    const first = scansDone === 0;
    try {
      const summary = await scanLogs(db, roots);
      logScan(summary);
      lastScan = { at: new Date().toISOString(), durationMs: summary.durationMs };
      notifyUsageUpdated();
      if (first) {
        // At startup: write what changed while the app was closed, and read the others.
        sync.start();
        void sync.syncNow();
      } else if (before || summary.imported + summary.upgraded > 0) {
        sync.localDataChanged();
      }
    } catch (error) {
      if (!quitting) console.error('[scan] The scan failed:', error);
    }
    await updateWatcher(roots);
  });
}

/** Watches the log folders when file watching is on, and stops watching otherwise. */
async function updateWatcher(roots: string[] = currentLogRoots()): Promise<void> {
  const on = !quitting && database !== null && getFileWatching(database);
  if (rootsTimer) clearInterval(rootsTimer);
  rootsTimer = null;
  try {
    if (!on) {
      await watcher.close();
      return;
    }
    await watcher.watch(roots);
    // A folder created later (Claude Code used for the first time, a drive plugged in) is
    // picked up by the next check.
    rootsTimer = setInterval(() => {
      if (!sameFolders(currentLogRoots(), watcher.watchedRoots)) void scanUsage();
    }, ROOTS_CHECK_MS);
  } catch (error) {
    console.warn(`[watch] Could not watch the log folders: ${errorText(error)}`);
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function launchAtLoginUnavailable(): SettingsData['app']['launchAtLoginUnavailable'] {
  if (isDev) return 'development';
  return process.platform === 'darwin' || process.platform === 'win32' ? null : 'platform';
}

async function buildSettings(): Promise<SettingsData> {
  const db = database;
  // Looking for Google Drive only matters while sync is on; turning it on looks itself.
  // Demo mode never looks at the real Drive folders (they name the account).
  const candidates = db && sync.enabled && !demo ? await sync.candidates() : [];
  const stats = db?.stats();
  const filesPerRoot = db?.filesPerRoot() ?? new Map<string, number>();
  const filesIn = (folder: string) => {
    let count = 0;
    for (const [root, files] of filesPerRoot) if (samePath(root, folder)) count += files;
    return count;
  };
  const folder = (target: string, auto: boolean): LogFolder => ({
    path: target,
    display: tildify(target),
    auto,
    exists: isDirectory(target),
    files: filesIn(target),
  });

  const autoRoots = autoLogRoots();
  const folders = (autoRoots.length > 0 ? autoRoots : [defaultLogRoot()]).map((root) =>
    folder(root, true),
  );
  for (const extra of db ? getExtraLogRoots(db) : []) {
    if (!folders.some((known) => samePath(known.path, extra))) folders.push(folder(extra, false));
  }

  const databaseFile = path.join(dataFolder(), DATABASE_FILE);
  const settingsFile = claudeSettings();
  const retention = readRetention(settingsFile);
  const unavailable = launchAtLoginUnavailable();

  return {
    available: db !== null && !demo,
    sources: {
      folders,
      filesScanned: stats?.files ?? 0,
      subagentFiles: stats?.subagentFiles ?? 0,
      skippedLines: stats?.skippedLines ?? 0,
      databaseBytes: db ? fileSize(databaseFile) + fileSize(`${databaseFile}-wal`) : null,
      lastScan,
    },
    retention: {
      settingsFile: tildify(settingsFile),
      cleanupPeriodDays: retention.cleanupPeriodDays,
      defaultDays: DEFAULT_CLEANUP_DAYS,
      ...cleanupChoices(retention.cleanupPeriodDays ?? DEFAULT_CLEANUP_DAYS),
      readable: retention.readable,
    },
    containers: db ? getContainerCandidates(db) : [],
    aliases: {
      list: db?.getProjectAliases() ?? [],
      knownProjects: db ? getKnownProjects(db) : [],
    },
    sync: {
      status: sync.status(),
      candidates,
      folderPicked: sync.folderPicked,
      machineName: db?.machineName ?? '',
      machines: sync.machines(),
    },
    pricing: {
      current: pricing,
      defaults: DEFAULT_PRICING,
      usedModels: db ? getUsedModels(db) : [],
    },
    app: {
      version: app.getVersion(),
      launchAtLogin: unavailable === null && app.getLoginItemSettings().openAtLogin,
      launchAtLoginUnavailable: unavailable,
      fileWatching: db ? getFileWatching(db) : false,
      dataFolder: tildify(dataFolder()),
    },
  };
}

function requireDatabase(): UsageDatabase {
  if (!database) throw new Error('The usage database is not available');
  return database;
}

/** Settings and actions that change something are refused in demo mode (the UI disables them). */
function requireWritableDatabase(): UsageDatabase {
  if (demo) throw new Error('Nothing can be changed in demo mode');
  return requireDatabase();
}

async function applySettings(input: unknown): Promise<SettingsData> {
  const patch = parseSettingsPatch(input);
  const db = requireWritableDatabase();

  if (patch.launchAtLogin !== undefined && launchAtLoginUnavailable() === null) {
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
  }
  if (patch.pricing) {
    savePricing(dataFolder(), patch.pricing);
    pricing = patch.pricing;
  }
  if (patch.containerProjects) {
    const projects = patch.containerProjects;
    await serial(() => db.setContainerProjects(projects));
    sync.localDataChanged();
  }
  if (patch.projectAliases) {
    const aliases = patch.projectAliases;
    // Aliases apply to this machine's rows and to the other machines' alike.
    await serial(() => {
      db.setProjectAliases(aliases);
      sync.materializeAll(db);
    });
    sync.localDataChanged();
  }
  if (patch.machineName !== undefined) {
    db.setMachineName(patch.machineName);
    sync.localDataChanged();
  }
  if (patch.fileWatching !== undefined) {
    setFileWatching(db, patch.fileWatching);
    // Turning it on catches up with what changed while it was off, then starts watching.
    if (patch.fileWatching) await scanUsage();
    else await serial(() => updateWatcher());
  }
  if (patch.syncEnabled !== undefined) await sync.setEnabled(patch.syncEnabled);

  notifyUsageUpdated();
  return buildSettings();
}

async function chooseSyncFolder(): Promise<ChooseFolderResult> {
  requireWritableDatabase();
  const options: Electron.OpenDialogOptions = {
    title: en.dialogs.pickSyncFolder.title,
    buttonLabel: en.dialogs.pickSyncFolder.button,
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const picked = await withWindow((window) =>
    window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
  );
  const choice = picked.filePaths[0];
  if (picked.canceled || !choice) return { status: 'cancelled' };

  const folder = syncFolderFromPick(choice, SYNC_FOLDER_NAME);
  sync.setFolder(folder, true);
  if (!sync.enabled) await sync.setEnabled(true);
  else await sync.syncNow();
  notifyUsageUpdated();
  return { status: 'chosen', folder: tildify(folder) };
}

/** Syncs through a "My Drive" folder found by the app; any other path is refused. */
async function useSyncFolder(input: unknown): Promise<SettingsData> {
  const target = parseFolderPath(input);
  requireWritableDatabase();
  const candidate = (await sync.candidates()).find((root) => samePath(root.path, target));
  if (!candidate) throw new Error('This folder is not one of the Google Drive folders found');
  sync.setFolder(path.join(candidate.path, SYNC_FOLDER_NAME), false);
  if (!sync.enabled) await sync.setEnabled(true);
  else await sync.syncNow();
  notifyUsageUpdated();
  return buildSettings();
}

async function removeMachine(input: unknown): Promise<ActionResult> {
  const machineId = parseMachineIdArgument(input);
  const db = requireWritableDatabase();
  const machine = db.listAllMachines().find((item) => item.id === machineId);
  if (!machine || machine.isLocal) return { status: 'cancelled' };

  const t = en.dialogs.removeMachine;
  const answer = await showMessage({
    type: 'question',
    message: t.message(machine.name),
    detail: t.detail,
    buttons: [t.hide, t.hideAndDelete, t.cancel],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (answer.response === 2) return { status: 'cancelled' };
  try {
    await sync.hideMachine(machineId, answer.response === 1);
  } catch (error) {
    console.error(`[sync] Could not remove the machine: ${errorText(error)}`);
    return { status: 'failed' };
  }
  return { status: 'done' };
}

/** Shows a native dialog attached to the window when there is one. */
function withWindow<T>(show: (window?: BrowserWindow) => Promise<T>): Promise<T> {
  return mainWindow ? show(mainWindow) : show();
}

async function addLogFolder(): Promise<AddFolderResult> {
  const db = requireWritableDatabase();
  const options: Electron.OpenDialogOptions = {
    title: en.dialogs.pickFolder.title,
    buttonLabel: en.dialogs.pickFolder.button,
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'showHiddenFiles'],
  };
  const picked = await withWindow((window) =>
    window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
  );
  const choice = picked.filePaths[0];
  if (picked.canceled || !choice) return { status: 'cancelled' };

  const folder = logFolderFromPick(choice);
  if (currentLogRoots().some((root) => samePath(root, folder))) {
    return { status: 'exists', folder: tildify(folder) };
  }
  const extras = getExtraLogRoots(db);
  if (!extras.some((root) => samePath(root, folder))) setExtraLogRoots(db, [...extras, folder]);
  await scanUsage();
  return { status: 'added', folder: tildify(folder) };
}

async function removeLogFolder(input: unknown): Promise<void> {
  const target = parseFolderPath(input);
  const db = requireWritableDatabase();
  setExtraLogRoots(
    db,
    getExtraLogRoots(db).filter((root) => !samePath(root, target)),
  );
  await serial(() => updateWatcher());
  notifyUsageUpdated();
}

async function exportCsv(kindInput: unknown, filtersInput: unknown): Promise<ExportResult> {
  const kind = parseCsvKind(kindInput);
  const filters = parseFilters(filtersInput);
  const db = requireDatabase();

  const options: Electron.SaveDialogOptions = {
    title: en.dialogs.exportCsv.title,
    defaultPath: path.join(app.getPath('downloads'), csvFileName(kind, filters)),
    filters: [{ name: en.dialogs.exportCsv.filter, extensions: ['csv'] }],
  };
  const target = await withWindow((window) =>
    window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options),
  );
  if (target.canceled || !target.filePath) return { status: 'cancelled' };

  try {
    const table = buildCsvTable(kind, db, pricing, filters);
    await fs.promises.writeFile(target.filePath, toCsv(table), 'utf8');
    return { status: 'saved', file: tildify(target.filePath), rows: table.rows.length };
  } catch (error) {
    console.error(`[export] Could not write the CSV: ${errorText(error)}`);
    return { status: 'failed' };
  }
}

function showMessage(options: Electron.MessageBoxOptions) {
  return withWindow((window) =>
    window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
  );
}

/** Asks a yes/no question in a native dialog. The safe answer is the default. */
async function confirm(message: string, detail: string, yes: string, no: string): Promise<boolean> {
  const answer = await showMessage({
    type: 'question',
    message,
    detail,
    buttons: [yes, no],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return answer.response === 0;
}

async function rebuildDatabase(): Promise<ActionResult> {
  requireWritableDatabase();
  const t = en.dialogs.rebuild;
  if (!(await confirm(t.message, t.detail, t.confirm, t.cancel))) return { status: 'cancelled' };
  await scanUsage((db) => db.resetFileStates());
  return { status: 'done' };
}

async function keepHistoryLonger(input: unknown): Promise<ActionResult> {
  const days = parseCleanupDays(input);
  requireWritableDatabase();
  const t = en.dialogs.keepLonger;
  const file = claudeSettings();
  const state = readRetention(file);
  if (!state.readable) {
    await showMessage({ type: 'info', message: t.unreadable(tildify(file), days) });
    return { status: 'cancelled' };
  }

  const current = state.cleanupPeriodDays ?? DEFAULT_CLEANUP_DAYS;
  // Never shorten what the user set.
  if (current >= days) return { status: 'cancelled' };
  const detail = t.detail(current, days, tildify(file));
  if (!(await confirm(t.message(days), detail, t.confirm, t.cancel))) {
    return { status: 'cancelled' };
  }
  try {
    writeCleanupDays(file, days);
  } catch (error) {
    console.error(`[settings] Could not update Claude Code's settings: ${errorText(error)}`);
    return { status: 'failed' };
  }
  notifyUsageUpdated();
  return { status: 'done' };
}

function createWindow(): void {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  const win = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    backgroundColor: COLOR_BG_APP,
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {}),
    ...(isWin
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: COLOR_BG_SIDEBAR,
            symbolColor: COLOR_TEXT,
            height: TITLE_BAR_HEIGHT,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // The UI is a single page: no popups and no navigation away from it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(RENDERER_INDEX);
  }
}

/** True for the app's own page (the dev server in development, the bundled file otherwise). */
function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url);
    if (DEV_SERVER_URL) return target.origin === new URL(DEV_SERVER_URL).origin;
    return (
      target.protocol === 'file:' && target.pathname === pathToFileURL(RENDERER_INDEX).pathname
    );
  } catch {
    return false;
  }
}

/** The app is local only: outside development, every network request is cancelled. */
function blockNetwork(): void {
  const localProtocols = new Set(['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:']);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let protocol = '';
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      // An unparsable URL is cancelled below.
    }
    callback({ cancel: !localProtocols.has(protocol) });
  });
}

/** Registers an IPC handler that only answers the main window's own page. */
function handle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const frame = event.senderFrame;
    if (!mainWindow || event.sender !== mainWindow.webContents || !frame || !isAppUrl(frame.url)) {
      throw new Error(`Rejected IPC call on "${channel}"`);
    }
    return handler(event, ...args);
  });
}

function registerIpc(): void {
  handle<AppInfo>(IPC.getAppInfo, () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: currentPlatform(),
    demo: isDemo,
    logRoots: currentLogRoots().map((root) => tildify(root)),
    defaultLogRoot: tildify(defaultLogRoot()),
  }));

  handle<Machine[]>(IPC.getMachines, () => database?.listMachines() ?? []);

  handle<Overview>(IPC.getOverview, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getOverview(database, pricing, filters) : emptyOverview(filters);
  });

  handle<Projects>(IPC.getProjects, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getProjects(database, filters) : emptyProjects();
  });

  handle<ProjectDetail>(IPC.getProjectDetail, (_event, projectInput, filtersInput, folderInput) => {
    const project = parseProjectName(projectInput);
    const filters = parseFilters(filtersInput);
    const folder = folderInput === true;
    return database
      ? getProjectDetail(database, pricing, project, filters, folder)
      : emptyProjectDetail(project, filters, folder);
  });

  handle<Models>(IPC.getModels, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getModels(database, pricing, filters) : emptyModels(filters);
  });

  handle<Calendar>(IPC.getCalendar, (_event, input) => {
    const machineIds = parseMachineIds(input);
    return database ? getCalendar(database, machineIds) : emptyCalendar(localDay(new Date()));
  });

  handle<Sessions>(IPC.getSessions, (_event, filtersInput, pageInput, sortInput) => {
    const filters = parseSessionFilters(filtersInput);
    const page = parsePage(pageInput);
    const sort = parseSessionSort(sortInput);
    return database ? getSessions(database, pricing, filters, page, sort) : emptySessions();
  });

  handle<SessionDetail | null>(IPC.getSessionDetail, (_event, machineInput, sessionInput) => {
    const { machineId, sessionId } = parseSessionKey(machineInput, sessionInput);
    return database ? getSessionDetail(database, pricing, machineId, sessionId) : null;
  });

  handle<Agents>(IPC.getAgents, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getAgents(database, pricing, filters) : emptyAgents(filters);
  });

  handle<MachinesDetail>(IPC.getMachinesDetail, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getMachinesDetail(database, pricing, filters) : emptyMachinesDetail(filters);
  });

  handle<SyncStatus>(IPC.getSyncStatus, () => sync.status());
  handle<SettingsData>(IPC.getSettings, () => buildSettings());
  handle<SettingsData>(IPC.setSettings, (_event, patch) => applySettings(patch));
  handle<AddFolderResult>(IPC.addLogFolder, () => addLogFolder());
  handle<void>(IPC.removeLogFolder, (_event, folder) => removeLogFolder(folder));
  handle<void>(IPC.scanNow, () => scanUsage());
  handle<ExportResult>(IPC.exportCsv, (_event, kind, filters) => exportCsv(kind, filters));
  handle<ActionResult>(IPC.rebuildDatabase, () => rebuildDatabase());
  handle<ActionResult>(IPC.keepHistoryLonger, (_event, days) => keepHistoryLonger(days));
  handle<ChooseFolderResult>(IPC.chooseSyncFolder, () => chooseSyncFolder());
  handle<SettingsData>(IPC.useSyncFolder, (_event, folder) => useSyncFolder(folder));
  handle<void>(IPC.syncNow, () => sync.syncNow());
  handle<ActionResult>(IPC.removeMachine, (_event, id) => removeMachine(id));
  handle<void>(IPC.restoreMachine, (_event, id) => {
    requireWritableDatabase();
    return sync.restoreMachine(parseMachineIdArgument(id));
  });
}

app.setName(APP_NAME);
// The data folder is chosen before the single-instance lock, which lives in it: a dev run or
// a demo run can then be open next to the installed app.
if (isDemo) {
  // Demo mode shows sample data and never touches the real history.
  demo = createDemoEnvironment(currentPlatform());
  app.setPath('userData', demo.userData);
} else if (isDev) {
  // Development runs keep their own data folder, away from the installed app's history.
  app.setPath('userData', path.join(app.getPath('appData'), `${APP_NAME} (dev)`));
}

if (!app.requestSingleInstanceLock()) {
  if (demo) removeDemoEnvironment(demo);
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    if (!isDev) blockNetwork();
    installAppMenu(isDev);
    registerIpc();
    if (demo) await startDemo(demo);
    else openDatabase();
    createWindow();
    void scanUsage();
  });

  app.on('will-quit', () => {
    quitting = true;
    if (rootsTimer) clearInterval(rootsTimer);
    try {
      sync.flushOnQuit();
    } catch (error) {
      console.warn(`[sync] Could not write on quit: ${errorText(error)}`);
    }
    void watcher.close();
    database?.close();
    database = null;
    if (demo) removeDemoEnvironment(demo);
  });
}

/**
 * Generates the sample data, opens a database for it in the demo folder and syncs with the
 * fake second computer. The first scan then reads the sample logs like real ones.
 */
async function startDemo(env: DemoEnvironment): Promise<void> {
  try {
    const started = performance.now();
    await generateDemoWorld(env, currentPlatform(), app.getVersion());
    console.log(`[demo] Sample data generated in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    console.error('[demo] Could not generate the sample data:', error);
  }
  openDatabase();
  if (!database) return;
  sync.setFolder(env.syncFolder, true);
  await sync.setEnabled(true, async () => []);
}
