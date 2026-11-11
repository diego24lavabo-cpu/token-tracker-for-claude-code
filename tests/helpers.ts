import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageDatabase } from '../electron/db';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The `projects` folder of a fixture tree. Read only: copy it before changing anything. */
export function fixtureRoot(name: 'mac' | 'win'): string {
  return path.join(FIXTURES, name, 'projects');
}

const tempDirs: string[] = [];

/** A fresh temporary folder, removed by `cleanupTempDirs`. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tracker-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Copies a fixture tree to a temporary folder and returns its `projects` root. */
export function copyFixture(name: 'mac' | 'win'): string {
  const root = path.join(tempDir(), 'projects');
  fs.cpSync(fixtureRoot(name), root, { recursive: true });
  return root;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function openMemoryDb(timeZone = 'UTC'): UsageDatabase {
  return new UsageDatabase(':memory:', { timeZone, machineName: 'test-machine' });
}

export const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MAC_CWD = '/Users/alex/dev/demo-app';
export const MAC_FOLDER = '-Users-alex-dev-demo-app';

export interface LineOptions {
  /** Short name; the message id is `msg_test_<id>` and the request id `req_test_<id>`. */
  id: string;
  ts?: string;
  session?: string | null;
  cwd?: string | null;
  model?: string;
  /** input, output, cache write, cache read */
  u?: [number, number, number, number];
  stop?: string | null;
  sidechain?: boolean;
  agentId?: string;
  /** How much of the cache write went to the 1-hour cache. Adds the breakdown to the usage. */
  cache1h?: number;
}

/** A synthetic assistant line, shaped like the ones Claude Code writes. */
export function assistantLine(options: LineOptions): string {
  const {
    id,
    ts = '2026-11-10T12:00:00.000Z',
    session = SESSION_A,
    cwd = MAC_CWD,
    model = 'claude-opus-5-5',
    u = [10, 5, 0, 100],
    stop = 'end_turn',
    sidechain = false,
    agentId,
    cache1h,
  } = options;
  return JSON.stringify({
    isSidechain: sidechain,
    ...(cwd ? { cwd } : {}),
    ...(session ? { sessionId: session } : {}),
    ...(agentId ? { agentId } : {}),
    type: 'assistant',
    message: {
      id: `msg_test_${id}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'Synthetic response.' }],
      stop_reason: stop,
      usage: {
        input_tokens: u[0],
        output_tokens: u[1],
        cache_creation_input_tokens: u[2],
        cache_read_input_tokens: u[3],
        ...(cache1h === undefined
          ? {}
          : {
              cache_creation: {
                ephemeral_5m_input_tokens: u[2] - cache1h,
                ephemeral_1h_input_tokens: cache1h,
              },
            }),
      },
    },
    requestId: `req_test_${id}`,
    timestamp: ts,
  });
}

/** Writes lines to a file, creating its folders. Every line ends with a newline. */
export function writeLines(file: string, lines: string[], eol = '\n'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => line + eol).join(''));
}

const TOKENS = 'input + output + cache_write + cache_read';

type Table = 'messages' | 'hourly' | 'sessions' | 'subagents';

/** Sum of all four token types in a table, optionally filtered. */
export function tokenTotal(db: UsageDatabase, table: Table = 'messages', where = '1'): number {
  const row = db.raw
    .prepare(`SELECT COALESCE(SUM(${TOKENS}), 0) AS total FROM ${table} WHERE ${where}`)
    .get() as { total: number };
  return row.total;
}

/** Token totals of a table grouped by one column, as `{ value: total }`. */
export function tokensBy(db: UsageDatabase, table: Table, column: string): Record<string, number> {
  const rows = db.raw
    .prepare(`SELECT ${column} AS name, SUM(${TOKENS}) AS total FROM ${table} GROUP BY ${column}`)
    .all() as { name: string; total: number }[];
  return Object.fromEntries(rows.map((row) => [row.name, row.total]));
}

export function rowCount(db: UsageDatabase, table: string, where = '1'): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
    n: number;
  };
  return row.n;
}
