/**
 * The files the sync writes to Google Drive, and how they are read back.
 *
 * Each machine writes only its own folder, `ClaudeTokenTracker/machines/<machineId>/`:
 * `machine.json` (name, platform, last sync) and one `<year>.json` per year of usage.
 * They carry aggregated numbers only: local days and hours, project names (folder names,
 * never paths), model names, agent types and kinds, token counts, durations, and random
 * session and agent ids. Never prompt or response text, subagent descriptions, file
 * paths or code.
 *
 * Reading is defensive: a file that is not valid JSON, has another machine's id, or
 * needs a newer version of the app is refused as a whole; a malformed row is skipped.
 */
import { isDay } from '../shared/period';
import { applyAliases, type AliasMap } from '../shared/projects';
import type { AgentKind, Platform, SubagentKind } from '../shared/types';
import type {
  HourlyRecord,
  MachineRecords,
  ModelTokens,
  SessionRecord,
  SubagentRecord,
} from './db';

/** Version of the file format. A reader refuses files with a higher one. */
export const SYNC_SCHEMA_VERSION = 1;
/** The folder created in "My Drive". */
export const SYNC_FOLDER_NAME = 'ClaudeTokenTracker';
export const MACHINES_FOLDER = 'machines';
export const MACHINE_FILE = 'machine.json';
export const README_FILE = 'README.txt';
/** A year file larger than this is written gzipped, as `<year>.json.gz`. */
export const GZIP_THRESHOLD = 5 * 1024 * 1024;
/** Files larger than this are not read (a real year is a few MB). */
export const MAX_SYNC_FILE_BYTES = 256 * 1024 * 1024;

const MAX_NAME = 1_000;
const MAX_ID = 200;
const KINDS: readonly AgentKind[] = ['main', 'task', 'workflow', 'aside', 'warmup'];
const SUBAGENT_KINDS: readonly SubagentKind[] = ['task', 'workflow', 'aside', 'warmup'];
const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux'];

// ── File shapes ───────────────────────────────────────────────────────────────

/** `[model, input, output, cacheWrite, cacheRead, cacheWrite1h]`; 1-hour writes are part of cacheWrite. */
export type ModelRow = [string, number, number, number, number, number];

/**
 * `[localDay, localHour, project, model, kind, agentType ("" for main), input, output,
 * cacheWrite, cacheRead, cacheWrite1h, messages]`, in the writing machine's local time.
 */
export type HourlyRow = [
  string,
  number,
  string,
  string,
  AgentKind,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface SessionEntry {
  id: string;
  project: string;
  model: string;
  /** UTC ISO timestamps of the main session's first and last responses. */
  start: string;
  end: string;
  startDay: string;
  messages: number;
  activeMs: number;
  subagentCount: number;
  subagentTokens: number;
  models: ModelRow[];
  /** `[project, tokens]` of every project the session worked in. */
  projects: [string, number][];
  /** Local days with activity. */
  days: string[];
}

export interface SubagentEntry {
  /** The agent id. */
  id: string;
  session: string;
  project: string;
  type: string;
  kind: SubagentKind;
  model: string;
  start: string;
  end: string;
  startDay: string;
  calls: number;
  startupInput: number;
  activeMs: number;
  models: ModelRow[];
}

export interface YearFile {
  schemaVersion: number;
  machineId: string;
  year: number;
  hourly: HourlyRow[];
  sessions: SessionEntry[];
  subagents: SubagentEntry[];
}

export interface MachineFile {
  schemaVersion: number;
  machineId: string;
  name: string;
  platform: Platform;
  appVersion: string;
  /** UTC ISO timestamp of the last write. */
  lastSync: string;
  /** The years that have a file. */
  years: number[];
}

// ── Writing ───────────────────────────────────────────────────────────────────

const yearOf = (day: string) => Number(day.slice(0, 4));
const iso = (ms: number) => new Date(ms).toISOString();

function modelRow(row: ModelTokens): ModelRow {
  return [row.model, row.input, row.output, row.cacheWrite, row.cacheRead, row.cacheWrite1h];
}

/**
 * This machine's records cut into one file per year: hourly rows by their day, sessions
 * and subagent runs by their start day.
 */
export function buildYearFiles(records: MachineRecords, machineId: string): Map<number, YearFile> {
  const files = new Map<number, YearFile>();
  const fileOf = (day: string) => {
    const year = yearOf(day);
    let file = files.get(year);
    if (!file) {
      file = {
        schemaVersion: SYNC_SCHEMA_VERSION,
        machineId,
        year,
        hourly: [],
        sessions: [],
        subagents: [],
      };
      files.set(year, file);
    }
    return file;
  };

  for (const row of records.hourly) {
    fileOf(row.day).hourly.push([
      row.day,
      row.hour,
      row.project,
      row.model,
      row.kind,
      row.agentType,
      row.input,
      row.output,
      row.cacheWrite,
      row.cacheRead,
      row.cacheWrite1h,
      row.messages,
    ]);
  }
  for (const session of records.sessions) {
    fileOf(session.startDay).sessions.push({
      id: session.id,
      project: session.project,
      model: session.model,
      start: iso(session.startTs),
      end: iso(session.endTs),
      startDay: session.startDay,
      messages: session.messages,
      activeMs: session.activeMs,
      subagentCount: session.subagentCount,
      subagentTokens: session.subagentTokens,
      models: session.models.map(modelRow),
      projects: session.projects.map((project) => [project.name, project.tokens]),
      days: session.days,
    });
  }
  for (const run of records.subagents) {
    fileOf(run.startDay).subagents.push({
      id: run.agentId,
      session: run.sessionId,
      project: run.project,
      type: run.agentType,
      kind: run.kind,
      model: run.model,
      start: iso(run.startTs),
      end: iso(run.endTs),
      startDay: run.startDay,
      calls: run.calls,
      startupInput: run.startupInput,
      activeMs: run.activeMs,
      models: run.models.map(modelRow),
    });
  }
  return files;
}

/** One row per line, so the file stays readable and its size predictable. */
export function serializeYearFile(file: YearFile): string {
  const list = (rows: readonly unknown[]) =>
    rows.length === 0 ? '[]' : `[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]`;
  return (
    `{"schemaVersion":${file.schemaVersion},"machineId":${JSON.stringify(file.machineId)},` +
    `"year":${file.year},\n"hourly":${list(file.hourly)},\n"sessions":${list(file.sessions)},\n` +
    `"subagents":${list(file.subagents)}}\n`
  );
}

export function serializeMachineFile(file: MachineFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The short explanation written once at the top of the sync folder. */
export const README_TEXT = `Token Tracker for Claude Code - sync folder

This folder lets Token Tracker for Claude Code show the combined Claude Code usage of
several computers. Each computer writes only its own folder under "machines" and reads
the others'. Nothing in here is sent anywhere by the app: Google Drive for desktop syncs it.

machines/<machine id>/machine.json   the computer's name, platform and last sync time
machines/<machine id>/<year>.json    that year's usage (.json.gz when it is large)

Only aggregated numbers are written: local days and hours, project names (folder names,
never paths), model names, agent types and kinds, token counts, durations, and random
session and agent ids. Never prompts, responses, code, subagent descriptions or file paths.

Deleting a machine's folder removes its numbers from the other computers the next time
they read this folder, unless that computer writes it again.
`;

// ── File names ────────────────────────────────────────────────────────────────

export type SyncFileName =
  | { kind: 'year'; year: number; gzip: boolean }
  | { kind: 'machine' }
  /** A copy Drive made of a file edited in two places, such as `2026 (1).json`. */
  | { kind: 'conflict' }
  /** A file being written, or anything else (`desktop.ini`, `.DS_Store`). */
  | { kind: 'ignored' };

export function classifySyncFile(name: string): SyncFileName {
  if (name === MACHINE_FILE) return { kind: 'machine' };
  const year = /^(\d{4})\.json(\.gz)?$/.exec(name);
  if (year) return { kind: 'year', year: Number(year[1]), gzip: year[2] !== undefined };
  if (/\.tmp$/i.test(name)) return { kind: 'ignored' };
  if (/^(\d{4}|machine)\b.*\.json/i.test(name)) return { kind: 'conflict' };
  return { kind: 'ignored' };
}

/** A machine id usable as a folder name. */
export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

// ── Reading ───────────────────────────────────────────────────────────────────

export type ParseFailure =
  /** Not complete JSON: Drive may still be downloading it. */
  | 'json'
  /** Valid JSON, but not a file of this format. */
  | 'format'
  /** Written by a newer version of the app. */
  | 'newerVersion'
  /** The file says it belongs to another machine or another year than its name. */
  | 'mismatch';

export type ParseResult<T> =
  { ok: true; value: T; skippedRows: number } | { ok: false; reason: ParseFailure };

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isName = (value: unknown, max = MAX_NAME): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isModelRow(value: unknown): value is ModelRow {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    isName(value[0]) &&
    value.slice(1).every(isCount) &&
    (value[5] as number) <= (value[3] as number)
  );
}

function isHourlyRow(value: unknown, year: number): value is HourlyRow {
  if (!Array.isArray(value) || value.length !== 12) return false;
  const [day, hour, project, model, kind, agentType] = value as unknown[];
  return (
    isDay(day) &&
    yearOf(day) === year &&
    isCount(hour) &&
    hour < 24 &&
    isName(project) &&
    isName(model) &&
    (KINDS as readonly unknown[]).includes(kind) &&
    (kind === 'main' ? agentType === '' : isName(agentType)) &&
    value.slice(6).every(isCount) &&
    (value[10] as number) <= (value[8] as number)
  );
}

function isSessionEntry(value: unknown, year: number): value is SessionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isName(v.id, MAX_ID) &&
    isName(v.project) &&
    isName(v.model) &&
    isTimestamp(v.start) &&
    isTimestamp(v.end) &&
    isDay(v.startDay) &&
    yearOf(v.startDay) === year &&
    [v.messages, v.activeMs, v.subagentCount, v.subagentTokens].every(isCount) &&
    Array.isArray(v.models) &&
    v.models.length > 0 &&
    v.models.every(isModelRow) &&
    Array.isArray(v.projects) &&
    v.projects.every(
      (row) => Array.isArray(row) && row.length === 2 && isName(row[0]) && isCount(row[1]),
    ) &&
    Array.isArray(v.days) &&
    v.days.every(isDay)
  );
}

function isSubagentEntry(value: unknown, year: number): value is SubagentEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isName(v.id, MAX_ID) &&
    isName(v.session, MAX_ID) &&
    isName(v.project) &&
    isName(v.type) &&
    (SUBAGENT_KINDS as readonly unknown[]).includes(v.kind) &&
    isName(v.model) &&
    isTimestamp(v.start) &&
    isTimestamp(v.end) &&
    isDay(v.startDay) &&
    yearOf(v.startDay) === year &&
    [v.calls, v.startupInput, v.activeMs].every(isCount) &&
    Array.isArray(v.models) &&
    v.models.length > 0 &&
    v.models.every(isModelRow)
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** Checks a year file of the machine `machineId`, named after `year`. */
export function parseYearFile(
  text: string,
  machineId: string,
  year: number,
): ParseResult<YearFile> {
  const value = parseJson(text);
  if (value === undefined) return { ok: false, reason: 'json' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'format' };
  }
  const v = value as Record<string, unknown>;
  if (!isCount(v.schemaVersion) || v.schemaVersion < 1) return { ok: false, reason: 'format' };
  if (v.schemaVersion > SYNC_SCHEMA_VERSION) return { ok: false, reason: 'newerVersion' };
  if (v.machineId !== machineId || v.year !== year) return { ok: false, reason: 'mismatch' };
  if (!Array.isArray(v.hourly) || !Array.isArray(v.sessions) || !Array.isArray(v.subagents)) {
    return { ok: false, reason: 'format' };
  }

  let skippedRows = 0;
  const keep = <T>(rows: unknown[], check: (row: unknown, year: number) => row is T): T[] => {
    const kept = rows.filter((row): row is T => check(row, year));
    skippedRows += rows.length - kept.length;
    return kept;
  };
  return {
    ok: true,
    skippedRows,
    value: {
      schemaVersion: v.schemaVersion,
      machineId,
      year,
      hourly: keep(v.hourly, isHourlyRow),
      sessions: keep(v.sessions, isSessionEntry),
      subagents: keep(v.subagents, isSubagentEntry),
    },
  };
}

/** Checks the `machine.json` of the machine folder `machineId`. */
export function parseMachineFile(text: string, machineId: string): ParseResult<MachineFile> {
  const value = parseJson(text);
  if (value === undefined) return { ok: false, reason: 'json' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'format' };
  }
  const v = value as Record<string, unknown>;
  if (!isCount(v.schemaVersion) || v.schemaVersion < 1) return { ok: false, reason: 'format' };
  if (v.schemaVersion > SYNC_SCHEMA_VERSION) return { ok: false, reason: 'newerVersion' };
  if (v.machineId !== machineId) return { ok: false, reason: 'mismatch' };
  if (
    !isName(v.name, 200) ||
    !(PLATFORMS as readonly unknown[]).includes(v.platform) ||
    !isTimestamp(v.lastSync)
  ) {
    return { ok: false, reason: 'format' };
  }
  return {
    ok: true,
    skippedRows: 0,
    value: {
      schemaVersion: v.schemaVersion,
      machineId,
      name: v.name.trim() || machineId.slice(0, 8),
      platform: v.platform as Platform,
      appVersion: isName(v.appVersion, 50) ? v.appVersion : '',
      lastSync: new Date(Date.parse(v.lastSync)).toISOString(),
      years: Array.isArray(v.years) ? v.years.filter(isCount) : [],
    },
  };
}

function modelTokens(row: ModelRow): ModelTokens {
  const [model, input, output, cacheWrite, cacheRead, cacheWrite1h] = row;
  return { model, input, output, cacheWrite, cacheRead, cacheWrite1h };
}

/**
 * The rows of another machine's derived tables, from its year files, with this machine's
 * project aliases applied. A session or run found in two files keeps its first copy.
 */
export function recordsFromYearFiles(
  files: readonly YearFile[],
  aliases: AliasMap,
): MachineRecords {
  const name = (project: string) => applyAliases(project, aliases);
  const hourly: HourlyRecord[] = [];
  const sessions: SessionRecord[] = [];
  const subagents: SubagentRecord[] = [];
  const seenSessions = new Set<string>();
  const seenRuns = new Set<string>();

  for (const file of files) {
    for (const row of file.hourly) {
      const [day, hour, project, model, kind, agentType, ...counts] = row;
      const [input, output, cacheWrite, cacheRead, cacheWrite1h, messages] = counts;
      hourly.push({
        day,
        hour,
        project: name(project),
        model,
        kind,
        agentType,
        input,
        output,
        cacheWrite,
        cacheRead,
        cacheWrite1h,
        messages,
      });
    }
    for (const entry of file.sessions) {
      if (seenSessions.has(entry.id)) continue;
      seenSessions.add(entry.id);
      sessions.push({
        id: entry.id,
        project: name(entry.project),
        model: entry.model,
        startTs: Date.parse(entry.start),
        endTs: Date.parse(entry.end),
        startDay: entry.startDay,
        messages: entry.messages,
        activeMs: entry.activeMs,
        subagentCount: entry.subagentCount,
        subagentTokens: entry.subagentTokens,
        models: entry.models.map(modelTokens),
        projects: entry.projects.map(([project, tokens]) => ({ name: name(project), tokens })),
        days: entry.days,
      });
    }
    for (const entry of file.subagents) {
      const key = `${entry.session}\n${entry.id}`;
      if (seenRuns.has(key)) continue;
      seenRuns.add(key);
      subagents.push({
        sessionId: entry.session,
        agentId: entry.id,
        project: name(entry.project),
        agentType: entry.type,
        kind: entry.kind,
        model: entry.model,
        startTs: Date.parse(entry.start),
        endTs: Date.parse(entry.end),
        startDay: entry.startDay,
        calls: entry.calls,
        startupInput: entry.startupInput,
        activeMs: entry.activeMs,
        models: entry.models.map(modelTokens),
      });
    }
  }
  return { hourly, sessions, subagents };
}
