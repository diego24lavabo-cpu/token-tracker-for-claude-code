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

// ── Pricing ───────────────────────────────────────────────────────────────────

/** Prices of one model in US dollars per million tokens. */
export interface ModelPrices {
  input: number;
  output: number;
  /** Writing to the default 5-minute cache. */
  cacheWrite: number;
  /** Writing to the 1-hour cache. */
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Pricing {
  /** Day (`YYYY-MM-DD`) the prices were last checked against Anthropic's price list. */
  lastChecked: string | null;
  /** Keyed by model display name, for example `Opus 5.5`. */
  models: Record<string, ModelPrices>;
}

// ── Overview ──────────────────────────────────────────────────────────────────

export interface OverviewKpis {
  totalTokens: number;
  /** Everything sent to Claude: input + cache write + cache read. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Change of `totalTokens` against the period of the same length just before, as a
   * ratio (0.18 = +18%). Null when that period has no usage.
   */
  totalChange: number | null;
  /** Estimated cost at API prices, in US dollars. Null when no model used has a price. */
  cost: number | null;
  /** True when part of the usage has no price and is left out of `cost`. */
  costIsPartial: boolean;
}

/** Usage of one local day. Days without usage are present with zeros. */
export interface DailyPoint {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  /** Total input: input + cache write + cache read. */
  input: number;
  output: number;
  /** Tokens of all types used by subagents that day; part of `input + output`. */
  subagent: number;
}

export interface OverviewShortcuts {
  /** The project with the most tokens. Null when there is no usage. */
  project: { name: string; share: number; tokens: number } | null;
  /** The model with the most tokens. `cacheHitRate` is cache read / total input. */
  model: { name: string; share: number; cacheHitRate: number } | null;
  activity: {
    /** Consecutive days with usage up to today, whatever the selected period. */
    currentStreak: number;
    activeDays: number;
    periodDays: number;
  };
  sessions: { count: number; averageTokens: number };
  /** `share` is the part of all tokens used by subagents. Warm-ups are not invocations. */
  subagents: { share: number; invocations: number };
  /** Share of each machine over the period, largest first. Not limited by the machine filter. */
  machines: { id: string; name: string; share: number }[];
}

export interface Overview {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  kpis: OverviewKpis;
  daily: DailyPoint[];
  shortcuts: OverviewShortcuts;
}

/** The API exposed to the renderer as `window.api` by the preload script. */
export interface Api {
  /** Available synchronously so the title bar can lay out on first paint. */
  platform: Platform;
  getAppInfo(): Promise<AppInfo>;
  getMachines(): Promise<Machine[]>;
  getOverview(filters: Filters): Promise<Overview>;
  /** Subscribes to "usage data changed" events. Returns an unsubscribe function. */
  onUsageUpdated(callback: () => void): () => void;
}
