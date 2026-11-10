/**
 * Types shared by the Electron main process and the React renderer.
 * Every number the UI shows comes from the main process through the `Api` below.
 */

export type Platform = 'darwin' | 'win32' | 'linux';

export type TokenBreakdown = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

export type AgentKind = 'main' | 'task' | 'workflow' | 'aside' | 'warmup';

export type PeriodKey = '7d' | '30d' | '90d' | '1y';

export interface Filters {
  /** Local days, formatted `YYYY-MM-DD`, both inclusive. */
  from: string;
  to: string;
  /** Default: all machines. */
  machineIds?: string[];
  projects?: string[];
  models?: string[];
  agentTypes?: string[];
  kinds?: AgentKind[];
}

export interface Machine {
  id: string;
  name: string;
  platform: Platform;
  /** True for the computer the app is running on. */
  isLocal: boolean;
  /** UTC ISO timestamp of the last sync, or null when it never synced. */
  lastSync: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: Platform;
  /** True when the app shows generated sample data instead of real logs. */
  demo: boolean;
  /** Claude Code log folders found on this machine, shortened with `~` for display. */
  logRoots: string[];
  /** The folder shown when no log folder exists yet, shortened with `~`. */
  defaultLogRoot: string;
}

/** The API exposed to the renderer as `window.api` by the preload script. */
export interface Api {
  /** Available synchronously so the title bar can lay out on first paint. */
  platform: Platform;
  getAppInfo(): Promise<AppInfo>;
  getMachines(): Promise<Machine[]>;
  /** Subscribes to "usage data changed" events. Returns an unsubscribe function. */
  onUsageUpdated(callback: () => void): () => void;
}
