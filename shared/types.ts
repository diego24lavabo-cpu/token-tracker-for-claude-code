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

// ── Calendar ──────────────────────────────────────────────────────────────────

/** Heat of a heatmap cell: 0 = no usage, then 1 to 4 by quartile of the active days. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** One day of the heatmap. */
export interface HeatmapDay {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  /** All token types. */
  tokens: number;
  /**
   * Sessions with activity that day, subagents included: a session that runs past midnight
   * counts on both days. Local machine only until sync (step 10) brings the others.
   */
  sessions: number;
  level: HeatLevel;
}

/** One column of the heatmap: a week, Monday to Sunday. */
export interface HeatmapWeek {
  /** The Monday, `YYYY-MM-DD`. */
  start: string;
  /** 7 entries, Monday first. Null for the days outside the 12 months (before or after). */
  days: (HeatmapDay | null)[];
}

export interface Heatmap {
  /** First and last day of the 12 months (365 days ending today), both included. */
  from: string;
  to: string;
  /** 53 weeks, oldest first; the last one holds today. */
  weeks: HeatmapWeek[];
  /**
   * The smallest tokens of levels 2, 3 and 4. Level 1 is any day with usage below the
   * first one. Empty when no day has usage.
   */
  thresholds: number[];
}

/** A run of consecutive days with usage. */
export interface Streak {
  days: number;
  /** First and last day, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

export interface CalendarKpis {
  /** Days with usage in the 12 months, out of `totalDays` (365). */
  activeDays: number;
  totalDays: number;
  /** Consecutive days with usage up to today, or up to yesterday while today is empty. */
  currentStreak: Streak | null;
  /** The longest run inside the 12 months; the most recent one on a tie. */
  longestStreak: Streak | null;
  /** The day with the most tokens; the most recent one on a tie. */
  bestDay: { day: string; tokens: number } | null;
  /** Tokens per active day. Null without active days. */
  averagePerActiveDay: number | null;
}

/** Tokens of one calendar month. */
export interface MonthPoint {
  /** `YYYY-MM`. */
  month: string;
  tokens: number;
}

export interface Calendar {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  /** Today's local day, as the main process sees it. */
  today: string;
  heatmap: Heatmap;
  kpis: CalendarKpis;
  /** 7 values over the 12 months: tokens per weekday, Monday first. */
  byWeekday: number[];
  /** Index in `byWeekday` of the weekday with the most tokens. Null without usage. */
  bestWeekday: number | null;
  /** 24 values over the 12 months: tokens per local hour, 0 to 23. */
  byHour: number[];
  /**
   * The 12 calendar months that end with the current one, oldest first. The current month
   * is partial, and the first one starts on its 1st, a little after the heatmap's `from`.
   */
  byMonth: MonthPoint[];
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** The filters of the Sessions page: the usual ones, plus an optional single day. */
export interface SessionFilters extends Filters {
  /**
   * A local day `YYYY-MM-DD`. When set, it replaces `from` … `to`: the page lists the
   * sessions with activity that day, as the Calendar counts them, whatever day they started.
   */
  day?: string;
}

/** The columns the sessions table sorts by. */
export type SessionSortKey =
  | 'start'
  | 'machine'
  | 'project'
  | 'model'
  | 'duration'
  | 'messages'
  | 'subagents'
  | 'input'
  | 'output'
  | 'cost';

export interface SessionSort {
  key: SessionSortKey;
  direction: 'asc' | 'desc';
}

/** One session, as a row of the sessions table. Token columns include its subagents. */
export interface SessionRow {
  id: string;
  machineId: string;
  /** The machine's name. */
  machine: string;
  /** The project with the most tokens in the session. */
  project: string;
  /** The model with the most tokens in the main session. */
  model: string;
  /** UTC milliseconds of the main session's first response. */
  start: number;
  /** Local day and time of `start`: `YYYY-MM-DD` and `HH:MM`. */
  startDay: string;
  startTime: string;
  /** Active time in milliseconds, subagents included (gaps over 30 minutes left out). */
  activeMs: number;
  /** Responses in the main session, deduplicated. */
  messages: number;
  /** Subagent invocations, warm-ups left out. */
  subagents: number;
  /** Total input: input + cache write + cache read. */
  input: number;
  output: number;
  /** All token types. */
  tokens: number;
  /** Estimated cost at API prices. Null when none of its models has a price. */
  cost: number | null;
}

export interface SessionsKpis {
  sessions: number;
  /** Days on which the listed sessions started; 1 with the day filter. */
  activeDays: number;
  /** Null without sessions, as are the other averages and medians. */
  sessionsPerActiveDay: number | null;
  averageActiveMs: number | null;
  medianActiveMs: number | null;
  averageTokens: number | null;
  medianTokens: number | null;
  /** Main-session responses per session. */
  averageMessages: number | null;
  /** The session with the most tokens; the most recent one on a tie. */
  biggest: { id: string; machineId: string; project: string; day: string; tokens: number } | null;
}

export interface Sessions {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  kpis: SessionsKpis;
  /** Sessions per size: <50k, 50–200k, 200–500k, 0.5–1M, ≥1M tokens. */
  sizeHist: number[];
  /** Sessions per active time: <10 min, 10–30, 30–60 min, 1–2 h, ≥2 h. */
  durationHist: number[];
  /** One page of the table, in the requested order. */
  rows: SessionRow[];
  /** Sessions matching the filters, on every page. */
  total: number;
  /** The page returned, from 0: the requested one, or the last one when it was past it. */
  page: number;
  pageSize: number;
  /** Projects and models of the period's sessions, for the filter menus (their filters aside). */
  projects: string[];
  models: string[];
}

/** One subagent invocation of a session, for the drawer's timeline. */
export interface SessionSubagent {
  agentId: string;
  type: string;
  kind: Exclude<AgentKind, 'main'>;
  model: string;
  /** UTC milliseconds of the first and last responses. */
  start: number;
  end: number;
  /** Local day and time of `start`. */
  startDay: string;
  startTime: string;
  activeMs: number;
  /** API calls, deduplicated. */
  calls: number;
  /** Total input of the first call: the context loaded before doing anything. */
  startupInput: number;
  tokens: number;
}

export interface SessionDetail {
  id: string;
  machineId: string;
  machine: string;
  project: string;
  model: string;
  /** UTC milliseconds of the main session's first and last responses. */
  start: number;
  end: number;
  startDay: string;
  startTime: string;
  /** Active time, subagents included. */
  activeMs: number;
  /** First to last response of the main session, pauses included. */
  spanMs: number;
  messages: number;
  /** Invocations, warm-ups left out, as in the table. */
  subagentCount: number;
  /** Tokens of the main session and of all its subagents; together, the session's total. */
  main: TokenBreakdown;
  subagentTokens: TokenBreakdown;
  cost: number | null;
  costIsPartial: boolean;
  /** Every project the session worked in, largest first. */
  projects: ShareItem[];
  /** Every subagent transcript of the session, warm-ups included, oldest first. */
  subagents: SessionSubagent[];
  /** The time the timeline spans: the session and all its subagents, UTC milliseconds. */
  timeline: { from: number; to: number };
}

// ── Agents ────────────────────────────────────────────────────────────────────

export type SubagentKind = Exclude<AgentKind, 'main'>;

export interface AgentsKpis {
  /** Tokens of all subagent transcripts, warm-ups included (they are real API calls). */
  subagentTokens: number;
  /** `subagentTokens` / all tokens: the number of the Overview's Subagents card. */
  subagentShare: number;
  /** Invocations that started in the period: every kind but warm-ups, `/btw` included. */
  invocations: number;
  /** Sessions that started in the period, as on the Sessions page. */
  sessions: number;
  invocationsPerSession: number | null;
  /**
   * Per invocation, over the task and workflow runs only: `/btw` side questions re-log
   * the conversation and warm-ups never ran, so both would skew the averages. Null
   * without such runs, as are the other averages.
   */
  averageTokens: number | null;
  medianTokens: number | null;
  /** Total input of the first call. */
  averageStartup: number | null;
  /** Active time, as everywhere else. */
  averageActiveMs: number | null;
  /** Sessions with at least one invocation, out of `sessions`. */
  sessionsWithSubagents: number;
  sessionsWithSubagentsShare: number | null;
}

/** One agent type and kind, as a row of the "By agent type" table. */
export interface AgentTypeRow {
  type: string;
  kind: SubagentKind;
  /** Transcripts that started in the period. Invocations, except for warm-ups. */
  runs: number;
  /** All token types. */
  tokens: number;
  /** Part of all the subagent tokens of the table. */
  share: number;
  averageTokens: number;
  averageStartup: number;
  averageActiveMs: number;
  averageCalls: number;
  /** Output / all tokens. */
  outputShare: number;
  /** The model with the most tokens in these runs. */
  mainModel: string;
  /** Null when none of its models has a price. */
  cost: number | null;
}

export interface AgentStartup {
  type: string;
  kind: SubagentKind;
  runs: number;
  averageStartup: number;
}

export interface AgentKindRow {
  kind: SubagentKind;
  /** Transcripts; invocations for every kind but warm-ups. */
  runs: number;
  tokens: number;
  /** Part of all subagent tokens. */
  share: number;
}

/** One subagent run, as a row of the "Biggest invocations" table. */
export interface AgentInvocation {
  machineId: string;
  machine: string;
  sessionId: string;
  agentId: string;
  project: string;
  type: string;
  kind: SubagentKind;
  model: string;
  /** UTC milliseconds of the first response, and its local day and time. */
  start: number;
  startDay: string;
  startTime: string;
  activeMs: number;
  calls: number;
  startupInput: number;
  tokens: number;
}

export interface AgentModels {
  /** Every model of either bar, largest first over both: the order of the colors. */
  models: string[];
  /** Largest first. `share` is the part of the main sessions' (or subagents') tokens. */
  main: ShareItem[];
  subagents: ShareItem[];
}

export interface Agents {
  /** False when the database holds no usage at all, for the selected machines. */
  hasData: boolean;
  /** False when no subagent ever ran on the selected machines, whatever the period. */
  hasSubagents: boolean;
  kpis: AgentsKpis;
  /** One point per day of the period, zeros included. */
  daily: MainSubagentPoint[];
  /** Largest first. Rows count on the run's start day. */
  byType: AgentTypeRow[];
  /** Largest first, warm-ups left out. */
  startupByType: AgentStartup[];
  /** The 10 runs with the most tokens, warm-ups left out. */
  top: AgentInvocation[];
  /** Always the four kinds, in the order task, workflow, aside, warm-up. */
  kinds: AgentKindRow[];
  modelsMainVsSub: AgentModels;
}

/** The API exposed to the renderer as `window.api` by the preload script. */
// ── Settings ──────────────────────────────────────────────────────────────────

/** A `projects` folder the app reads Claude Code transcripts from. */
export interface LogFolder {
  /** Absolute path: the folder's identity, for `removeLogFolder`. */
  path: string;
  /** The path shortened with `~`, for display. */
  display: string;
  /** True for a folder found by the app, false for one added in Settings. */
  auto: boolean;
  exists: boolean;
  /** Transcript files read from this folder so far. */
  files: number;
}

/** A folder project whose usage happened partly in subfolders: it may hold several projects. */
export interface ContainerCandidate {
  /** The folder project's name, as stored (before any split). */
  name: string;
  flagged: boolean;
  /** All tokens of the folder project, on this machine. */
  tokens: number;
  /** Part of `tokens` used in subfolders rather than at the top of the folder. */
  subfolderShare: number;
  subfolderCount: number;
  /** The subfolders with the most tokens, largest first (at most 4). */
  topSubfolders: string[];
}

export interface SettingsData {
  /** False in demo mode or when the database could not be opened: nothing can be changed. */
  available: boolean;
  sources: {
    folders: LogFolder[];
    filesScanned: number;
    subagentFiles: number;
    skippedLines: number;
    /** Size of the database files in bytes, or null when unknown. */
    databaseBytes: number | null;
    /** The last finished scan, or null before the first one. */
    lastScan: { at: string; durationMs: number } | null;
  };
  /** How long Claude Code keeps its transcripts, from its own settings file. */
  retention: {
    /** Claude Code's settings file, shortened with `~`. */
    settingsFile: string;
    /** The `cleanupPeriodDays` value, or null when the file does not set it. */
    cleanupPeriodDays: number | null;
    /** What Claude Code uses when the value is not set. */
    defaultDays: number;
    /** The value offered by "Keep Claude Code history longer". */
    suggestedDays: number;
    /** False when the file exists but is not valid JSON: the app then never writes it. */
    readable: boolean;
  };
  containers: ContainerCandidate[];
  pricing: {
    current: Pricing;
    defaults: Pricing;
    /** Models with usage (all machines, all time), most tokens first. */
    usedModels: { name: string; tokens: number }[];
  };
  app: {
    version: string;
    launchAtLogin: boolean;
    /** Null when launch at login is available, otherwise why not. */
    launchAtLoginUnavailable: 'development' | 'platform' | null;
    fileWatching: boolean;
    /** The app's data folder (database, pricing.json), shortened with `~`. */
    dataFolder: string;
  };
}

export interface SettingsPatch {
  launchAtLogin?: boolean;
  fileWatching?: boolean;
  /** Replaces the list of folder projects split by subfolder. */
  containerProjects?: string[];
  pricing?: Pricing;
}

export type CsvKind = 'daily' | 'projects' | 'models' | 'agentTypes';

export type ExportResult =
  { status: 'saved'; file: string; rows: number } | { status: 'cancelled' } | { status: 'failed' };

export type AddFolderResult =
  | { status: 'added'; folder: string }
  | { status: 'exists'; folder: string }
  | { status: 'cancelled' };

export type ActionResult = { status: 'done' } | { status: 'cancelled' } | { status: 'failed' };

export interface Api {
  /** Available synchronously so the title bar can lay out on first paint. */
  platform: Platform;
  getAppInfo(): Promise<AppInfo>;
  getMachines(): Promise<Machine[]>;
  getOverview(filters: Filters): Promise<Overview>;
  getProjects(filters: Filters): Promise<Projects>;
  getProjectDetail(project: string, filters: Filters): Promise<ProjectDetail>;
  getModels(filters: Filters): Promise<Models>;
  /** The last 12 months, whatever the period. Follows the machine filter only. */
  getCalendar(machineIds?: string[]): Promise<Calendar>;
  /** One page of sessions (from 0), with the KPIs and histograms of all of them. */
  getSessions(filters: SessionFilters, page: number, sort: SessionSort): Promise<Sessions>;
  /** Null when the session is not in the database. */
  getSessionDetail(machineId: string, sessionId: string): Promise<SessionDetail | null>;
  getAgents(filters: Filters): Promise<Agents>;
  getSettings(): Promise<SettingsData>;
  /** Applies the given changes, then sends `usageUpdated`. */
  setSettings(patch: SettingsPatch): Promise<SettingsData>;
  /** Asks for a `projects` folder with a folder picker, adds it and scans it. */
  addLogFolder(): Promise<AddFolderResult>;
  /** Stops reading a folder added in Settings. Its history stays in the database. */
  removeLogFolder(folder: string): Promise<void>;
  /** Reads what is new in the logs now. Resolves when the scan is over. */
  scanNow(): Promise<void>;
  /** Asks where to save, then writes a CSV of the given table for these filters. */
  exportCsv(kind: CsvKind, filters: Filters): Promise<ExportResult>;
  /** After a confirmation, reads every transcript still on disk again. History is kept. */
  rebuildDatabase(): Promise<ActionResult>;
  /** After a confirmation, raises `cleanupPeriodDays` in Claude Code's settings file. */
  keepHistoryLonger(): Promise<ActionResult>;
  /** Subscribes to "usage data changed" events. Returns an unsubscribe function. */
  onUsageUpdated(callback: () => void): () => void;
}
