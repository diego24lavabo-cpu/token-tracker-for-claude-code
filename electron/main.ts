import { app, BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/ipc';
import type {
  AppInfo,
  Machine,
  Models,
  Overview,
  Platform,
  Pricing,
  ProjectDetail,
  Projects,
} from '../shared/types';
import {
  emptyModels,
  emptyOverview,
  emptyProjectDetail,
  emptyProjects,
  getModels,
  getOverview,
  getProjectDetail,
  getProjects,
  parseFilters,
  parseProjectName,
} from './aggregate';
import { UsageDatabase } from './db';
import { installAppMenu } from './menu';
import { defaultLogRoot, existingLogRoots, tildify } from './paths';
import { DEFAULT_PRICING, loadPricing } from './pricing';
import { formatSummary, scanLogs } from './scanner';

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

let mainWindow: BrowserWindow | null = null;
let database: UsageDatabase | null = null;
let scanRunning = false;
let quitting = false;
/** Prices for the cost estimate, replaced by the user's `pricing.json` once it is read. */
let pricing: Pricing = DEFAULT_PRICING;

function currentPlatform(): Platform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

/** Opens the permanent usage history. The app still starts when that fails. */
function openDatabase(): void {
  try {
    const folder = app.getPath('userData');
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

/** Reads what is new in the Claude Code logs, then tells the UI to refresh. */
function scanUsage(): void {
  if (!database || scanRunning) return;
  scanRunning = true;
  scanLogs(database, existingLogRoots())
    .then((summary) => {
      for (const line of formatSummary(summary)) console.log(line);
      mainWindow?.webContents.send(IPC.usageUpdated);
    })
    .catch((error: unknown) => {
      if (!quitting) console.error('[scan] The scan failed:', error);
    })
    .finally(() => {
      scanRunning = false;
    });
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
    logRoots: existingLogRoots().map((root) => tildify(root)),
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

  handle<ProjectDetail>(IPC.getProjectDetail, (_event, projectInput, filtersInput) => {
    const project = parseProjectName(projectInput);
    const filters = parseFilters(filtersInput);
    return database
      ? getProjectDetail(database, pricing, project, filters)
      : emptyProjectDetail(project, filters);
  });

  handle<Models>(IPC.getModels, (_event, input) => {
    const filters = parseFilters(input);
    return database ? getModels(database, pricing, filters) : emptyModels(filters);
  });
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
    scanUsage();
  });

  app.on('will-quit', () => {
    quitting = true;
    database?.close();
    database = null;
  });
}
