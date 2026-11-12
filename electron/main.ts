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
  ExportResult,
  LogFolder,
  Machine,
  Models,
  Overview,
  Platform,
  Pricing,
  ProjectDetail,
  Projects,
  SessionDetail,
  Sessions,
  SettingsData,
} from '../shared/types';
import {
  emptyAgents,
  emptyCalendar,
  emptyModels,
  emptyOverview,
  emptyProjectDetail,
  emptyProjects,
  emptySessions,
  getAgents,
  getCalendar,
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
  DEFAULT_CLEANUP_DAYS,
  readRetention,
  SUGGESTED_CLEANUP_DAYS,
  writeCleanupDays,
} from './claudeSettings';
import { buildCsvTable, csvFileName, toCsv } from './csv';
import { UsageDatabase } from './db';
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
  getUsedModels,
  parseCsvKind,
  parseFolderPath,
  parseSettingsPatch,
  setExtraLogRoots,
  setFileWatching,
} from './settings';
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
      machineName: os.hostname(),
      platform: currentPlatform(),
    });
  } catch (error) {
    console.error('[db] Could not open the usage database:', error);
  }
}

function notifyUsageUpdated(): void {
  mainWindow?.webContents.send(IPC.usageUpdated);
}

/** Runs a task after every task queued before it. */
function serial<T>(task: () => T | Promise<T>): Promise<T> {
  const run = taskChain.then(task);
  taskChain = run.catch(() => undefined);
  return run;
}

/** The folders found by the app plus those added in Settings, that exist. */
function currentLogRoots(): string[] {
  const roots = existingLogRoots();
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
    try {
      const summary = await scanLogs(db, roots);
      logScan(summary);
      lastScan = { at: new Date().toISOString(), durationMs: summary.durationMs };
      notifyUsageUpdated();
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

function buildSettings(): SettingsData {
  const db = database;
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

  const autoRoots = existingLogRoots();
  const folders = (autoRoots.length > 0 ? autoRoots : [defaultLogRoot()]).map((root) =>
    folder(root, true),
  );
  for (const extra of db ? getExtraLogRoots(db) : []) {
    if (!folders.some((known) => samePath(known.path, extra))) folders.push(folder(extra, false));
  }

  const databaseFile = path.join(dataFolder(), DATABASE_FILE);
  const settingsFile = claudeSettingsFile();
  const retention = readRetention(settingsFile);
  const unavailable = launchAtLoginUnavailable();

  return {
    available: db !== null,
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
      suggestedDays: SUGGESTED_CLEANUP_DAYS,
      readable: retention.readable,
    },
    containers: db ? getContainerCandidates(db) : [],
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

async function applySettings(input: unknown): Promise<SettingsData> {
  const patch = parseSettingsPatch(input);
  const db = requireDatabase();

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
  }
  if (patch.fileWatching !== undefined) {
    setFileWatching(db, patch.fileWatching);
    // Turning it on catches up with what changed while it was off, then starts watching.
    if (patch.fileWatching) await scanUsage();
    else await serial(() => updateWatcher());
  }

  notifyUsageUpdated();
  return buildSettings();
}

/** Shows a native dialog attached to the window when there is one. */
function withWindow<T>(show: (window?: BrowserWindow) => Promise<T>): Promise<T> {
  return mainWindow ? show(mainWindow) : show();
}

async function addLogFolder(): Promise<AddFolderResult> {
  const db = requireDatabase();
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
  const db = requireDatabase();
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
  requireDatabase();
  const t = en.dialogs.rebuild;
  if (!(await confirm(t.message, t.detail, t.confirm, t.cancel))) return { status: 'cancelled' };
  await scanUsage((db) => db.resetFileStates());
  return { status: 'done' };
}

async function keepHistoryLonger(): Promise<ActionResult> {
  const t = en.dialogs.keepLonger;
  const file = claudeSettingsFile();
  const state = readRetention(file);
  if (!state.readable) {
    await showMessage({ type: 'info', message: t.unreadable(tildify(file)) });
    return { status: 'cancelled' };
  }

  const days = SUGGESTED_CLEANUP_DAYS;
  const current = state.cleanupPeriodDays ?? DEFAULT_CLEANUP_DAYS;
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

  handle<SettingsData>(IPC.getSettings, () => buildSettings());
  handle<SettingsData>(IPC.setSettings, (_event, patch) => applySettings(patch));
  handle<AddFolderResult>(IPC.addLogFolder, () => addLogFolder());
  handle<void>(IPC.removeLogFolder, (_event, folder) => removeLogFolder(folder));
  handle<void>(IPC.scanNow, () => scanUsage());
  handle<ExportResult>(IPC.exportCsv, (_event, kind, filters) => exportCsv(kind, filters));
  handle<ActionResult>(IPC.rebuildDatabase, () => rebuildDatabase());
  handle<ActionResult>(IPC.keepHistoryLonger, () => keepHistoryLonger());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // Development runs keep their own data folder, away from the installed app's history.
  if (isDev) app.setPath('userData', path.join(app.getPath('appData'), `${APP_NAME} (dev)`));

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

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    if (!isDev) blockNetwork();
    installAppMenu(isDev);
    registerIpc();
    // Demo mode shows sample data and never touches the real history.
    if (!isDemo) openDatabase();
    createWindow();
    void scanUsage();
  });

  app.on('will-quit', () => {
    quitting = true;
    if (rootsTimer) clearInterval(rootsTimer);
    void watcher.close();
    database?.close();
    database = null;
  });
}
