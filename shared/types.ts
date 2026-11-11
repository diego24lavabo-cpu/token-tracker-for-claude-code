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

/**
 * A total compared with the period of the same length just before.
 * - `change`: `ratio` is the change (0.18 = +18%).
 * - `new`: the period before had less than 5% of this one's usage, so a percentage would
 *   only exaggerate (+10,000%).
 * - `none`: neither period has usage.
 */
export type PeriodChange = { kind: 'change'; ratio: number } | { kind: 'new' } | { kind: 'none' };

export interface OverviewKpis {
  totalTokens: number;
  /** Everything sent to Claude: input + cache write + cache read. */
  inputTokens: number;
  outputTokens: number;
  /** How `totalTokens` compares with the period of the same length just before. */
  totalChange: PeriodChange;
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

// ── Projects ──────────────────────────────────────────────────────────────────

/** One project of the period, as a row of the projects table. */
export interface ProjectRow {
  name: string;
  /** All token types. */
  tokens: number;
  /** Part of all the period's tokens. */
  share: number;
  /** Total input: input + cache write + cache read. */
  input: number;
  output: number;
  /** Output / total input. */
  outputInputRatio: number;
  /** Part of the project's tokens used by subagents. */
  subagentShare: number;
  /**
   * Sessions that started in the period and have activity in this project. A session that
   * worked in several projects counts in each, so these do not add up to the session total.
   */
  sessions: number;
  /** This project's tokens per such session, subagents included. Null without sessions. */
  tokensPerSession: number | null;
  activeDays: number;
  /** The model with the most tokens in this project. */
  mainModel: string;
  /** The last local day with usage, whatever the period, `YYYY-MM-DD`. */
  lastUsed: string;
}

export interface ProjectsKpis {
  activeProjects: number;
  /** The project with the most tokens. Null when there is no usage. */
  mainProject: { name: string; share: number } | null;
  /** Average size of the period's sessions, each counted once. Null without sessions. */
  tokensPerSession: number | null;
  /** Output / total input. */
  outputInputRatio: number;
  /** Part of all tokens used by the three largest projects. */
  top3Share: number;
}

export interface Projects {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  kpis: ProjectsKpis;
  /** Largest first. */
  rows: ProjectRow[];
}

/** Tokens of one local day, split between the main sessions and their subagents. */
export interface MainSubagentPoint {
  day: string;
  main: number;
  subagent: number;
}

/** A labeled part of a whole. */
export interface ShareItem {
  name: string;
  tokens: number;
  share: number;
}

export interface ProjectAgentType extends ShareItem {
  kind: Exclude<AgentKind, 'main'>;
  /** Warm-ups are never invocations. */
  invocations: number;
}

export interface ProjectDetail {
  name: string;
  summary: {
    tokens: number;
    /** Sessions with activity in this project, as in `ProjectRow.sessions`. */
    sessions: number;
    /** Output / all tokens. */
    outputShare: number;
    subagentShare: number;
    cost: number | null;
    costIsPartial: boolean;
  };
  /** One point per day of the period, zeros included. */
  daily: MainSubagentPoint[];
  /** Largest first. `share` is the part of the project's tokens. */
  models: ShareItem[];
  /** Largest first. `name` is the machine's name. */
  machines: (ShareItem & { id: string })[];
  /** Largest first. `share` is the part of the project's subagent tokens. */
  agentTypes: ProjectAgentType[];
  /** 24 values: tokens per local hour of the day, 0 to 23. */
  hours: number[];
}

// ── Models ────────────────────────────────────────────────────────────────────

/** One model of the period, as a card of the Models page. */
export interface ModelCard {
  name: string;
  /** All token types. */
  tokens: number;
  /** Part of all the period's tokens. */
  share: number;
  /** The four token types as the logs count them. */
  breakdown: TokenBreakdown;
  /** Total input: input + cache write + cache read. */
  input: number;
  output: number;
  /** Cache read / total input. */
  cacheHitRate: number;
  /** Estimated cost at API prices, in US dollars. Null when the model has no price. */
  cost: number | null;
  /** API responses, deduplicated. */
  messages: number;
  /** Output tokens per response. Null without responses. */
  outputPerMessage: number | null;
  /** Part of the model's tokens used by subagents. */
  subagentShare: number;
  /** The project with the most tokens on this model. */
  topProject: string;
}

/** Tokens of one week, Monday to Sunday. */
export interface WeeklyShare {
  /** The Monday, `YYYY-MM-DD`. */
  week: string;
  /** Tokens of each model of `Models.weeklyModels`, in the same order. */
  tokens: number[];
}

export interface Models {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  /** Largest first. */
  cards: ModelCard[];
  /**
   * The 12 weeks that end with the week of the period's last day, oldest first, whatever
   * the period's length. The other filters apply.
   */
  weekly: WeeklyShare[];
  /** The models used in those weeks, largest first over the 12 weeks. */
  weeklyModels: string[];
}

/** The API exposed to the renderer as `window.api` by the preload script. */
export interface Api {
  /** Available synchronously so the title bar can lay out on first paint. */
  platform: Platform;
  getAppInfo(): Promise<AppInfo>;
  getMachines(): Promise<Machine[]>;
  getOverview(filters: Filters): Promise<Overview>;
  getProjects(filters: Filters): Promise<Projects>;
  getProjectDetail(project: string, filters: Filters): Promise<ProjectDetail>;
  getModels(filters: Filters): Promise<Models>;
  /** Subscribes to "usage data changed" events. Returns an unsubscribe function. */
  onUsageUpdated(callback: () => void): () => void;
}
