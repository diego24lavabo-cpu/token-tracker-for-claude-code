/**
 * Claude Code's own 5-hour usage, as it caches it in its config file (`~/.claude.json`,
 * key `cachedUsageUtilization`) after fetching it for `/usage` or the usage panel.
 *
 * Privacy and safety rules, because that file also holds account details (and an API key
 * for API-key users):
 * - read only, never written, and only while the Settings switch is on;
 * - only `cachedUsageUtilization.fetchedAtMs` and `.utilization.five_hour.{utilization,
 *   resets_at}` are kept; the rest of the parsed file is dropped at once;
 * - nothing from the file is ever logged: a JSON parse error message quotes the text
 *   around the error, so errors become a plain state (`unreadable`);
 * - a file over `MAX_BYTES` is not read.
 * The format is not documented and may change: anything unexpected gives `noData` or
 * `unreadable`, never a throw.
 */
import fs from 'node:fs';
import type { ClaudeUsage, ClaudeUsageState } from '../shared/types';

/** Larger than any real config file (about 150 KB here); keeps a huge file from being parsed. */
export const MAX_BYTES = 32 * 1024 * 1024;

/** Reset times before 2020 or after 2100 are not real ones. */
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property only, so a key named like an `Object.prototype` member is never read. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function plausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_TIME && ms <= MAX_TIME;
}

/** An ISO date string, or a Unix time in seconds or milliseconds. */
function timeOf(value: unknown): number | null {
  let ms: number;
  if (typeof value === 'string' && value.length <= 64) ms = Date.parse(value);
  else if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else return null;
  return plausibleTime(ms) ? ms : null;
}

/**
 * The 5-hour numbers of a parsed config file, or null when it has none in the expected
 * format. Takes the whole parsed file and returns only three numbers.
 */
export function parseClaudeUsage(config: unknown): ClaudeUsage | null {
  if (!isRecord(config)) return null;
  const cache = own(config, 'cachedUsageUtilization');
  if (!isRecord(cache)) return null;
  const utilization = own(cache, 'utilization');
  if (!isRecord(utilization)) return null;
  const fiveHour = own(utilization, 'five_hour');
  if (!isRecord(fiveHour)) return null;

  // Numbers fetched for another account than the one signed in now (after a switch) are
  // not this account's. Neither id is kept.
  const cachedAccount = own(cache, 'accountUuid');
  const oauth = own(config, 'oauthAccount');
  const currentAccount = isRecord(oauth) ? own(oauth, 'accountUuid') : undefined;
  if (
    typeof cachedAccount === 'string' &&
    typeof currentAccount === 'string' &&
    cachedAccount !== currentAccount
  ) {
    return null;
  }

  const fetchedAt = own(cache, 'fetchedAtMs');
  const percent = own(fiveHour, 'utilization');
  const resetsAt = timeOf(own(fiveHour, 'resets_at'));
  if (typeof fetchedAt !== 'number' || !plausibleTime(fetchedAt)) return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  if (resetsAt === null) return null;
  return { fetchedAt, percent: Math.min(percent, 100), resetsAt };
}

/**
 * True while the numbers describe the running 5-hour window: its reset is still ahead, and
 * they were fetched during that window (not later than now, give or take a minute of
 * clock difference).
 */
export function isFresh(usage: ClaudeUsage, now: number): boolean {
  return (
    usage.resetsAt > now &&
    usage.fetchedAt > usage.resetsAt - 5 * 60 * 60_000 &&
    usage.fetchedAt <= now + 60_000
  );
}

export interface ClaudeUsageRead {
  state: Exclude<ClaudeUsageState, 'off'>;
  usage: ClaudeUsage | null;
}

const UNREADABLE: ClaudeUsageRead = { state: 'unreadable', usage: null };
const MISSING: ClaudeUsageRead = { state: 'missing', usage: null };

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/**
 * Opens without blocking on POSIX, where a FIFO in place of the file would otherwise wait
 * for a writer forever. Windows has no such flag; `ClaudeUsageReader` has a timeout.
 */
const OPEN_FLAGS =
  process.platform === 'win32'
    ? fs.constants.O_RDONLY
    : fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** Reads the file once. Never throws. */
export async function readClaudeUsage(
  file: string,
  maxBytes = MAX_BYTES,
): Promise<ClaudeUsageRead> {
  // Only a regular file of a sane size is opened.
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > maxBytes) return UNREADABLE;
  } catch (error) {
    return isMissing(error) ? MISSING : UNREADABLE;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, OPEN_FLAGS);
  } catch (error) {
    return isMissing(error) ? MISSING : UNREADABLE;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return UNREADABLE;
    // At most the size seen now: a file growing meanwhile is cut, fails to parse, and is
    // read again at its next change.
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const text = buffer.toString('utf8', 0, read);
    let config: unknown;
    try {
      config = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
    } catch {
      // The message would quote the file: not kept.
      return UNREADABLE;
    }
    const usage = parseClaudeUsage(config);
    return { state: usage ? 'found' : 'noData', usage };
  } catch {
    return UNREADABLE;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How long a page waits for the file before going on without Claude's numbers. */
export const READ_TIMEOUT_MS = 2_000;

/**
 * Reads the file again only when its size or modification time changed. Claude Code
 * rewrites the file often (it holds much more than the usage), so most reads are a `stat`.
 * A read that takes longer than `timeoutMs` (a stalled network folder) answers
 * `unreadable`, and while it is still stuck later calls answer at once, so the Live and
 * Settings pages never wait on it.
 */
export class ClaudeUsageReader {
  private key: string | null = null;
  private last: ClaudeUsageRead = MISSING;
  private pending: Promise<ClaudeUsageRead> | null = null;
  private pendingSince = 0;
  /** Bumped by `forget`, so a read still running then does not store its result. */
  private generation = 0;

  constructor(
    private readonly file: () => string,
    private readonly timeoutMs = READ_TIMEOUT_MS,
  ) {}

  read(): Promise<ClaudeUsageRead> {
    if (this.pending && Date.now() - this.pendingSince >= this.timeoutMs) {
      return Promise.resolve(UNREADABLE);
    }
    if (!this.pending) {
      // Calls during a read share it.
      this.pendingSince = Date.now();
      this.pending = this.readNow().finally(() => {
        this.pending = null;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ClaudeUsageRead>((resolve) => {
      timer = setTimeout(() => resolve(UNREADABLE), this.timeoutMs);
    });
    return Promise.race([this.pending, timeout]).finally(() => clearTimeout(timer));
  }

  /** Forgets the cached copy (the switch was turned off). */
  forget(): void {
    this.generation += 1;
    this.key = null;
    this.last = MISSING;
  }

  private async readNow(): Promise<ClaudeUsageRead> {
    const generation = this.generation;
    const file = this.file();
    let key: string | null = null;
    try {
      const stat = await fs.promises.stat(file);
      key = `${file}\n${stat.size}\n${stat.mtimeMs}`;
    } catch {
      // Missing or unreachable: read below says which.
    }
    if (key !== null && key === this.key) return this.last;
    const result = await readClaudeUsage(file);
    if (generation !== this.generation) return result;
    this.key = key;
    this.last = result;
    return result;
  }
}
