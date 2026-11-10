import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageDatabase } from '../electron/db';
import { formatSummary, scanLogs } from '../electron/scanner';
import {
  assistantLine,
  cleanupTempDirs,
  copyFixture,
  fixtureRoot,
  MAC_FOLDER,
  openMemoryDb,
  rowCount,
  SESSION_A,
  SESSION_B,
  tempDir,
  tokensBy,
  tokenTotal,
  writeLines,
} from './helpers';

const open: UsageDatabase[] = [];

function database(timeZone = 'UTC'): UsageDatabase {
  const db = openMemoryDb(timeZone);
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

// ── What the fixtures contain ────────────────────────────────────────────────
//
// mac/projects, session 1111 (project demo-app), all on 2026-11-10 around 12:00 UTC
//   main session, 5 responses                       660 in   195 out   1500 cw  13100 cr = 15455
//     of which Sonnet 5.5 (1 response)                                                   =   570
//   Explore        task      Haiku 5.5   3 calls     40 in   100 out   7200 cw  14200 cr = 21540
//   (no meta)      task      Sonnet 5.5  1 call      20 in    15 out   3000 cw      0 cr =  3035
//   general-purp.  warm-up   Haiku 5.5   1 call       8 in     1 out      0 cw   4000 cr =  4009
//   /btw           aside     Opus 5.5    1 call      15 in    25 out      0 cw  12000 cr = 12040
//   build-check    workflow  Sonnet 5.5  2 calls     18 in    52 out   2100 cw   2100 cr =  4270
// mac/projects, session 2222 (project demo-app), legacy inline sidechains, 2026-11-09 09:00 UTC
//   main session, 2 responses (Opus 5.5)            100 in    50 out      0 cw   2100 cr =  2250
//   legacyagent01  task      Sonnet 5.5  2 calls     14 in    11 out    600 cw    600 cr =  1225
//   inline bucket  task      Sonnet 5.5  2 calls      8 in    12 out      0 cw    180 cr =   200
// mac/projects, session 3333 (Fable 5.2), 2026-11-10 23:30 UTC
//   other-tool, 2 responses                                                              =  1010
//   scratch-pad, 1 response (cwd outside the session folder)                             =   100
// win/projects, session 4444 (project demo-app), 2026-11-08 10:00 UTC
//   main session, 3 responses (Opus 5.5)             60 in    40 out      0 cw   1000 cr =  1100
//   Plan           task      Sonnet 5.5  1 call       9 in    11 out    180 cw      0 cr =   200

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';

const MAC_TOKENS = { input: 959, output: 497, cacheWrite: 14400, cacheRead: 49278 };
const MAC_TOTAL = 65134;
const WIN_TOTAL = 1300;

const at = (iso: string) => Date.parse(iso);

describe('scanning the macOS fixture', () => {
  it('counts every response once', async () => {
    const db = database();
    const summary = await scanLogs(db, [fixtureRoot('mac')]);

    expect(summary).toMatchObject({
      filesFound: 8,
      subagentFilesFound: 5,
      filesRead: 8,
      filesUnchanged: 0,
      filesFailed: 0,
      linesRead: 41,
      usageRecords: 28,
      imported: 22,
      duplicates: 5,
      upgraded: 1,
      skippedLines: 5,
    });
    expect(summary.database).toEqual({
      messages: 22,
      sessions: 3,
      subagentRuns: 7,
      projects: 3,
      models: 4,
      tokens: MAC_TOKENS,
      files: 8,
      subagentFiles: 5,
      skippedLines: 5,
    });
    expect(tokenTotal(db)).toBe(MAC_TOTAL);
  });

  it('never counts the rollup a parent stores after a subagent run', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    // The rollup claims 99999 tokens; the subagent's own transcript says 21540.
    expect(tokenTotal(db, 'subagents', "agent_id = 'a1b2c3d4e5f60001'")).toBe(21540);
    expect(tokenTotal(db, 'messages', `session_id = '${S1}' AND agent_id IS NULL`)).toBe(15455);
    expect(rowCount(db, 'messages', 'input >= 11111')).toBe(0);
  });

  it('skips broken lines without losing the rest of the file', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    const file = db.raw
      .prepare(
        'SELECT lines, usage_records, skipped FROM files WHERE path LIKE ? AND is_subagent = 0',
      )
      .get(`%${S1}.jsonl`);
    expect(file).toEqual({ lines: 18, usage_records: 8, skipped: 5 });
    expect(rowCount(db, 'messages', `session_id = '${S1}' AND agent_id IS NULL`)).toBe(5);
  });

  it('keeps the complete counts of a response streamed in several lines', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    expect(
      db.raw
        .prepare('SELECT output, stop_reason FROM messages WHERE dedup_key = ?')
        .get('msg_demo_main_005:req_demo_main_005'),
    ).toEqual({ output: 40, stop_reason: 'end_turn' });
  });

  it('names projects after the session folder', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    expect(tokensBy(db, 'messages', 'project')).toEqual({
      'demo-app': 60349 + 3675,
      'other-tool': 1010,
      'scratch-pad': 100,
    });
    // A cwd in a subfolder of the project stays in the project.
    expect(
      db.raw
        .prepare('SELECT project FROM messages WHERE dedup_key = ?')
        .pluck()
        .get('msg_demo_main_004:req_demo_main_004'),
    ).toBe('demo-app');
    // A record without cwd takes the project of its session folder.
    expect(
      db.raw
        .prepare('SELECT project FROM messages WHERE dedup_key = ?')
        .pluck()
        .get('msg_demo_oth_003:req_demo_oth_003'),
    ).toBe('other-tool');
  });

  it('derives model names and merges dated ids', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    expect(tokensBy(db, 'messages', 'model')).toEqual({
      'Opus 5.5': 29175,
      'Sonnet 5.5': 9300,
      'Haiku 5.5': 25549,
      'Fable 5.2': 1110,
    });
    expect(
      db.raw
        .prepare("SELECT DISTINCT model_id FROM messages WHERE model = 'Haiku 5.5'")
        .pluck()
        .all(),
    ).toEqual(['claude-haiku-5-5-20261001']);
  });

  it('describes each subagent invocation', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    const noon = (time: string) => at(`2026-11-10T${time}Z`);

    expect(db.listSubagents()).toEqual([
      {
        sessionId: S2,
        agentId: 'legacyagent01',
        project: 'demo-app',
        agentType: 'unknown',
        kind: 'task',
        model: 'Sonnet 5.5',
        startTs: at('2026-11-09T09:01:00Z'),
        endTs: at('2026-11-09T09:02:00Z'),
        calls: 2,
        startupInput: 610,
        tokens: { input: 14, output: 11, cacheWrite: 600, cacheRead: 600 },
      },
      {
        sessionId: S2,
        agentId: 'inline',
        project: 'demo-app',
        agentType: 'unknown',
        kind: 'task',
        model: 'Sonnet 5.5',
        startTs: at('2026-11-09T09:03:00Z'),
        endTs: at('2026-11-09T09:04:00Z'),
        calls: 2,
        startupInput: 97,
        tokens: { input: 8, output: 12, cacheWrite: 0, cacheRead: 180 },
      },
      {
        sessionId: S1,
        agentId: 'a1b2c3d4e5f60001',
        project: 'demo-app',
        agentType: 'Explore',
        kind: 'task',
        model: 'Haiku 5.5',
        startTs: noon('12:05:10'),
        endTs: noon('12:06:45'),
        calls: 3,
        startupInput: 7030,
        tokens: { input: 40, output: 100, cacheWrite: 7200, cacheRead: 14200 },
      },
      {
        sessionId: S1,
        agentId: 'a1b2c3d4e5f60002',
        project: 'demo-app',
        agentType: 'unknown',
        kind: 'task',
        model: 'Sonnet 5.5',
        startTs: noon('12:07:00'),
        endTs: noon('12:07:00'),
        calls: 1,
        startupInput: 3020,
        tokens: { input: 20, output: 15, cacheWrite: 3000, cacheRead: 0 },
      },
      {
        sessionId: S1,
        agentId: 'a1b2c3d4e5f60003',
        project: 'demo-app',
        agentType: 'general-purpose',
        kind: 'warmup',
        model: 'Haiku 5.5',
        startTs: noon('12:08:00'),
        endTs: noon('12:08:00'),
        calls: 1,
        startupInput: 4008,
        tokens: { input: 8, output: 1, cacheWrite: 0, cacheRead: 4000 },
      },
      {
        sessionId: S1,
        agentId: 'aside_question-a1b2c3d4e5f60004',
        project: 'demo-app',
        agentType: 'aside_question',
        kind: 'aside',
        model: 'Opus 5.5',
        startTs: noon('12:15:00'),
        endTs: noon('12:15:00'),
        calls: 1,
        startupInput: 12015,
        tokens: { input: 15, output: 25, cacheWrite: 0, cacheRead: 12000 },
      },
      {
        sessionId: S1,
        agentId: 'a1b2c3d4e5f60005',
        project: 'demo-app',
        agentType: 'build-check',
        kind: 'workflow',
        model: 'Sonnet 5.5',
        startTs: noon('12:30:00'),
        endTs: noon('12:31:00'),
        calls: 2,
        startupInput: 2112,
        tokens: { input: 18, output: 52, cacheWrite: 2100, cacheRead: 2100 },
      },
    ]);
  });

  it('keeps /btw history with the main session it repeats', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    // The aside transcript repeats two parent responses; only its own answer is its own.
    expect(rowCount(db, 'messages', "agent_id = 'aside_question-a1b2c3d4e5f60004'")).toBe(1);
    expect(
      db.raw
        .prepare(
          "SELECT kind, agent_id FROM messages WHERE dedup_key LIKE 'msg_demo_main_00%' GROUP BY 1, 2",
        )
        .all(),
    ).toEqual([{ kind: 'main', agent_id: null }]);
  });

  it('splits usage by kind in the hourly aggregates', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({
      main: 15455 + 2250 + 1110,
      task: 21540 + 3035 + 1225 + 200,
      warmup: 4009,
      aside: 12040,
      workflow: 4270,
    });
    expect(
      db.raw
        .prepare(
          `SELECT model, kind, agent_type, input, output, cache_write, cache_read, messages
           FROM hourly WHERE local_day = '2026-11-10' AND local_hour = 12 AND project = 'demo-app'
           ORDER BY kind, model`,
        )
        .all(),
    ).toEqual([
      {
        model: 'Opus 5.5',
        kind: 'aside',
        agent_type: 'aside_question',
        input: 15,
        output: 25,
        cache_write: 0,
        cache_read: 12000,
        messages: 1,
      },
      {
        model: 'Opus 5.5',
        kind: 'main',
        agent_type: '',
        input: 610,
        output: 175,
        cache_write: 1000,
        cache_read: 13100,
        messages: 4,
      },
      {
        model: 'Sonnet 5.5',
        kind: 'main',
        agent_type: '',
        input: 50,
        output: 20,
        cache_write: 500,
        cache_read: 0,
        messages: 1,
      },
      {
        model: 'Haiku 5.5',
        kind: 'task',
        agent_type: 'Explore',
        input: 40,
        output: 100,
        cache_write: 7200,
        cache_read: 14200,
        messages: 3,
      },
      {
        model: 'Sonnet 5.5',
        kind: 'task',
        agent_type: 'unknown',
        input: 20,
        output: 15,
        cache_write: 3000,
        cache_read: 0,
        messages: 1,
      },
      {
        model: 'Haiku 5.5',
        kind: 'warmup',
        agent_type: 'general-purpose',
        input: 8,
        output: 1,
        cache_write: 0,
        cache_read: 4000,
        messages: 1,
      },
      {
        model: 'Sonnet 5.5',
        kind: 'workflow',
        agent_type: 'build-check',
        input: 18,
        output: 52,
        cache_write: 2100,
        cache_read: 2100,
        messages: 2,
      },
    ]);
  });

  it('summarizes sessions, subagents included', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    const sessions = db.raw
      .prepare(
        `SELECT session_id, project, model, start_ts, end_ts, start_day, messages,
                input, output, cache_write, cache_read, subagent_count, subagent_tokens
         FROM sessions ORDER BY start_ts`,
      )
      .all();
    expect(sessions).toEqual([
      {
        session_id: S2,
        project: 'demo-app',
        model: 'Opus 5.5',
        start_ts: at('2026-11-09T09:00:00Z'),
        end_ts: at('2026-11-09T09:10:00Z'),
        start_day: '2026-11-09',
        messages: 2,
        input: 122,
        output: 73,
        cache_write: 600,
        cache_read: 2880,
        subagent_count: 2,
        subagent_tokens: 1425,
      },
      {
        session_id: S1,
        project: 'demo-app',
        model: 'Opus 5.5',
        // The main session ends at 12:25; the workflow agent that ran until 12:31 is excluded.
        start_ts: at('2026-11-10T12:00:00Z'),
        end_ts: at('2026-11-10T12:25:00Z'),
        start_day: '2026-11-10',
        messages: 5,
        input: 761,
        output: 388,
        cache_write: 13800,
        cache_read: 45400,
        // Explore, the agent without meta, /btw and the workflow agent. Not the warm-up.
        subagent_count: 4,
        subagent_tokens: 44894,
      },
      {
        session_id: S3,
        project: 'other-tool',
        model: 'Fable 5.2',
        start_ts: at('2026-11-10T23:30:00Z'),
        end_ts: at('2026-11-10T23:50:00Z'),
        start_day: '2026-11-10',
        messages: 3,
        input: 76,
        output: 36,
        cache_write: 0,
        cache_read: 998,
        subagent_count: 0,
        subagent_tokens: 0,
      },
    ]);
  });

  it('buckets days and hours in the local time zone', async () => {
    const paris = database('Europe/Paris');
    await scanLogs(paris, [fixtureRoot('mac')]);
    const lateSession = (db: UsageDatabase) =>
      db.raw
        .prepare("SELECT DISTINCT local_day, local_hour FROM hourly WHERE model = 'Fable 5.2'")
        .all();
    expect(lateSession(paris)).toEqual([{ local_day: '2026-11-11', local_hour: 0 }]);
    expect(
      paris.raw.prepare('SELECT start_day FROM sessions WHERE session_id = ?').pluck().get(S3),
    ).toBe('2026-11-11');

    const losAngeles = database('America/Los_Angeles');
    await scanLogs(losAngeles, [fixtureRoot('mac')]);
    expect(lateSession(losAngeles)).toEqual([{ local_day: '2026-11-10', local_hour: 15 }]);
    // The stored timestamps are the same UTC instants in both databases.
    const timestamps = (db: UsageDatabase) =>
      db.raw.prepare('SELECT ts FROM messages ORDER BY dedup_key').pluck().all();
    expect(timestamps(paris)).toEqual(timestamps(losAngeles));
  });

  it('keeps prompt, response and tool text out of the database', async () => {
    const db = database();
    await scanLogs(db, [fixtureRoot('mac')]);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
    for (const table of tables) {
      const content = JSON.stringify(db.raw.prepare(`SELECT * FROM ${table}`).all());
      expect(content).not.toContain('Synthetic response');
      expect(content).not.toContain('Synthetic prompt');
      expect(content).not.toContain('Synthetic result');
      expect(content).not.toContain('Synthetic notice');
      // Subagent descriptions are kept, in one local table only.
      expect(content.includes('Synthetic task description')).toBe(table === 'agent_meta');
    }
  });
});

describe('scanning the Windows fixture', () => {
  it('reads Windows paths on any platform', async () => {
    const db = database();
    const summary = await scanLogs(db, [fixtureRoot('win')]);
    expect(summary).toMatchObject({
      filesFound: 2,
      subagentFilesFound: 1,
      imported: 4,
      skippedLines: 0,
    });
    expect(tokensBy(db, 'messages', 'project')).toEqual({ 'demo-app': WIN_TOTAL });
    expect(db.listSubagents()).toEqual([
      {
        sessionId: S4,
        agentId: 'b1b2c3d4e5f60001',
        project: 'demo-app',
        agentType: 'Plan',
        kind: 'task',
        model: 'Sonnet 5.5',
        startTs: at('2026-11-08T10:02:00Z'),
        endTs: at('2026-11-08T10:02:00Z'),
        calls: 1,
        startupInput: 189,
        tokens: { input: 9, output: 11, cacheWrite: 180, cacheRead: 0 },
      },
    ]);
  });

  it('decodes the folder name when no record has a cwd', async () => {
    const root = path.join(tempDir(), 'projects');
    writeLines(path.join(root, 'C--Users-alex-dev-tracker', `${SESSION_A}.jsonl`), [
      assistantLine({ id: 'a', cwd: null }),
    ]);
    const db = database();
    await scanLogs(db, [root]);
    expect(tokensBy(db, 'messages', 'project')).toEqual({ tracker: 115 });
  });
});

describe('scanning several roots', () => {
  it('merges projects with the same name and keeps every total consistent', async () => {
    const db = database();
    const summary = await scanLogs(db, [fixtureRoot('mac'), fixtureRoot('win')]);
    const total = MAC_TOTAL + WIN_TOTAL;

    expect(summary.filesFound).toBe(10);
    expect(tokensBy(db, 'messages', 'project')['demo-app']).toBe(60349 + 3675 + WIN_TOTAL);

    const sum = (totals: Record<string, number>) =>
      Object.values(totals).reduce((a, b) => a + b, 0);
    const byKind = tokensBy(db, 'hourly', 'kind');
    const mainTokens = byKind.main ?? 0;

    // Overview total = sum of projects = sum of models = main + subagents = sum of machines.
    expect(tokenTotal(db, 'messages')).toBe(total);
    expect(tokenTotal(db, 'hourly')).toBe(total);
    expect(tokenTotal(db, 'sessions')).toBe(total);
    expect(sum(tokensBy(db, 'hourly', 'project'))).toBe(total);
    expect(sum(tokensBy(db, 'hourly', 'model'))).toBe(total);
    expect(sum(tokensBy(db, 'hourly', 'machine_id'))).toBe(total);
    expect(sum(tokensBy(db, 'hourly', 'local_day'))).toBe(total);
    expect(mainTokens + tokenTotal(db, 'subagents')).toBe(total);
    expect(sum(byKind) - mainTokens).toBe(tokenTotal(db, 'subagents'));
    expect(db.raw.prepare('SELECT SUM(subagent_tokens) FROM sessions').pluck().get()).toBe(
      tokenTotal(db, 'subagents'),
    );
    expect(db.raw.prepare('SELECT SUM(messages) FROM hourly').pluck().get()).toBe(
      rowCount(db, 'messages'),
    );
    // The four token types add up separately too.
    for (const column of ['input', 'output', 'cache_write', 'cache_read']) {
      const of = (table: string) =>
        db.raw.prepare(`SELECT SUM(${column}) FROM ${table}`).pluck().get();
      expect(of('hourly')).toBe(of('messages'));
      expect(of('sessions')).toBe(of('messages'));
    }
  });

  it('ignores a root that does not exist', async () => {
    const db = database();
    const summary = await scanLogs(db, [path.join(tempDir(), 'missing'), fixtureRoot('win')]);
    expect(summary.filesFound).toBe(2);
    expect(tokenTotal(db)).toBe(WIN_TOTAL);
  });
});

describe('incremental scans', () => {
  const otherTool = (root: string) => path.join(root, '-Users-alex-dev-other-tool', `${S3}.jsonl`);
  const fileRow = (db: UsageDatabase, file: string) =>
    db.raw
      .prepare('SELECT size, read_offset, lines, usage_records, skipped FROM files WHERE path = ?')
      .get(file) as {
      size: number;
      read_offset: number;
      lines: number;
      usage_records: number;
      skipped: number;
    };

  it('does not read unchanged files again', async () => {
    const root = copyFixture('mac');
    const db = database();
    await scanLogs(db, [root]);
    const second = await scanLogs(db, [root]);
    expect(second).toMatchObject({
      filesFound: 8,
      filesRead: 0,
      filesUnchanged: 8,
      bytesRead: 0,
      linesRead: 0,
      imported: 0,
      duplicates: 0,
    });
    expect(tokenTotal(db)).toBe(MAC_TOTAL);
  });

  it('reads only the bytes appended to a file', async () => {
    const root = copyFixture('mac');
    const db = database();
    await scanLogs(db, [root]);

    const appended =
      assistantLine({
        id: 'appended',
        session: S3,
        cwd: '/Users/alex/dev/other-tool',
        u: [1, 2, 3, 4],
      }) + '\n';
    fs.appendFileSync(otherTool(root), appended);
    const second = await scanLogs(db, [root]);

    expect(second).toMatchObject({
      filesRead: 1,
      filesUnchanged: 7,
      bytesRead: Buffer.byteLength(appended),
      linesRead: 1,
      usageRecords: 1,
      imported: 1,
      duplicates: 0,
    });
    expect(tokenTotal(db)).toBe(MAC_TOTAL + 10);
    expect(tokenTotal(db, 'hourly')).toBe(MAC_TOTAL + 10);
    expect(fileRow(db, otherTool(root))).toMatchObject({
      read_offset: fs.statSync(otherTool(root)).size,
      lines: 5,
      usage_records: 4,
    });
  });

  it('reads a file again from the start when it shrank, without duplicates', async () => {
    const root = copyFixture('mac');
    const db = database();
    await scanLogs(db, [root]);

    const firstTwoLines =
      fs.readFileSync(otherTool(root), 'utf8').split('\n').slice(0, 2).join('\n') + '\n';
    fs.writeFileSync(otherTool(root), firstTwoLines);
    const second = await scanLogs(db, [root]);

    expect(second).toMatchObject({ filesRead: 1, linesRead: 2, imported: 0, duplicates: 1 });
    // The records that were cut from the file stay in the history.
    expect(tokenTotal(db)).toBe(MAC_TOTAL);
    expect(fileRow(db, otherTool(root))).toMatchObject({ lines: 2, usage_records: 1 });
  });

  it('reads a file again from the start when its content was replaced', async () => {
    const root = copyFixture('mac');
    const db = database();
    await scanLogs(db, [root]);

    const replacement = Array.from({ length: 8 }, (_, i) =>
      assistantLine({ id: `replaced-${i}`, session: S3, cwd: '/Users/alex/dev/other-tool' }),
    );
    writeLines(otherTool(root), replacement);
    expect(fs.statSync(otherTool(root)).size).toBeGreaterThan(
      fileRow(db, otherTool(root)).read_offset,
    );
    const second = await scanLogs(db, [root]);

    expect(second).toMatchObject({ filesRead: 1, linesRead: 8, imported: 8, duplicates: 0 });
    expect(tokenTotal(db)).toBe(MAC_TOTAL + 8 * 115);
    expect(fileRow(db, otherTool(root))).toMatchObject({ lines: 8, usage_records: 8 });
  });

  it('keeps the history when the source files are deleted', async () => {
    const root = copyFixture('mac');
    const db = database();
    await scanLogs(db, [root]);

    fs.rmSync(path.join(root, MAC_FOLDER), { recursive: true });
    const second = await scanLogs(db, [root]);

    expect(second.filesFound).toBe(1);
    expect(second.database.messages).toBe(22);
    expect(tokenTotal(db)).toBe(MAC_TOTAL);
    expect(tokenTotal(db, 'hourly')).toBe(MAC_TOTAL);
    expect(rowCount(db, 'sessions')).toBe(3);
    expect(rowCount(db, 'subagents')).toBe(7);
  });

  it('picks up a meta file that arrives after its transcript', async () => {
    const root = copyFixture('mac');
    const meta = path.join(root, MAC_FOLDER, S1, 'subagents', 'agent-a1b2c3d4e5f60001.meta.json');
    const content = fs.readFileSync(meta);
    fs.rmSync(meta);

    const db = database();
    await scanLogs(db, [root]);
    const explore = () => db.listSubagents().find((row) => row.agentId === 'a1b2c3d4e5f60001');
    expect(explore()?.agentType).toBe('unknown');
    expect(tokensBy(db, 'hourly', 'agent_type').unknown).toBe(21540 + 3035 + 1225 + 200);

    fs.writeFileSync(meta, content);
    const second = await scanLogs(db, [root]);
    expect(second).toMatchObject({ filesRead: 0, filesUnchanged: 8 });
    expect(explore()?.agentType).toBe('Explore');
    expect(tokensBy(db, 'hourly', 'agent_type')).toMatchObject({
      Explore: 21540,
      unknown: 3035 + 1225 + 200,
    });
    // Read once: a third scan leaves it alone.
    await scanLogs(db, [root]);
    expect(explore()?.agentType).toBe('Explore');
  });

  it('reclassifies a warm-up agent that later does real work', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = path.join(root, MAC_FOLDER, SESSION_A, 'subagents', 'agent-c0ffee.jsonl');
    writeLines(file, [
      assistantLine({
        id: 'w1',
        sidechain: true,
        agentId: 'c0ffee',
        u: [8, 1, 0, 4000],
        stop: null,
      }),
    ]);
    const db = database();
    await scanLogs(db, [root]);
    expect(db.listSubagents()).toMatchObject([{ agentId: 'c0ffee', kind: 'warmup', calls: 1 }]);
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ warmup: 4009 });

    fs.appendFileSync(
      file,
      assistantLine({
        id: 'w2',
        ts: '2026-11-10T15:00:00.000Z',
        sidechain: true,
        agentId: 'c0ffee',
        u: [5, 50, 0, 4000],
      }) + '\n',
    );
    await scanLogs(db, [root]);
    expect(db.listSubagents()).toMatchObject([{ agentId: 'c0ffee', kind: 'task', calls: 2 }]);
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ task: 4009 + 4055 });
  });
});

describe('unusual files', () => {
  const sessionFile = (root: string, session = SESSION_A) =>
    path.join(root, MAC_FOLDER, `${session}.jsonl`);

  it('reads a last line without a newline, and does not count it twice later', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = sessionFile(root);
    const one = assistantLine({ id: 'one' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${one}\n${assistantLine({ id: 'two' })}`);

    const db = database();
    const first = await scanLogs(db, [root]);
    expect(first).toMatchObject({ imported: 2, linesRead: 1, skippedLines: 0 });
    expect(db.raw.prepare('SELECT read_offset FROM files').pluck().get()).toBe(
      Buffer.byteLength(one) + 1,
    );

    fs.appendFileSync(file, `\n${assistantLine({ id: 'three' })}\n`);
    const second = await scanLogs(db, [root]);
    expect(second).toMatchObject({ imported: 1, duplicates: 1, linesRead: 2 });
    expect(rowCount(db, 'messages')).toBe(3);
    expect(tokenTotal(db, 'hourly')).toBe(3 * 115);
  });

  it('waits for a line that is still being written', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = sessionFile(root);
    const two = assistantLine({ id: 'two' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${assistantLine({ id: 'one' })}\n${two.slice(0, 120)}`);

    const db = database();
    const first = await scanLogs(db, [root]);
    expect(first).toMatchObject({ imported: 1, skippedLines: 0 });

    fs.appendFileSync(file, `${two.slice(120)}\n`);
    const second = await scanLogs(db, [root]);
    expect(second).toMatchObject({ imported: 1, duplicates: 0, skippedLines: 0, linesRead: 1 });
    expect(rowCount(db, 'messages')).toBe(2);
  });

  it('reads files with Windows line endings and blank lines', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = sessionFile(root);
    writeLines(
      file,
      [assistantLine({ id: 'one' }), '', '   ', assistantLine({ id: 'two' })],
      '\r\n',
    );

    const db = database();
    const first = await scanLogs(db, [root]);
    expect(first).toMatchObject({ imported: 2, linesRead: 2, skippedLines: 0 });

    fs.appendFileSync(file, `${assistantLine({ id: 'three' })}\r\n`);
    const second = await scanLogs(db, [root]);
    expect(second).toMatchObject({ imported: 1, duplicates: 0, linesRead: 1, skippedLines: 0 });
    expect(db.raw.prepare('SELECT read_offset FROM files').pluck().get()).toBe(
      fs.statSync(file).size,
    );
  });

  it('reads a file that starts with a byte order mark', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = sessionFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${String.fromCharCode(0xfeff)}${assistantLine({ id: 'one' })}\n${assistantLine({ id: 'two' })}\n`,
    );

    const db = database();
    expect(await scanLogs(db, [root])).toMatchObject({
      imported: 2,
      linesRead: 2,
      skippedLines: 0,
    });
  });

  it('reads a line much larger than one chunk', async () => {
    const root = path.join(tempDir(), 'projects');
    const file = sessionFile(root);
    const huge = JSON.stringify({
      type: 'user',
      sessionId: SESSION_A,
      message: { role: 'user', content: 'x'.repeat(2_600_000) },
    });
    writeLines(file, [assistantLine({ id: 'before' }), huge, assistantLine({ id: 'after' })]);

    const db = database();
    const summary = await scanLogs(db, [root]);
    expect(summary).toMatchObject({ imported: 2, linesRead: 3, skippedLines: 0 });
    expect(summary.bytesRead).toBe(fs.statSync(file).size);
    expect(db.raw.prepare('SELECT read_offset FROM files').pluck().get()).toBe(
      fs.statSync(file).size,
    );
  });

  it('counts a response once when a resumed session copied it', async () => {
    const root = path.join(tempDir(), 'projects');
    const original = sessionFile(root, SESSION_A);
    const resumed = sessionFile(root, SESSION_B);
    const history = [
      { id: 'a1', ts: '2026-11-10T10:00:00.000Z' },
      { id: 'a2', ts: '2026-11-10T10:05:00.000Z' },
    ];
    writeLines(
      original,
      history.map((line) => assistantLine(line)),
    );
    // The resumed session starts with a copy of the history, rewritten with its own id.
    writeLines(resumed, [
      ...history.map((line) => assistantLine({ ...line, session: SESSION_B })),
      assistantLine({ id: 'b1', ts: '2026-11-10T11:00:00.000Z', session: SESSION_B }),
    ]);
    fs.utimesSync(original, new Date('2026-11-10T10:06:00Z'), new Date('2026-11-10T10:06:00Z'));
    fs.utimesSync(resumed, new Date('2026-11-10T11:01:00Z'), new Date('2026-11-10T11:01:00Z'));

    const db = database();
    const summary = await scanLogs(db, [root]);
    expect(summary).toMatchObject({ usageRecords: 5, imported: 3, duplicates: 2 });
    expect(tokenTotal(db)).toBe(3 * 115);
    // The copied responses stay with the session that was written first.
    expect(
      db.raw.prepare('SELECT session_id, messages FROM sessions ORDER BY start_ts').all(),
    ).toEqual([
      { session_id: SESSION_A, messages: 2 },
      { session_id: SESSION_B, messages: 1 },
    ]);
  });

  it('follows the session id written in the records', async () => {
    const root = path.join(tempDir(), 'projects');
    // A file whose name is one session but whose first lines belong to another.
    writeLines(sessionFile(root, SESSION_B), [
      assistantLine({ id: 'a1', session: SESSION_A }),
      assistantLine({ id: 'b1', session: SESSION_B, ts: '2026-11-10T13:00:00.000Z' }),
    ]);
    const db = database();
    await scanLogs(db, [root]);
    expect(
      db.raw.prepare('SELECT session_id, messages FROM sessions ORDER BY start_ts').all(),
    ).toEqual([
      { session_id: SESSION_A, messages: 1 },
      { session_id: SESSION_B, messages: 1 },
    ]);
  });
});

describe('formatSummary', () => {
  it('prints counts only, never project or session names', async () => {
    const db = database();
    const lines = formatSummary(await scanLogs(db, [fixtureRoot('mac')]));
    const text = lines.join('\n');
    expect(lines).toHaveLength(5);
    expect(text).toContain('8 transcript files (5 from subagents)');
    expect(text).toContain('28 usage records: 22 new, 5 duplicates, 1 completed, 5 lines skipped');
    expect(text).toContain('22 messages, 3 sessions, 7 subagent runs, 3 projects, 4 models');
    expect(text).toContain(
      '65,134 total = 959 input + 497 output + 14,400 cache write + 49,278 cache read',
    );
    expect(text).not.toContain('demo-app');
    expect(text).not.toContain(S1);
    expect(text).not.toContain('Users');
  });
});
