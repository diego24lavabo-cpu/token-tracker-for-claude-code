/**
 * The app's own permanent usage history (SQLite).
 *
 * Claude Code deletes old transcripts, so every usage record is copied here and never
 * removed, even when its source file disappears.
 *
 * - `messages` is the source of truth: one row per deduplicated assistant response of
 *   this machine, with its UTC timestamp.
 * - `hourly`, `sessions`, `session_projects` and `subagents` are derived from `messages`
 *   and can be rebuilt at any time. They carry a machine id because they will also hold
 *   the aggregates synced from other machines.
 * - `agent_meta` keeps what only the subagent meta files know (agent type, description).
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  aliasMap,
  applyAliases,
  containerTargets,
  resolveAlias,
  subfolderProject,
  type AliasMap,
  type ProjectAlias,
} from '../shared/projects';
import type {
  AgentKind,
  Machine,
  Platform,
  SubagentKind,
  SyncMachine,
  TokenBreakdown,
} from '../shared/types';
import { UNKNOWN_AGENT_TYPE, type AgentMeta, type BaseKind } from './subagents';
import { createLocalClock, systemTimeZone, type LocalClock } from './timezone';

type Sqlite = Database.Database;

/** Schema steps, applied in order. A step that has shipped is never edited. */
export const MIGRATIONS: ReadonlyArray<(db: Sqlite) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE machines (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        platform  TEXT NOT NULL,
        is_local  INTEGER NOT NULL DEFAULT 0,
        last_sync TEXT
      ) WITHOUT ROWID;

      -- One row per transcript file ever read, with how far it was read.
      CREATE TABLE files (
        path           TEXT PRIMARY KEY,
        root           TEXT NOT NULL,
        project_folder TEXT NOT NULL,
        is_subagent    INTEGER NOT NULL,
        agent_id       TEXT,
        size           INTEGER NOT NULL,
        mtime_ms       REAL NOT NULL,
        read_offset    INTEGER NOT NULL,
        head_length    INTEGER NOT NULL,
        head_hash      TEXT NOT NULL,
        meta_read      INTEGER NOT NULL DEFAULT 0,
        project        TEXT,
        lines          INTEGER NOT NULL DEFAULT 0,
        usage_records  INTEGER NOT NULL DEFAULT 0,
        skipped        INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;

      -- One row per deduplicated assistant response. 'kind' is what the transcript's
      -- location says (warm-ups are derived later); 'agent_id' is NULL for the main session.
      -- 'local_day' and 'local_hour' are derived from 'ts' in the zone stored in settings.
      CREATE TABLE messages (
        id          INTEGER PRIMARY KEY,
        dedup_key   TEXT NOT NULL UNIQUE,
        ts          INTEGER NOT NULL,
        local_day   TEXT NOT NULL,
        local_hour  INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        project     TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        model       TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('main', 'task', 'workflow', 'aside')),
        agent_id    TEXT,
        is_subagent INTEGER GENERATED ALWAYS AS (agent_id IS NOT NULL) VIRTUAL,
        input       INTEGER NOT NULL,
        output      INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        cache_read  INTEGER NOT NULL,
        stop_reason TEXT,
        rank        INTEGER NOT NULL
      );
      CREATE INDEX messages_bucket  ON messages (local_day, local_hour);
      CREATE INDEX messages_session ON messages (session_id, ts);
      CREATE INDEX messages_agent   ON messages (session_id, agent_id) WHERE agent_id IS NOT NULL;

      -- The description can contain task text: it stays in this table, on this machine.
      CREATE TABLE agent_meta (
        session_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        agent_type  TEXT NOT NULL,
        from_meta   INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        tool_use_id TEXT,
        PRIMARY KEY (session_id, agent_id)
      ) WITHOUT ROWID;

      CREATE TABLE hourly (
        machine_id  TEXT NOT NULL,
        local_day   TEXT NOT NULL,
        local_hour  INTEGER NOT NULL,
        project     TEXT NOT NULL,
        model       TEXT NOT NULL,
        kind        TEXT NOT NULL,
        agent_type  TEXT NOT NULL,
        input       INTEGER NOT NULL,
        output      INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        cache_read  INTEGER NOT NULL,
        messages    INTEGER NOT NULL,
        PRIMARY KEY (machine_id, local_day, local_hour, project, model, kind, agent_type)
      ) WITHOUT ROWID;
      CREATE INDEX hourly_day ON hourly (local_day);

      -- Token columns include the session's subagents; start and end are the main session's.
      CREATE TABLE sessions (
        machine_id      TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        project         TEXT NOT NULL,
        model           TEXT NOT NULL,
        start_ts        INTEGER NOT NULL,
        end_ts          INTEGER NOT NULL,
        start_day       TEXT NOT NULL,
        messages        INTEGER NOT NULL,
        input           INTEGER NOT NULL,
        output          INTEGER NOT NULL,
        cache_write     INTEGER NOT NULL,
        cache_read      INTEGER NOT NULL,
        subagent_count  INTEGER NOT NULL,
        subagent_tokens INTEGER NOT NULL,
        PRIMARY KEY (machine_id, session_id)
      ) WITHOUT ROWID;
      CREATE INDEX sessions_start ON sessions (start_day);

      -- One row per subagent invocation.
      CREATE TABLE subagents (
        machine_id    TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        agent_id      TEXT NOT NULL,
        project       TEXT NOT NULL,
        agent_type    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        model         TEXT NOT NULL,
        start_ts      INTEGER NOT NULL,
        end_ts        INTEGER NOT NULL,
        start_day     TEXT NOT NULL,
        calls         INTEGER NOT NULL,
        startup_input INTEGER NOT NULL,
        input         INTEGER NOT NULL,
        output        INTEGER NOT NULL,
        cache_write   INTEGER NOT NULL,
        cache_read    INTEGER NOT NULL,
        PRIMARY KEY (machine_id, session_id, agent_id)
      ) WITHOUT ROWID;
      CREATE INDEX subagents_start ON subagents (start_day);
    `);
  },
  // Adds the active time of sessions and subagent runs, and the part of the cache writes
  // that went to the 1-hour cache ('cache_write_1h' is included in 'cache_write').
  // The derived tables are rebuilt to fill the first. For the second, the file list is
  // emptied so that every transcript still on disk is read again; nothing else is lost,
  // and usage whose transcript is gone keeps a 1-hour share of zero.
  (db) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE subagents ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE hourly ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE subagents ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
      DELETE FROM files;
      INSERT INTO settings (key, value) VALUES ('derived_dirty', '1')
        ON CONFLICT (key) DO UPDATE SET value = '1';
    `);
  },
  // Adds the directory under the project a response was made in ('subfolder', empty at
  // the top of the project). Transcripts are deleted by Claude Code after a while, so
  // this is kept from now on: it lets the way projects are named change later without
  // losing history. The file list is emptied to read the transcripts still on disk again.
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN subfolder TEXT NOT NULL DEFAULT '';
      DELETE FROM files;
    `);
  },
  // Adds the projects each session worked in. 'sessions' keeps one project per session
  // (the one with the most tokens) so that global counts see each session once; this table
  // lets a project count every session that has activity in it.
  (db) => {
    db.exec(`
      CREATE TABLE session_projects (
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project    TEXT NOT NULL,
        -- The session's start day, as in 'sessions'.
        start_day  TEXT NOT NULL,
        -- Tokens of the session in this project, subagents included.
        tokens     INTEGER NOT NULL,
        PRIMARY KEY (machine_id, session_id, project)
      ) WITHOUT ROWID;
      CREATE INDEX session_projects_start ON session_projects (start_day);
      INSERT INTO settings (key, value) VALUES ('derived_dirty', '1')
        ON CONFLICT (key) DO UPDATE SET value = '1';
    `);
  },
  // Subfolders of container folders are now named '<folder> › <subfolder>' instead of
  // '<subfolder>': the derived tables are rebuilt with the new names.
  (db) => {
    db.exec(`
      INSERT INTO settings (key, value) VALUES ('derived_dirty', '1')
        ON CONFLICT (key) DO UPDATE SET value = '1';
    `);
  },
  // Sync. Three derived tables give what only 'messages' knew, so that every machine's
  // numbers come from the same tables: the days each session was active on, and the
  // tokens of each session and subagent run per model (for exact costs). Other machines'
  // rows are stored in every derived table under their own machine id; 'remote_files'
  // keeps the last good copy of each of their year files, to apply aliases again.
  (db) => {
    db.exec(`
      CREATE TABLE session_days (
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        -- A local day (of the session's machine) with at least one response, subagents included.
        local_day  TEXT NOT NULL,
        PRIMARY KEY (machine_id, session_id, local_day)
      ) WITHOUT ROWID;
      CREATE INDEX session_days_day ON session_days (local_day);

      -- Tokens of a session per model, subagents included.
      CREATE TABLE session_models (
        machine_id     TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        model          TEXT NOT NULL,
        input          INTEGER NOT NULL,
        output         INTEGER NOT NULL,
        cache_write    INTEGER NOT NULL,
        cache_read     INTEGER NOT NULL,
        cache_write_1h INTEGER NOT NULL,
        PRIMARY KEY (machine_id, session_id, model)
      ) WITHOUT ROWID;

      CREATE TABLE subagent_models (
        machine_id     TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        agent_id       TEXT NOT NULL,
        model          TEXT NOT NULL,
        input          INTEGER NOT NULL,
        output         INTEGER NOT NULL,
        cache_write    INTEGER NOT NULL,
        cache_read     INTEGER NOT NULL,
        cache_write_1h INTEGER NOT NULL,
        PRIMARY KEY (machine_id, session_id, agent_id, model)
      ) WITHOUT ROWID;

      CREATE TABLE remote_files (
        machine_id TEXT NOT NULL,
        year       INTEGER NOT NULL,
        file       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        mtime_ms   REAL NOT NULL,
        content    TEXT NOT NULL,
        read_at    TEXT NOT NULL,
        PRIMARY KEY (machine_id, year)
      ) WITHOUT ROWID;

      ALTER TABLE machines ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE machines ADD COLUMN app_version TEXT;

      INSERT INTO settings (key, value) VALUES ('derived_dirty', '1')
        ON CONFLICT (key) DO UPDATE SET value = '1';
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * A pause longer than this between two consecutive responses is time spent away, not
 * time spent working: it does not count towards the active time of a session.
 */
export const ACTIVE_GAP_LIMIT_MS = 30 * 60 * 1000;

/** Thrown when the database was written by a newer version of the app. */
export class DatabaseVersionError extends Error {
  constructor(found: number) {
    super(
      `The usage database has schema version ${found}, but this version of the app only ` +
        `knows version ${SCHEMA_VERSION}. Update the app to open it.`,
    );
    this.name = 'DatabaseVersionError';
  }
}

function migrate(db: Sqlite): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new DatabaseVersionError(current);
  for (let version = current; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version];
    if (!step) continue;
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

// ── Derived tables ────────────────────────────────────────────────────────────

const TOKENS = 'input + output + cache_write + cache_read';

/**
 * A subagent transcript with at most one output token and no stop reason is a background
 * agent that never completed. It is reported as its own kind, 'warmup'.
 */
const EFFECTIVE_KIND = `
  CASE WHEN a.kind IN ('task', 'workflow') AND a.output <= 1 AND a.stops = 0
       THEN 'warmup' ELSE a.kind END`;

interface Scope {
  agents: string;
  buckets: string;
  sessions: string;
}

/**
 * Active time: the sum of the gaps between consecutive responses, leaving out the long
 * ones. 'partition' lists the columns that identify one session or one subagent run.
 */
function activeTime(partition: string): string {
  return `
     gaps AS (
       SELECT ${partition}, ts - LAG(ts) OVER (PARTITION BY ${partition} ORDER BY ts, id) AS gap
       FROM scoped
     ),
     active AS (
       SELECT ${partition},
              COALESCE(SUM(CASE WHEN gap <= ${ACTIVE_GAP_LIMIT_MS} THEN gap ELSE 0 END), 0) AS active_ms
       FROM gaps GROUP BY ${partition}
     )`;
}

/**
 * The project a response is reported under: `tt_project` (registered by `UsageDatabase`)
 * splits a container folder by the directory directly under it, then applies the project
 * aliases. 'messages' keeps the raw folder project and subfolder, so changing the flags
 * or the aliases only rebuilds the derived tables.
 */
const PROJECT_NAME = 'tt_project(project, subfolder)';

/** The columns of 'messages' plus the reported project, for the 'scoped' CTEs below. */
const SCOPED_COLUMNS = `*, ${PROJECT_NAME} AS project_name`;

const EVERYTHING: Scope = { agents: '1', buckets: '1', sessions: '1' };

const TOUCHED: Scope = {
  agents: '(session_id, agent_id) IN (SELECT session_id, agent_id FROM temp.touched_agents)',
  buckets: '(local_day, local_hour) IN (SELECT local_day, local_hour FROM temp.touched_buckets)',
  sessions: 'session_id IN (SELECT session_id FROM temp.touched_sessions)',
};

/** Statements that rebuild the derived rows of this machine, in the order to run them. */
function refreshStatements(scope: Scope): string[] {
  return [
    `DELETE FROM subagents WHERE machine_id = @machine AND ${scope.agents}`,
    `INSERT INTO subagents (machine_id, session_id, agent_id, project, agent_type, kind, model,
                            start_ts, end_ts, start_day, calls, startup_input,
                            input, output, cache_write, cache_read, cache_write_1h, active_ms)
     WITH scoped AS (
       SELECT ${SCOPED_COLUMNS} FROM messages WHERE agent_id IS NOT NULL AND ${scope.agents}
     ),${activeTime('session_id, agent_id')},
     agg AS (
       SELECT session_id, agent_id, MIN(kind) AS kind, COUNT(*) AS calls,
              MIN(ts) AS start_ts, MAX(ts) AS end_ts,
              SUM(input) AS input, SUM(output) AS output,
              SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read,
              SUM(cache_write_1h) AS cache_write_1h,
              SUM(stop_reason IS NOT NULL) AS stops
       FROM scoped GROUP BY session_id, agent_id
     ),
     first_call AS (
       SELECT session_id, agent_id, local_day,
              input + cache_write + cache_read AS startup_input,
              ROW_NUMBER() OVER (PARTITION BY session_id, agent_id ORDER BY ts, id) AS position
       FROM scoped
     ),
     by_model AS (
       SELECT session_id, agent_id, model,
              ROW_NUMBER() OVER (PARTITION BY session_id, agent_id
                                 ORDER BY SUM(${TOKENS}) DESC, model) AS position
       FROM scoped GROUP BY session_id, agent_id, model
     ),
     by_project AS (
       SELECT session_id, agent_id, project_name AS project,
              ROW_NUMBER() OVER (PARTITION BY session_id, agent_id
                                 ORDER BY SUM(${TOKENS}) DESC, project_name) AS position
       FROM scoped GROUP BY session_id, agent_id, project_name
     )
     SELECT @machine, a.session_id, a.agent_id, p.project,
            COALESCE(meta.agent_type, '${UNKNOWN_AGENT_TYPE}'), ${EFFECTIVE_KIND}, m.model,
            a.start_ts, a.end_ts, f.local_day, a.calls, f.startup_input,
            a.input, a.output, a.cache_write, a.cache_read, a.cache_write_1h, t.active_ms
     FROM agg a
     JOIN active t ON t.session_id = a.session_id AND t.agent_id = a.agent_id
     JOIN first_call f
       ON f.session_id = a.session_id AND f.agent_id = a.agent_id AND f.position = 1
     JOIN by_model m
       ON m.session_id = a.session_id AND m.agent_id = a.agent_id AND m.position = 1
     JOIN by_project p
       ON p.session_id = a.session_id AND p.agent_id = a.agent_id AND p.position = 1
     LEFT JOIN agent_meta meta
       ON meta.session_id = a.session_id AND meta.agent_id = a.agent_id`,

    `DELETE FROM hourly WHERE machine_id = @machine AND ${scope.buckets}`,
    `INSERT INTO hourly (machine_id, local_day, local_hour, project, model, kind, agent_type,
                         input, output, cache_write, cache_read, cache_write_1h, messages)
     WITH scoped AS (
       SELECT ${SCOPED_COLUMNS} FROM messages WHERE ${scope.buckets}
     )
     SELECT @machine, m.local_day, m.local_hour, m.project_name, m.model,
            CASE WHEN m.agent_id IS NULL THEN 'main' ELSE COALESCE(s.kind, m.kind) END,
            CASE WHEN m.agent_id IS NULL THEN ''
                 ELSE COALESCE(s.agent_type, '${UNKNOWN_AGENT_TYPE}') END,
            SUM(m.input), SUM(m.output), SUM(m.cache_write), SUM(m.cache_read),
            SUM(m.cache_write_1h), COUNT(*)
     FROM scoped m
     LEFT JOIN subagents s
       ON s.machine_id = @machine AND s.session_id = m.session_id AND s.agent_id = m.agent_id
     GROUP BY 2, 3, 4, 5, 6, 7`,

    `DELETE FROM sessions WHERE machine_id = @machine AND ${scope.sessions}`,
    `INSERT INTO sessions (machine_id, session_id, project, model, start_ts, end_ts, start_day,
                           messages, input, output, cache_write, cache_read, cache_write_1h,
                           subagent_count, subagent_tokens, active_ms)
     WITH scoped AS (
       SELECT ${SCOPED_COLUMNS} FROM messages WHERE ${scope.sessions}
     ),${activeTime('session_id')},
     agg AS (
       SELECT session_id,
              SUM(agent_id IS NULL) AS messages,
              MIN(CASE WHEN agent_id IS NULL THEN ts END) AS main_start,
              MAX(CASE WHEN agent_id IS NULL THEN ts END) AS main_end,
              MIN(ts) AS any_start, MAX(ts) AS any_end,
              SUM(input) AS input, SUM(output) AS output,
              SUM(cache_write) AS cache_write, SUM(cache_read) AS cache_read,
              SUM(cache_write_1h) AS cache_write_1h,
              SUM(CASE WHEN agent_id IS NULL THEN 0 ELSE ${TOKENS} END) AS subagent_tokens
       FROM scoped GROUP BY session_id
     ),
     first_message AS (
       SELECT session_id, local_day,
              ROW_NUMBER() OVER (PARTITION BY session_id
                                 ORDER BY agent_id IS NOT NULL, ts, id) AS position
       FROM scoped
     ),
     by_model AS (
       SELECT session_id, model,
              ROW_NUMBER() OVER (
                PARTITION BY session_id
                ORDER BY SUM(CASE WHEN agent_id IS NULL THEN ${TOKENS} ELSE 0 END) DESC,
                         SUM(${TOKENS}) DESC, model
              ) AS position
       FROM scoped GROUP BY session_id, model
     ),
     by_project AS (
       SELECT session_id, project_name AS project,
              ROW_NUMBER() OVER (PARTITION BY session_id
                                 ORDER BY SUM(${TOKENS}) DESC, project_name) AS position
       FROM scoped GROUP BY session_id, project_name
     )
     SELECT @machine, a.session_id, p.project, m.model,
            COALESCE(a.main_start, a.any_start), COALESCE(a.main_end, a.any_end), f.local_day,
            a.messages, a.input, a.output, a.cache_write, a.cache_read, a.cache_write_1h,
            (SELECT COUNT(*) FROM subagents s
              WHERE s.machine_id = @machine AND s.session_id = a.session_id
                AND s.kind <> 'warmup'),
            a.subagent_tokens, t.active_ms
     FROM agg a
     JOIN active t ON t.session_id = a.session_id
     JOIN first_message f ON f.session_id = a.session_id AND f.position = 1
     JOIN by_model m ON m.session_id = a.session_id AND m.position = 1
     JOIN by_project p ON p.session_id = a.session_id AND p.position = 1`,

    `DELETE FROM session_days WHERE machine_id = @machine AND ${scope.sessions}`,
    `INSERT INTO session_days (machine_id, session_id, local_day)
     SELECT DISTINCT @machine, session_id, local_day FROM messages WHERE ${scope.sessions}`,

    `DELETE FROM session_models WHERE machine_id = @machine AND ${scope.sessions}`,
    `INSERT INTO session_models (machine_id, session_id, model,
                                 input, output, cache_write, cache_read, cache_write_1h)
     SELECT @machine, session_id, model, SUM(input), SUM(output),
            SUM(cache_write), SUM(cache_read), SUM(cache_write_1h)
     FROM messages WHERE ${scope.sessions} GROUP BY session_id, model`,

    `DELETE FROM subagent_models WHERE machine_id = @machine AND ${scope.agents}`,
    `INSERT INTO subagent_models (machine_id, session_id, agent_id, model,
                                  input, output, cache_write, cache_read, cache_write_1h)
     SELECT @machine, session_id, agent_id, model, SUM(input), SUM(output),
            SUM(cache_write), SUM(cache_read), SUM(cache_write_1h)
     FROM messages WHERE agent_id IS NOT NULL AND ${scope.agents}
     GROUP BY session_id, agent_id, model`,

    // Needs the 'sessions' rows above, for the start day.
    `DELETE FROM session_projects WHERE machine_id = @machine AND ${scope.sessions}`,
    `INSERT INTO session_projects (machine_id, session_id, project, start_day, tokens)
     WITH scoped AS (
       SELECT ${SCOPED_COLUMNS} FROM messages WHERE ${scope.sessions}
     ),
     per_project AS (
       SELECT session_id, project_name AS project, SUM(${TOKENS}) AS tokens
       FROM scoped GROUP BY session_id, project_name
     )
     SELECT @machine, p.session_id, p.project, s.start_day, p.tokens
     FROM per_project p
     JOIN sessions s ON s.machine_id = @machine AND s.session_id = p.session_id
     WHERE p.tokens > 0`,
  ];
}

/** Above this many touched keys, rebuilding everything is faster than rebuilding by key. */
const FULL_REBUILD_THRESHOLD = 400;

// ── Public types ──────────────────────────────────────────────────────────────

export interface OpenOptions {
  /** IANA zone used for local days and hours. Defaults to the system zone. */
  timeZone?: string;
  /** Name given to this machine the first time the database is created. */
  machineName?: string;
  platform?: Platform;
}

/** How far a transcript file has been read. */
export interface FileState {
  path: string;
  root: string;
  projectFolder: string;
  isSubagent: boolean;
  agentId: string | null;
  size: number;
  mtimeMs: number;
  /** Bytes consumed so far, always at the end of a complete line. */
  offset: number;
  /** Length and hash of the file's first bytes, to notice when a file is replaced. */
  headLength: number;
  headHash: string;
  /** True once the sibling meta file of a subagent transcript has been read. */
  metaRead: boolean;
  /** Project recovered for the session folder, reused for lines without a `cwd`. */
  project: string | null;
  lines: number;
  usageRecords: number;
  skipped: number;
}

/** A usage record ready to be stored. */
export interface MessageInput {
  dedupKey: string;
  /** UTC, milliseconds since the epoch. */
  timestamp: number;
  sessionId: string;
  project: string;
  /** Directory directly under the project the response was made in; empty at the top. */
  subfolder: string;
  modelId: string;
  model: string;
  kind: BaseKind;
  agentId: string | null;
  rank: number;
  stopReason: string | null;
  tokens: TokenBreakdown;
  /** The part of `tokens.cacheWrite` written to the 1-hour cache. */
  cacheWrite1h: number;
}

/** A subagent seen while reading a transcript. */
export interface AgentInput {
  sessionId: string;
  agentId: string;
  agentType: string;
  /** Present when the agent type comes from the transcript's meta file. */
  meta: AgentMeta | null;
}

export interface IngestCounts {
  /** Records stored for the first time. */
  inserted: number;
  /** Records already known and left as they were. */
  duplicates: number;
  /** Records already known whose copy brought more complete data. */
  upgraded: number;
}

export interface DatabaseStats {
  messages: number;
  sessions: number;
  subagentRuns: number;
  projects: number;
  models: number;
  tokens: TokenBreakdown;
  files: number;
  subagentFiles: number;
  skippedLines: number;
}

export interface SubagentRow {
  sessionId: string;
  agentId: string;
  project: string;
  agentType: string;
  kind: AgentKind;
  model: string;
  startTs: number;
  endTs: number;
  /** Time between the first and last call, long pauses left out. */
  activeMs: number;
  calls: number;
  startupInput: number;
  tokens: TokenBreakdown;
}

/** Tokens of one model, the 1-hour cache writes being part of `cacheWrite`. */
export interface ModelTokens {
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cacheWrite1h: number;
}

/** One row of `hourly`: a local hour of one project, model, kind and agent type. */
export interface HourlyRecord {
  day: string;
  hour: number;
  project: string;
  model: string;
  kind: AgentKind;
  /** Empty for the main session. */
  agentType: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cacheWrite1h: number;
  messages: number;
}

/** One session, with what the pages need to count and price it. */
export interface SessionRecord {
  id: string;
  /** The project with the most tokens. */
  project: string;
  /** The model with the most tokens in the main session. */
  model: string;
  startTs: number;
  endTs: number;
  startDay: string;
  messages: number;
  activeMs: number;
  /** Invocations, warm-ups left out. */
  subagentCount: number;
  subagentTokens: number;
  /** Tokens per model, subagents included. Their sum is the session's tokens. */
  models: ModelTokens[];
  /** Tokens per project the session worked in, subagents included. */
  projects: { name: string; tokens: number }[];
  /** The local days with at least one response, subagents included. */
  days: string[];
}

/** One subagent run. */
export interface SubagentRecord {
  sessionId: string;
  agentId: string;
  project: string;
  agentType: string;
  kind: SubagentKind;
  /** The model with the most tokens. */
  model: string;
  startTs: number;
  endTs: number;
  startDay: string;
  calls: number;
  startupInput: number;
  activeMs: number;
  /** Tokens per model. Their sum is the run's tokens. */
  models: ModelTokens[];
}

/** Everything a machine's pages are built from, as stored in the derived tables. */
export interface MachineRecords {
  hourly: HourlyRecord[];
  sessions: SessionRecord[];
  subagents: SubagentRecord[];
}

/** A year file of another machine, as last read successfully. */
export interface RemoteFile {
  machineId: string;
  year: number;
  /** The file name it was read from, for example `2026.json`. */
  file: string;
  size: number;
  mtimeMs: number;
  content: string;
}

interface ExistingMessage {
  id: number;
  local_day: string;
  local_hour: number;
  session_id: string;
  agent_id: string | null;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
  subfolder: string;
  stop_reason: string | null;
  rank: number;
}

interface FileRow {
  path: string;
  root: string;
  project_folder: string;
  is_subagent: number;
  agent_id: string | null;
  size: number;
  mtime_ms: number;
  read_offset: number;
  head_length: number;
  head_hash: string;
  meta_read: number;
  project: string | null;
  lines: number;
  usage_records: number;
  skipped: number;
}

const SETTING_MACHINE_ID = 'machine_id';
const SETTING_TIME_ZONE = 'time_zone';
const SETTING_DERIVED_DIRTY = 'derived_dirty';
const SETTING_CONTAINERS = 'container_projects';
const SETTING_ALIASES = 'project_aliases';

/** The derived tables, which hold every machine's rows under its machine id. */
const MACHINE_TABLES = [
  'hourly',
  'sessions',
  'session_projects',
  'session_days',
  'session_models',
  'subagents',
  'subagent_models',
] as const;

/**
 * Names projects the way `PROJECT_NAME` reports them: a container folder (flagged under
 * its own name or under an alias of it) is split by subfolder, then aliases apply.
 */
function projectNamer(containers: readonly string[], aliases: AliasMap) {
  const targets = containerTargets(containers, aliases);
  const cache = new Map<string, string>();
  return (project: string, subfolder: string): string => {
    const key = `${project}\n${subfolder}`;
    let name = cache.get(key);
    if (name === undefined) {
      const split = subfolder !== '' && targets.has(resolveAlias(project, aliases));
      name = applyAliases(split ? subfolderProject(project, subfolder) : project, aliases);
      cache.set(key, name);
    }
    return name;
  };
}

/** Reads a JSON list of aliases stored in settings; anything malformed is dropped. */
function storedAliases(stored: string | null): ProjectAlias[] {
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is ProjectAlias =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ProjectAlias).from === 'string' &&
        typeof (item as ProjectAlias).to === 'string',
    );
  } catch {
    return [];
  }
}

function modelTokensOf(row: {
  model: string;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
}): ModelTokens {
  return {
    model: row.model,
    input: row.input,
    output: row.output,
    cacheWrite: row.cache_write,
    cacheRead: row.cache_read,
    cacheWrite1h: row.cache_write_1h,
  };
}

function sumModels(models: readonly ModelTokens[]): Omit<ModelTokens, 'model'> {
  const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0 };
  for (const row of models) {
    total.input += row.input;
    total.output += row.output;
    total.cacheWrite += row.cacheWrite;
    total.cacheRead += row.cacheRead;
    total.cacheWrite1h += row.cacheWrite1h;
  }
  return total;
}

function defaultPlatform(): Platform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

// ── Database ──────────────────────────────────────────────────────────────────

export class UsageDatabase {
  /** The underlying connection, for read queries. */
  readonly raw: Sqlite;
  /** Random id of this machine, created the first time the database is opened. */
  readonly machineId: string;

  private readonly clock: LocalClock;
  /** Behind `tt_project`; set from the stored flags and aliases before each refresh. */
  private nameProject = projectNamer([], new Map());

  private readonly touchedBuckets = new Set<string>();
  private readonly touchedSessions = new Set<string>();
  private readonly touchedAgents = new Map<string, Set<string>>();
  private rebuildAll = false;

  private readonly statements: ReturnType<typeof prepareStatements>;

  /** Opens (and creates or upgrades) the database. Use `:memory:` for a throwaway one. */
  constructor(file: string, options: OpenOptions = {}) {
    this.raw = new Database(file);
    try {
      this.raw.pragma('journal_mode = WAL');
      this.raw.pragma('synchronous = NORMAL');
      migrate(this.raw);

      this.raw.exec(`
        CREATE TEMP TABLE touched_agents (
          session_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
        CREATE TEMP TABLE touched_buckets (
          local_day TEXT NOT NULL, local_hour INTEGER NOT NULL, PRIMARY KEY (local_day, local_hour)
        ) WITHOUT ROWID;
        CREATE TEMP TABLE touched_sessions (session_id TEXT PRIMARY KEY) WITHOUT ROWID;
      `);

      this.clock = createLocalClock(options.timeZone ?? systemTimeZone());
      this.raw.function('tt_local_day', (ts: number) => this.clock.toLocal(ts).day);
      this.raw.function('tt_local_hour', (ts: number) => this.clock.toLocal(ts).hour);
      this.raw.function('tt_project', { deterministic: true }, (project: unknown, sub: unknown) =>
        this.nameProject(String(project), String(sub ?? '')),
      );

      this.statements = prepareStatements(this.raw);
      this.machineId = this.ensureLocalMachine(options);
      this.applyTimeZone();

      // A crash between storing records and refreshing the derived tables leaves this set.
      if (this.getSetting(SETTING_DERIVED_DIRTY) === '1') {
        this.rebuildAll = true;
        this.refreshDerived();
      }
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  close(): void {
    if (this.raw.open) this.raw.close();
  }

  /** The time zone used for local days and hours. */
  get timeZone(): string {
    return this.clock.timeZone;
  }

  /**
   * Folder projects flagged as containers: folders that hold several projects, such as
   * the one an editor opens. Their usage is reported under the directory directly below.
   */
  getContainerProjects(): string[] {
    const stored = this.getSetting(SETTING_CONTAINERS);
    if (!stored) return [];
    try {
      const value: unknown = JSON.parse(stored);
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item !== '')
        : [];
    } catch {
      return [];
    }
  }

  /** Replaces the container flags and rebuilds the derived tables to apply them. */
  setContainerProjects(projects: readonly string[]): void {
    const clean = [...new Set(projects.map((project) => project.trim()).filter(Boolean))].sort();
    this.raw.transaction(() => {
      this.setSetting(SETTING_CONTAINERS, JSON.stringify(clean));
      this.setSetting(SETTING_DERIVED_DIRTY, '1');
    })();
    this.rebuildAll = true;
    this.refreshDerived();
  }

  /** Old project names mapped to new ones, in the order they were added. */
  getProjectAliases(): ProjectAlias[] {
    return storedAliases(this.getSetting(SETTING_ALIASES));
  }

  /**
   * Replaces the aliases and rebuilds this machine's derived tables to apply them. The
   * caller checks the list (`parseProjectAliases`) and applies it to other machines' rows.
   */
  setProjectAliases(aliases: readonly ProjectAlias[]): void {
    this.raw.transaction(() => {
      this.setSetting(SETTING_ALIASES, JSON.stringify(aliases));
      this.setSetting(SETTING_DERIVED_DIRTY, '1');
    })();
    this.rebuildAll = true;
    this.refreshDerived();
  }

  /**
   * Tokens of this machine per folder project and subfolder, as stored (before container
   * folders are split). `subfolder` is empty for the top of the folder.
   */
  folderUsage(): { project: string; subfolder: string; tokens: number }[] {
    return this.raw
      .prepare(
        `SELECT project, subfolder, SUM(${TOKENS}) AS tokens
         FROM messages GROUP BY project, subfolder`,
      )
      .all() as { project: string; subfolder: string; tokens: number }[];
  }

  /** Transcript files read so far, per `projects` folder. */
  filesPerRoot(): Map<string, number> {
    const rows = this.raw.prepare('SELECT root, COUNT(*) AS n FROM files GROUP BY root').all() as {
      root: string;
      n: number;
    }[];
    return new Map(rows.map((row) => [row.root, row.n]));
  }

  /**
   * Forgets how far each transcript was read, so the next scan reads every file still on
   * disk again, and rebuilds the derived tables at the end of it. No usage is deleted:
   * deduplication keeps the records already stored, including those whose file is gone.
   */
  resetFileStates(): void {
    this.raw.transaction(() => {
      this.raw.exec('DELETE FROM files');
      this.setSetting(SETTING_DERIVED_DIRTY, '1');
    })();
    this.rebuildAll = true;
  }

  /** The local day (`YYYY-MM-DD`) of an instant, in that time zone. */
  localDay(timestampMs: number): string {
    return this.clock.toLocal(timestampMs).day;
  }

  /** The local day and clock time (`HH:MM`) of an instant, in that time zone. */
  localDayTime(timestampMs: number): { day: string; time: string } {
    const local = this.clock.toLocalMinute(timestampMs);
    const pad = (value: number) => String(value).padStart(2, '0');
    return { day: local.day, time: `${pad(local.hour)}:${pad(local.minute)}` };
  }

  // ── Settings and machines ───────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.statements.getSetting.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.statements.setSetting.run(key, value);
  }

  /** The machines of the machine selector: this one first, then the others by name. */
  listMachines(): Machine[] {
    return this.listAllMachines()
      .filter((machine) => !machine.hidden)
      .map(({ id, name, platform, isLocal, lastSync }) => ({
        id,
        name,
        platform,
        isLocal,
        lastSync,
      }));
  }

  /** Every machine ever seen, hidden ones included, this one first. */
  listAllMachines(): Omit<SyncMachine, 'problem' | 'conflictCopies'>[] {
    const rows = this.raw
      .prepare(
        `SELECT id, name, platform, is_local, last_sync, hidden, app_version FROM machines
         ORDER BY is_local DESC, name COLLATE NOCASE, id`,
      )
      .all() as {
      id: string;
      name: string;
      platform: Platform;
      is_local: number;
      last_sync: string | null;
      hidden: number;
      app_version: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      isLocal: row.is_local === 1,
      lastSync: row.last_sync,
      appVersion: row.app_version,
      hidden: row.hidden === 1,
    }));
  }

  /** The name other machines show for this one. */
  get machineName(): string {
    return (
      (this.raw.prepare('SELECT name FROM machines WHERE id = ?').pluck().get(this.machineId) as
        string | undefined) ?? ''
    );
  }

  setMachineName(name: string): void {
    this.raw.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, this.machineId);
  }

  /** Records when this machine last wrote its sync files (UTC ISO). */
  setLocalLastSync(at: string): void {
    this.raw.prepare('UPDATE machines SET last_sync = ? WHERE id = ?').run(at, this.machineId);
  }

  /** Adds or updates another machine from its `machine.json`. Its hidden flag is kept. */
  upsertRemoteMachine(machine: {
    id: string;
    name: string;
    platform: Platform;
    lastSync: string | null;
    appVersion: string | null;
  }): void {
    if (machine.id === this.machineId) return;
    this.raw
      .prepare(
        `INSERT INTO machines (id, name, platform, is_local, last_sync, app_version)
         VALUES (@id, @name, @platform, 0, @lastSync, @appVersion)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
           last_sync = excluded.last_sync, app_version = excluded.app_version`,
      )
      .run(machine);
  }

  isMachineHidden(machineId: string): boolean {
    return (
      this.raw.prepare('SELECT hidden FROM machines WHERE id = ?').pluck().get(machineId) === 1
    );
  }

  /**
   * Hides another machine, whose usage then disappears from every page, or shows it
   * again. Its last year files stay stored, so showing it again needs no Drive access.
   */
  setMachineHidden(machineId: string, hidden: boolean): void {
    if (machineId === this.machineId) return;
    this.raw.transaction(() => {
      this.raw
        .prepare('UPDATE machines SET hidden = ? WHERE id = ?')
        .run(hidden ? 1 : 0, machineId);
      if (hidden) this.deleteMachineRows(machineId);
    })();
  }

  private deleteMachineRows(machineId: string): void {
    for (const table of MACHINE_TABLES) {
      this.raw.prepare(`DELETE FROM ${table} WHERE machine_id = ?`).run(machineId);
    }
  }

  // ── Sync records ────────────────────────────────────────────────────────────

  /** This machine's rows of the derived tables, in a stable order, for its sync files. */
  exportRecords(): MachineRecords {
    const machine = this.machineId;
    const raw = this.raw;
    type Row = Record<string, number | string>;

    const hourly = (
      raw
        .prepare(
          `SELECT local_day, local_hour, project, model, kind, agent_type, input, output,
                  cache_write, cache_read, cache_write_1h, messages
           FROM hourly WHERE machine_id = ?
           ORDER BY local_day, local_hour, project, model, kind, agent_type`,
        )
        .all(machine) as Row[]
    ).map((row): HourlyRecord => ({
      day: row.local_day as string,
      hour: row.local_hour as number,
      project: row.project as string,
      model: row.model as string,
      kind: row.kind as AgentKind,
      agentType: row.agent_type as string,
      input: row.input as number,
      output: row.output as number,
      cacheWrite: row.cache_write as number,
      cacheRead: row.cache_read as number,
      cacheWrite1h: row.cache_write_1h as number,
      messages: row.messages as number,
    }));

    const group = <T>(rows: Row[], key: (row: Row) => string, map: (row: Row) => T) => {
      const byKey = new Map<string, T[]>();
      for (const row of rows) {
        const list = byKey.get(key(row));
        if (list) list.push(map(row));
        else byKey.set(key(row), [map(row)]);
      }
      return byKey;
    };
    const sessionKey = (row: Row) => row.session_id as string;
    const toModel = (row: Row) =>
      modelTokensOf(row as unknown as Parameters<typeof modelTokensOf>[0]);

    const sessionModels = group(
      raw
        .prepare('SELECT * FROM session_models WHERE machine_id = ? ORDER BY session_id, model')
        .all(machine) as Row[],
      sessionKey,
      toModel,
    );
    const sessionProjects = group(
      raw
        .prepare(
          `SELECT session_id, project, tokens FROM session_projects
           WHERE machine_id = ? ORDER BY session_id, project`,
        )
        .all(machine) as Row[],
      sessionKey,
      (row) => ({ name: row.project as string, tokens: row.tokens as number }),
    );
    const sessionDays = group(
      raw
        .prepare(
          `SELECT session_id, local_day FROM session_days
           WHERE machine_id = ? ORDER BY session_id, local_day`,
        )
        .all(machine) as Row[],
      sessionKey,
      (row) => row.local_day as string,
    );

    const sessions = (
      raw
        .prepare(
          `SELECT session_id, project, model, start_ts, end_ts, start_day, messages, active_ms,
                  subagent_count, subagent_tokens
           FROM sessions WHERE machine_id = ? ORDER BY start_ts, session_id`,
        )
        .all(machine) as Row[]
    ).map((row): SessionRecord => ({
      id: row.session_id as string,
      project: row.project as string,
      model: row.model as string,
      startTs: row.start_ts as number,
      endTs: row.end_ts as number,
      startDay: row.start_day as string,
      messages: row.messages as number,
      activeMs: row.active_ms as number,
      subagentCount: row.subagent_count as number,
      subagentTokens: row.subagent_tokens as number,
      models: sessionModels.get(row.session_id as string) ?? [],
      projects: sessionProjects.get(row.session_id as string) ?? [],
      days: sessionDays.get(row.session_id as string) ?? [],
    }));

    const agentKey = (row: Row) => `${row.session_id as string}\n${row.agent_id as string}`;
    const agentModels = group(
      raw
        .prepare(
          `SELECT * FROM subagent_models WHERE machine_id = ?
           ORDER BY session_id, agent_id, model`,
        )
        .all(machine) as Row[],
      agentKey,
      toModel,
    );
    const subagents = (
      raw
        .prepare(
          `SELECT session_id, agent_id, project, agent_type, kind, model, start_ts, end_ts,
                  start_day, calls, startup_input, active_ms
           FROM subagents WHERE machine_id = ? ORDER BY start_ts, session_id, agent_id`,
        )
        .all(machine) as Row[]
    ).map((row): SubagentRecord => ({
      sessionId: row.session_id as string,
      agentId: row.agent_id as string,
      project: row.project as string,
      agentType: row.agent_type as string,
      kind: row.kind as SubagentKind,
      model: row.model as string,
      startTs: row.start_ts as number,
      endTs: row.end_ts as number,
      startDay: row.start_day as string,
      calls: row.calls as number,
      startupInput: row.startup_input as number,
      activeMs: row.active_ms as number,
      models: agentModels.get(agentKey(row)) ?? [],
    }));

    return { hourly, sessions, subagents };
  }

  /**
   * Replaces every derived row of another machine with `records`, in one transaction.
   * Rows that end up with the same key (two names aliased to one) are added together.
   */
  replaceMachineRecords(machineId: string, records: MachineRecords): void {
    if (machineId === this.machineId) throw new Error('The local machine is not replaced');
    const raw = this.raw;
    const insert = {
      hourly: raw.prepare(
        `INSERT INTO hourly (machine_id, local_day, local_hour, project, model, kind, agent_type,
                             input, output, cache_write, cache_read, cache_write_1h, messages)
         VALUES (@m, @day, @hour, @project, @model, @kind, @agentType,
                 @input, @output, @cacheWrite, @cacheRead, @cacheWrite1h, @messages)
         ON CONFLICT DO UPDATE SET input = input + excluded.input,
           output = output + excluded.output, cache_write = cache_write + excluded.cache_write,
           cache_read = cache_read + excluded.cache_read,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h,
           messages = messages + excluded.messages`,
      ),
      session: raw.prepare(
        `INSERT OR IGNORE INTO sessions (machine_id, session_id, project, model, start_ts, end_ts,
           start_day, messages, input, output, cache_write, cache_read, cache_write_1h,
           subagent_count, subagent_tokens, active_ms)
         VALUES (@m, @id, @project, @model, @startTs, @endTs, @startDay, @messages,
                 @input, @output, @cacheWrite, @cacheRead, @cacheWrite1h,
                 @subagentCount, @subagentTokens, @activeMs)`,
      ),
      sessionModel: raw.prepare(
        `INSERT INTO session_models (machine_id, session_id, model,
           input, output, cache_write, cache_read, cache_write_1h)
         VALUES (@m, @session, @model, @input, @output, @cacheWrite, @cacheRead, @cacheWrite1h)
         ON CONFLICT DO UPDATE SET input = input + excluded.input,
           output = output + excluded.output, cache_write = cache_write + excluded.cache_write,
           cache_read = cache_read + excluded.cache_read,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h`,
      ),
      sessionProject: raw.prepare(
        `INSERT INTO session_projects (machine_id, session_id, project, start_day, tokens)
         VALUES (@m, @session, @project, @startDay, @tokens)
         ON CONFLICT DO UPDATE SET tokens = tokens + excluded.tokens`,
      ),
      sessionDay: raw.prepare(
        `INSERT OR IGNORE INTO session_days (machine_id, session_id, local_day)
         VALUES (@m, @session, @day)`,
      ),
      subagent: raw.prepare(
        `INSERT OR IGNORE INTO subagents (machine_id, session_id, agent_id, project, agent_type,
           kind, model, start_ts, end_ts, start_day, calls, startup_input,
           input, output, cache_write, cache_read, cache_write_1h, active_ms)
         VALUES (@m, @sessionId, @agentId, @project, @agentType, @kind, @model, @startTs,
                 @endTs, @startDay, @calls, @startupInput,
                 @input, @output, @cacheWrite, @cacheRead, @cacheWrite1h, @activeMs)`,
      ),
      subagentModel: raw.prepare(
        `INSERT INTO subagent_models (machine_id, session_id, agent_id, model,
           input, output, cache_write, cache_read, cache_write_1h)
         VALUES (@m, @session, @agent, @model, @input, @output, @cacheWrite, @cacheRead,
                 @cacheWrite1h)
         ON CONFLICT DO UPDATE SET input = input + excluded.input,
           output = output + excluded.output, cache_write = cache_write + excluded.cache_write,
           cache_read = cache_read + excluded.cache_read,
           cache_write_1h = cache_write_1h + excluded.cache_write_1h`,
      ),
    };

    raw.transaction(() => {
      this.deleteMachineRows(machineId);
      const m = machineId;
      for (const row of records.hourly) insert.hourly.run({ m, ...row });

      for (const session of records.sessions) {
        const { models, projects, days, ...fields } = session;
        // A session id seen twice (two year files) keeps its first copy.
        const added = insert.session.run({ m, ...fields, ...sumModels(models) });
        if (added.changes === 0) continue;
        for (const model of models) insert.sessionModel.run({ m, session: session.id, ...model });
        for (const project of projects) {
          if (project.tokens <= 0) continue;
          insert.sessionProject.run({
            m,
            session: session.id,
            project: project.name,
            startDay: session.startDay,
            tokens: project.tokens,
          });
        }
        for (const day of days) insert.sessionDay.run({ m, session: session.id, day });
      }

      for (const run of records.subagents) {
        const { models, ...fields } = run;
        const added = insert.subagent.run({ m, ...fields, ...sumModels(models) });
        if (added.changes === 0) continue;
        for (const model of models) {
          insert.subagentModel.run({ m, session: run.sessionId, agent: run.agentId, ...model });
        }
      }
    })();
  }

  /** Every stored year file of another machine, oldest year first. */
  remoteFiles(machineId: string): RemoteFile[] {
    const rows = this.raw
      .prepare(
        `SELECT machine_id, year, file, size, mtime_ms, content FROM remote_files
         WHERE machine_id = ? ORDER BY year`,
      )
      .all(machineId) as {
      machine_id: string;
      year: number;
      file: string;
      size: number;
      mtime_ms: number;
      content: string;
    }[];
    return rows.map((row) => ({
      machineId: row.machine_id,
      year: row.year,
      file: row.file,
      size: row.size,
      mtimeMs: row.mtime_ms,
      content: row.content,
    }));
  }

  /** Where each stored year file was read from, without its content. */
  remoteFileStates(): Map<string, { file: string; size: number; mtimeMs: number }> {
    const rows = this.raw
      .prepare('SELECT machine_id, year, file, size, mtime_ms FROM remote_files')
      .all() as {
      machine_id: string;
      year: number;
      file: string;
      size: number;
      mtime_ms: number;
    }[];
    return new Map(
      rows.map((row) => [
        `${row.machine_id}/${row.year}`,
        { file: row.file, size: row.size, mtimeMs: row.mtime_ms },
      ]),
    );
  }

  /** Keeps a year file of another machine that was read and checked successfully. */
  saveRemoteFile(file: RemoteFile): void {
    this.raw
      .prepare(
        `INSERT INTO remote_files (machine_id, year, file, size, mtime_ms, content, read_at)
         VALUES (@machineId, @year, @file, @size, @mtimeMs, @content, @readAt)
         ON CONFLICT (machine_id, year) DO UPDATE SET file = excluded.file,
           size = excluded.size, mtime_ms = excluded.mtime_ms, content = excluded.content,
           read_at = excluded.read_at`,
      )
      .run({ ...file, readAt: new Date().toISOString() });
  }

  private ensureLocalMachine(options: OpenOptions): string {
    const existing = this.getSetting(SETTING_MACHINE_ID);
    if (existing) return existing;

    const id = randomUUID();
    this.raw.transaction(() => {
      this.setSetting(SETTING_MACHINE_ID, id);
      this.raw
        .prepare('INSERT INTO machines (id, name, platform, is_local) VALUES (?, ?, ?, 1)')
        .run(
          id,
          options.machineName?.trim() || 'This machine',
          options.platform ?? defaultPlatform(),
        );
    })();
    return id;
  }

  /**
   * Local days and hours are derived from the UTC timestamps. When the system time zone
   * is not the one they were derived in, they are computed again.
   */
  private applyTimeZone(): void {
    const stored = this.getSetting(SETTING_TIME_ZONE);
    if (stored === this.clock.timeZone) return;
    this.raw.transaction(() => {
      if (stored !== null) {
        this.raw.exec(
          'UPDATE messages SET local_day = tt_local_day(ts), local_hour = tt_local_hour(ts)',
        );
        this.setSetting(SETTING_DERIVED_DIRTY, '1');
      }
      this.setSetting(SETTING_TIME_ZONE, this.clock.timeZone);
    })();
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  loadFileStates(): Map<string, FileState> {
    const rows = this.raw.prepare('SELECT * FROM files').all() as FileRow[];
    const states = new Map<string, FileState>();
    for (const row of rows) {
      states.set(row.path, {
        path: row.path,
        root: row.root,
        projectFolder: row.project_folder,
        isSubagent: row.is_subagent === 1,
        agentId: row.agent_id,
        size: row.size,
        mtimeMs: row.mtime_ms,
        offset: row.read_offset,
        headLength: row.head_length,
        headHash: row.head_hash,
        metaRead: row.meta_read === 1,
        project: row.project,
        lines: row.lines,
        usageRecords: row.usage_records,
        skipped: row.skipped,
      });
    }
    return states;
  }

  saveFileState(file: FileState): void {
    this.statements.saveFile.run({
      path: file.path,
      root: file.root,
      project_folder: file.projectFolder,
      is_subagent: file.isSubagent ? 1 : 0,
      agent_id: file.agentId,
      size: file.size,
      mtime_ms: file.mtimeMs,
      read_offset: file.offset,
      head_length: file.headLength,
      head_hash: file.headHash,
      meta_read: file.metaRead ? 1 : 0,
      project: file.project,
      lines: file.lines,
      usage_records: file.usageRecords,
      skipped: file.skipped,
    });
  }

  // ── Ingestion ───────────────────────────────────────────────────────────────

  /**
   * Stores a batch of records read from one file, together with how far the file was
   * read, in a single transaction: after a crash the scan resumes exactly where the
   * stored data ends.
   */
  ingestBatch(file: FileState, messages: MessageInput[], agents: AgentInput[]): IngestCounts {
    const counts: IngestCounts = { inserted: 0, duplicates: 0, upgraded: 0 };
    this.raw.transaction(() => {
      for (const agent of agents) this.storeAgent(agent);
      for (const message of messages) counts[this.storeMessage(message)]++;
      this.saveFileState(file);
      this.markDirty();
    })();
    return counts;
  }

  /**
   * Applies a meta file that showed up after its transcript had been read. `agentId` is the
   * one taken from the transcript's file name.
   */
  applyLateMeta(file: FileState, meta: AgentMeta): void {
    if (!file.agentId) return;
    const agentId = file.agentId;
    this.raw.transaction(() => {
      const rows = this.raw
        .prepare('SELECT session_id FROM agent_meta WHERE agent_id = ?')
        .all(agentId) as { session_id: string }[];
      this.raw
        .prepare(
          `UPDATE agent_meta SET agent_type = ?, from_meta = 1, description = ?, tool_use_id = ?
           WHERE agent_id = ?`,
        )
        .run(meta.agentType, meta.description, meta.toolUseId, agentId);
      for (const row of rows) this.touchAgent(row.session_id, agentId);
      this.saveFileState(file);
      this.markDirty();
    })();
  }

  private storeAgent(agent: AgentInput): void {
    const existing = this.statements.getAgent.get(agent.sessionId, agent.agentId) as
      { from_meta: number } | undefined;

    // A type read from a meta file is never replaced by a guessed one.
    if (existing && (existing.from_meta === 1 || !agent.meta)) return;

    this.statements.saveAgent.run({
      session_id: agent.sessionId,
      agent_id: agent.agentId,
      agent_type: agent.agentType,
      from_meta: agent.meta ? 1 : 0,
      description: agent.meta?.description ?? null,
      tool_use_id: agent.meta?.toolUseId ?? null,
    });
    this.touchAgent(agent.sessionId, agent.agentId);
  }

  private storeMessage(message: MessageInput): keyof IngestCounts {
    const existing = this.statements.getMessage.get(message.dedupKey) as
      ExistingMessage | undefined;

    if (!existing) {
      const local = this.clock.toLocal(message.timestamp);
      this.statements.insertMessage.run({
        dedup_key: message.dedupKey,
        ts: message.timestamp,
        local_day: local.day,
        local_hour: local.hour,
        session_id: message.sessionId,
        project: message.project,
        subfolder: message.subfolder,
        model_id: message.modelId,
        model: message.model,
        kind: message.kind,
        agent_id: message.agentId,
        input: message.tokens.input,
        output: message.tokens.output,
        cache_write: message.tokens.cacheWrite,
        cache_read: message.tokens.cacheRead,
        cache_write_1h: message.cacheWrite1h,
        stop_reason: message.stopReason,
        rank: message.rank,
      });
      this.touch(local.day, local.hour, message.sessionId, message.agentId);
      return 'inserted';
    }

    // Copies of a streamed response can carry partial counts: keep the largest values.
    const input = Math.max(existing.input, message.tokens.input);
    const output = Math.max(existing.output, message.tokens.output);
    const cacheWrite = Math.max(existing.cache_write, message.tokens.cacheWrite);
    const cacheRead = Math.max(existing.cache_read, message.tokens.cacheRead);
    const cacheWrite1h = Math.max(existing.cache_write_1h, message.cacheWrite1h);
    const stopReason = existing.stop_reason ?? message.stopReason;
    const subfolder = existing.subfolder || message.subfolder;
    const moreComplete =
      subfolder !== existing.subfolder ||
      input !== existing.input ||
      output !== existing.output ||
      cacheWrite !== existing.cache_write ||
      cacheRead !== existing.cache_read ||
      cacheWrite1h !== existing.cache_write_1h ||
      stopReason !== existing.stop_reason;
    const betterPlace = message.rank > existing.rank;
    if (!moreComplete && !betterPlace) return 'duplicates';

    this.touch(existing.local_day, existing.local_hour, existing.session_id, existing.agent_id);
    if (betterPlace) {
      this.statements.moveMessage.run({
        id: existing.id,
        session_id: message.sessionId,
        project: message.project,
        subfolder: message.subfolder,
        kind: message.kind,
        agent_id: message.agentId,
        rank: message.rank,
      });
      this.touch(existing.local_day, existing.local_hour, message.sessionId, message.agentId);
    }
    if (moreComplete) {
      this.statements.completeMessage.run({
        id: existing.id,
        input,
        output,
        cache_write: cacheWrite,
        cache_read: cacheRead,
        cache_write_1h: cacheWrite1h,
        stop_reason: stopReason,
        // A move just above already set the subfolder of the better copy.
        subfolder: betterPlace ? message.subfolder : subfolder,
      });
    }
    return 'upgraded';
  }

  private touch(day: string, hour: number, sessionId: string, agentId: string | null): void {
    this.touchedBuckets.add(`${day}#${hour}`);
    this.touchedSessions.add(sessionId);
    if (agentId !== null) this.touchAgent(sessionId, agentId);
  }

  private touchAgent(sessionId: string, agentId: string): void {
    this.touchedSessions.add(sessionId);
    let agents = this.touchedAgents.get(sessionId);
    if (!agents) {
      agents = new Set();
      this.touchedAgents.set(sessionId, agents);
    }
    agents.add(agentId);
  }

  private get hasTouched(): boolean {
    return (
      this.touchedBuckets.size > 0 || this.touchedSessions.size > 0 || this.touchedAgents.size > 0
    );
  }

  private markDirty(): void {
    if (this.hasTouched) this.setSetting(SETTING_DERIVED_DIRTY, '1');
  }

  // ── Derived tables ──────────────────────────────────────────────────────────

  /**
   * Brings the derived tables in line with `messages`. Only the rows
   * affected since the last call are rebuilt, unless there are too many of them.
   */
  refreshDerived(): void {
    if (!this.rebuildAll && !this.hasTouched) return;

    let agentCount = 0;
    for (const agents of this.touchedAgents.values()) agentCount += agents.size;
    const full =
      this.rebuildAll ||
      this.touchedBuckets.size + this.touchedSessions.size + agentCount > FULL_REBUILD_THRESHOLD;

    const machine = this.machineId;
    this.nameProject = projectNamer(
      this.getContainerProjects(),
      aliasMap(this.getProjectAliases()),
    );
    this.raw.transaction(() => {
      if (!full) this.fillTouchedTables();
      const scope = full ? EVERYTHING : TOUCHED;
      for (const sql of refreshStatements(scope)) this.raw.prepare(sql).run({ machine });
      this.setSetting(SETTING_DERIVED_DIRTY, '0');
    })();

    this.touchedBuckets.clear();
    this.touchedSessions.clear();
    this.touchedAgents.clear();
    this.rebuildAll = false;
  }

  private fillTouchedTables(): void {
    this.raw.exec(
      'DELETE FROM temp.touched_agents; DELETE FROM temp.touched_buckets; DELETE FROM temp.touched_sessions;',
    );
    const addAgent = this.raw.prepare('INSERT OR IGNORE INTO temp.touched_agents VALUES (?, ?)');
    const addBucket = this.raw.prepare('INSERT OR IGNORE INTO temp.touched_buckets VALUES (?, ?)');
    const addSession = this.raw.prepare('INSERT OR IGNORE INTO temp.touched_sessions VALUES (?)');

    for (const [sessionId, agents] of this.touchedAgents) {
      for (const agentId of agents) addAgent.run(sessionId, agentId);
    }
    for (const bucket of this.touchedBuckets) {
      const separator = bucket.lastIndexOf('#');
      addBucket.run(bucket.slice(0, separator), Number(bucket.slice(separator + 1)));
    }
    for (const sessionId of this.touchedSessions) addSession.run(sessionId);

    // A subagent whose type or kind changes moves its tokens between hourly rows.
    this.raw.exec(`
      INSERT OR IGNORE INTO temp.touched_buckets
      SELECT DISTINCT local_day, local_hour FROM messages
      WHERE agent_id IS NOT NULL AND ${TOUCHED.agents}
    `);
  }

  // ── Read helpers ────────────────────────────────────────────────────────────

  stats(): DatabaseStats {
    const totals = this.raw
      .prepare(
        `SELECT COUNT(*) AS messages,
                COUNT(DISTINCT model) AS models,
                COALESCE(SUM(input), 0) AS input,
                COALESCE(SUM(output), 0) AS output,
                COALESCE(SUM(cache_write), 0) AS cache_write,
                COALESCE(SUM(cache_read), 0) AS cache_read
         FROM messages`,
      )
      .get() as {
      messages: number;
      models: number;
      input: number;
      output: number;
      cache_write: number;
      cache_read: number;
    };
    const count = (sql: string) =>
      (this.raw.prepare(sql).get(this.machineId) as { n: number | null }).n ?? 0;
    const files = this.raw
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(is_subagent), 0) AS subagent_files,
                COALESCE(SUM(skipped), 0) AS skipped FROM files`,
      )
      .get() as { files: number; subagent_files: number; skipped: number };

    return {
      messages: totals.messages,
      sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE machine_id = ?'),
      subagentRuns: count('SELECT COUNT(*) AS n FROM subagents WHERE machine_id = ?'),
      // Counted as reported, after container folders are split.
      projects: count('SELECT COUNT(DISTINCT project) AS n FROM hourly WHERE machine_id = ?'),
      models: totals.models,
      tokens: {
        input: totals.input,
        output: totals.output,
        cacheWrite: totals.cache_write,
        cacheRead: totals.cache_read,
      },
      files: files.files,
      subagentFiles: files.subagent_files,
      skippedLines: files.skipped,
    };
  }

  /** The subagent invocations of this machine, oldest first. */
  listSubagents(): SubagentRow[] {
    const rows = this.raw
      .prepare(
        `SELECT session_id, agent_id, project, agent_type, kind, model, start_ts, end_ts,
                active_ms, calls, startup_input, input, output, cache_write, cache_read
         FROM subagents WHERE machine_id = ? ORDER BY start_ts, agent_id`,
      )
      .all(this.machineId) as {
      session_id: string;
      agent_id: string;
      project: string;
      agent_type: string;
      kind: AgentKind;
      model: string;
      start_ts: number;
      end_ts: number;
      active_ms: number;
      calls: number;
      startup_input: number;
      input: number;
      output: number;
      cache_write: number;
      cache_read: number;
    }[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      agentId: row.agent_id,
      project: row.project,
      agentType: row.agent_type,
      kind: row.kind,
      model: row.model,
      startTs: row.start_ts,
      endTs: row.end_ts,
      activeMs: row.active_ms,
      calls: row.calls,
      startupInput: row.startup_input,
      tokens: {
        input: row.input,
        output: row.output,
        cacheWrite: row.cache_write,
        cacheRead: row.cache_read,
      },
    }));
  }
}

function prepareStatements(db: Sqlite) {
  return {
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ),
    saveFile: db.prepare(
      `INSERT INTO files (path, root, project_folder, is_subagent, agent_id, size, mtime_ms,
                            read_offset, head_length, head_hash, meta_read, project,
                            lines, usage_records, skipped)
         VALUES (@path, @root, @project_folder, @is_subagent, @agent_id, @size, @mtime_ms,
                 @read_offset, @head_length, @head_hash, @meta_read, @project,
                 @lines, @usage_records, @skipped)
         ON CONFLICT (path) DO UPDATE SET
           root = excluded.root, project_folder = excluded.project_folder,
           is_subagent = excluded.is_subagent, agent_id = excluded.agent_id,
           size = excluded.size, mtime_ms = excluded.mtime_ms,
           read_offset = excluded.read_offset, head_length = excluded.head_length,
           head_hash = excluded.head_hash, meta_read = excluded.meta_read,
           project = excluded.project, lines = excluded.lines,
           usage_records = excluded.usage_records, skipped = excluded.skipped`,
    ),
    getAgent: db.prepare('SELECT from_meta FROM agent_meta WHERE session_id = ? AND agent_id = ?'),
    saveAgent: db.prepare(
      `INSERT INTO agent_meta (session_id, agent_id, agent_type, from_meta, description, tool_use_id)
         VALUES (@session_id, @agent_id, @agent_type, @from_meta, @description, @tool_use_id)
         ON CONFLICT (session_id, agent_id) DO UPDATE SET
           agent_type = excluded.agent_type, from_meta = excluded.from_meta,
           description = excluded.description, tool_use_id = excluded.tool_use_id`,
    ),
    getMessage: db.prepare(
      `SELECT id, local_day, local_hour, session_id, agent_id,
                input, output, cache_write, cache_read, cache_write_1h, subfolder,
                stop_reason, rank
         FROM messages WHERE dedup_key = ?`,
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (dedup_key, ts, local_day, local_hour, session_id, project, subfolder,
                               model_id, model, kind, agent_id,
                               input, output, cache_write, cache_read, cache_write_1h,
                               stop_reason, rank)
         VALUES (@dedup_key, @ts, @local_day, @local_hour, @session_id, @project, @subfolder,
                 @model_id, @model, @kind, @agent_id,
                 @input, @output, @cache_write, @cache_read, @cache_write_1h,
                 @stop_reason, @rank)`,
    ),
    moveMessage: db.prepare(
      `UPDATE messages SET session_id = @session_id, project = @project, subfolder = @subfolder,
                             kind = @kind, agent_id = @agent_id, rank = @rank
         WHERE id = @id`,
    ),
    completeMessage: db.prepare(
      `UPDATE messages SET input = @input, output = @output, cache_write = @cache_write,
                             cache_read = @cache_read, cache_write_1h = @cache_write_1h,
                             stop_reason = @stop_reason, subfolder = @subfolder
         WHERE id = @id`,
    ),
  };
}
