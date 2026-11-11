/**
 * Parsing of Claude Code transcript lines (JSONL).
 *
 * The format is not documented and changes between Claude Code versions, so everything
 * here is defensive: a line that cannot be understood is reported, never thrown.
 * Only the usage numbers of assistant records are read. Prompt and response text is
 * never kept.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TokenBreakdown } from '../shared/types';

export const UNKNOWN_MODEL = 'unknown';
export const UNKNOWN_PROJECT = 'unknown';

/** Model id written by Claude Code for messages it produced itself, such as error notices. */
const SYNTHETIC_MODEL = '<synthetic>';

/** One assistant response with usage, as read from a transcript line. */
export interface UsageRecord {
  /** Identifies the API response across streamed copies and resumed sessions. */
  dedupKey: string;
  /** UTC, milliseconds since the epoch. */
  timestamp: number;
  /** `sessionId` of the record. In a subagent transcript it is the parent session. */
  sessionId: string | null;
  cwd: string | null;
  /** Raw model id, for example `claude-opus-5-5`. */
  modelId: string;
  isSidechain: boolean;
  agentId: string | null;
  stopReason: string | null;
  tokens: TokenBreakdown;
  /**
   * The part of `tokens.cacheWrite` written to the 1-hour cache, which is billed at a
   * higher rate than the default 5-minute cache. Zero when the log does not say.
   */
  cacheWrite1h: number;
}

export type IgnoredReason = 'other-type' | 'synthetic' | 'empty-usage';

export type SkippedReason =
  'invalid-json' | 'not-an-object' | 'missing-usage' | 'invalid-usage' | 'invalid-timestamp';

export type ParsedLine =
  | { kind: 'usage'; record: UsageRecord }
  /** A valid line that carries no usage: user messages, tool results, metadata. */
  | { kind: 'ignored'; reason: IgnoredReason }
  /** A line that should have been readable but was not. These are counted as warnings. */
  | { kind: 'skipped'; reason: SkippedReason };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** Newer logs split cache writes by lifetime; their sum is the total written. */
function sumCacheCreation(value: unknown): number | null {
  if (!isObject(value)) return null;
  let total: number | null = null;
  for (const [key, part] of Object.entries(value)) {
    if (!key.endsWith('_input_tokens')) continue;
    const count = tokenCount(part);
    if (count !== null) total = (total ?? 0) + count;
  }
  return total;
}

function readTokens(usage: JsonObject): { tokens: TokenBreakdown; cacheWrite1h: number } | null {
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite =
    tokenCount(usage.cache_creation_input_tokens) ?? sumCacheCreation(usage.cache_creation);

  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;

  const oneHour = isObject(usage.cache_creation)
    ? tokenCount(usage.cache_creation.ephemeral_1h_input_tokens)
    : null;
  return {
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      cacheWrite: cacheWrite ?? 0,
      cacheRead: cacheRead ?? 0,
    },
    cacheWrite1h: Math.min(oneHour ?? 0, cacheWrite ?? 0),
  };
}

/** Accepts ISO strings and epoch numbers (seconds or milliseconds). */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  return null;
}

/**
 * Parses one transcript line.
 *
 * Only `type: "assistant"` records with `message.usage` count. In particular the rollup
 * that a parent session stores in a tool result after a subagent run (`toolUseResult`
 * with `totalTokens` and a `usage` object) is a `user` record and is ignored: its tokens
 * already appear in the subagent's own transcript.
 */
export function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'skipped', reason: 'invalid-json' };
  }
  if (!isObject(value)) return { kind: 'skipped', reason: 'not-an-object' };
  if (value.type !== 'assistant') return { kind: 'ignored', reason: 'other-type' };

  const message = value.message;
  if (isObject(message) && message.model === SYNTHETIC_MODEL) {
    return { kind: 'ignored', reason: 'synthetic' };
  }
  if (!isObject(message) || !isObject(message.usage)) {
    return { kind: 'skipped', reason: 'missing-usage' };
  }

  const usage = readTokens(message.usage);
  if (!usage) return { kind: 'skipped', reason: 'invalid-usage' };
  const { tokens, cacheWrite1h } = usage;
  if (tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead === 0) {
    return { kind: 'ignored', reason: 'empty-usage' };
  }

  const timestamp = parseTimestamp(value.timestamp);
  if (timestamp === null) return { kind: 'skipped', reason: 'invalid-timestamp' };

  const messageId = nonEmptyString(message.id);
  const requestId = nonEmptyString(value.requestId);

  return {
    kind: 'usage',
    record: {
      dedupKey: dedupKey(messageId, requestId, line),
      timestamp,
      sessionId: nonEmptyString(value.sessionId),
      cwd: nonEmptyString(value.cwd),
      modelId: nonEmptyString(message.model) ?? UNKNOWN_MODEL,
      isSidechain: value.isSidechain === true,
      agentId: nonEmptyString(value.agentId),
      stopReason: nonEmptyString(message.stop_reason),
      tokens,
      cacheWrite1h,
    },
  };
}

/**
 * A streamed response is written as several lines that repeat the same `message.id`, and
 * resumed sessions copy earlier lines into a new file. The key is `message.id + requestId`,
 * then `message.id` alone, then a hash of the line.
 */
function dedupKey(messageId: string | null, requestId: string | null, line: string): string {
  if (messageId && requestId) return `${messageId}:${requestId}`;
  if (messageId) return messageId;
  return `line:${createHash('sha1').update(line).digest('hex')}`;
}

// ── Model names ───────────────────────────────────────────────────────────────

/** Display names for ids that do not follow the generic pattern. */
const MODEL_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  'claude-2.0': 'Claude 2',
  'claude-2.1': 'Claude 2.1',
  'claude-instant-1.2': 'Claude Instant 1.2',
};

/** `claude-<family>-<major>[-<minor>][-<date>]`, for example `claude-opus-5-5`. */
const MODEL_PATTERN = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;
/** Older order `claude-<major>[-<minor>]-<family>[-<date>]`, for example `claude-3-5-sonnet-20241022`. */
const LEGACY_MODEL_PATTERN = /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;

/** Removes what cloud providers and Claude Code add around the model id. */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const start = id.lastIndexOf('claude-');
  if (start > 0) id = id.slice(start); // "us.anthropic.claude-…"
  id = id.replace(/\[[^\]]*\]$/, ''); // "…[1m]"
  id = id.replace(/@(\d{8})$/, '-$1'); // "…@20250929"
  id = id.replace(/-v\d+(?::\d+)?$/, ''); // "…-v1:0"
  id = id.replace(/-latest$/, '');
  return id;
}

/**
 * Display name of a model, derived with a generic rule so that future models show up
 * correctly without a code change: `claude-opus-5-5` → `Opus 5.5`.
 * An id that does not match is shown as it is.
 */
export function modelDisplayName(modelId: string): string {
  const raw = modelId.trim();
  if (!raw) return UNKNOWN_MODEL;

  const id = normalizeModelId(raw);
  const override = MODEL_NAME_OVERRIDES[id];
  if (override) return override;

  let family: string | undefined;
  let major: string | undefined;
  let minor: string | undefined;
  const current = MODEL_PATTERN.exec(id);
  if (current) {
    [, family, major, minor] = current;
  } else {
    const legacy = LEGACY_MODEL_PATTERN.exec(id);
    if (legacy) [, major, minor, family] = legacy;
  }
  if (!family || !major) return raw;

  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return minor === undefined ? `${name} ${major}` : `${name} ${major}.${minor}`;
}

// ── Project names ─────────────────────────────────────────────────────────────

/**
 * Windows and POSIX paths are told apart by their shape, not by the current platform,
 * so a Mac can read records written on Windows and the other way round.
 */
function pathFlavor(target: string): path.PlatformPath {
  const isWindows =
    /^[a-zA-Z]:[\\/]/.test(target) ||
    target.startsWith('\\\\') ||
    (target.includes('\\') && !target.includes('/'));
  return isWindows ? path.win32 : path.posix;
}

function stripTrailingSeparators(target: string): string {
  return target.length > 1 ? target.replace(/[\\/]+$/, '') : target;
}

/** How Claude Code turns a working directory into a folder name under `projects/`. */
export function encodeProjectPath(target: string): string {
  return target.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Name of the project a session folder stands for, recovered from a record's `cwd`.
 *
 * The folder name encodes the directory where the session was started, but the encoding
 * loses information (`demo-app` and `demo/app` look the same). The `cwd` of a record is
 * that directory or, once the shell has moved, one of its subfolders. Walking up from
 * `cwd` until the encoded path matches the folder name gives the project directory back.
 *
 * Returns null when no parent of `cwd` matches, for example after a `cd` to another tree.
 */
export function projectNameFromSessionFolder(cwd: string, folderName: string): string | null {
  return locateInSessionFolder(cwd, folderName)?.project ?? null;
}

export interface SessionFolderLocation {
  /** Name of the directory the session folder stands for. */
  project: string;
  /**
   * Name of the directory directly under it that `cwd` is in, or an empty string when
   * `cwd` is the project directory itself. `…/demo-app/packages/web` → `packages`.
   */
  subfolder: string;
}

/** Where a record's `cwd` sits relative to the directory its session folder stands for. */
export function locateInSessionFolder(
  cwd: string,
  folderName: string,
): SessionFolderLocation | null {
  if (!folderName) return null;
  const flavor = pathFlavor(cwd);
  const target = folderName.toLowerCase();
  let current = stripTrailingSeparators(flavor.normalize(cwd));
  let subfolder = '';
  for (;;) {
    if (encodeProjectPath(current).toLowerCase() === target) {
      const project = flavor.basename(current);
      return project ? { project, subfolder } : null;
    }
    const parent = flavor.dirname(current);
    if (parent === current) return null;
    subfolder = flavor.basename(current);
    current = parent;
  }
}

/** `basename(cwd)`, with the separator style of the path itself. */
export function projectNameFromCwd(cwd: string): string | null {
  const flavor = pathFlavor(cwd);
  return flavor.basename(stripTrailingSeparators(flavor.normalize(cwd))) || null;
}

/**
 * Last resort when no record of a folder has a `cwd`: the last segment of the encoded
 * folder name. `C--Users-alex-dev-demo-app` → `app`, because hyphens are ambiguous.
 */
export function projectNameFromFolder(folderName: string): string {
  const segments = folderName.split('-').filter(Boolean);
  return segments[segments.length - 1] ?? UNKNOWN_PROJECT;
}
