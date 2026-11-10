import Database from 'better-sqlite3';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DatabaseVersionError,
  SCHEMA_VERSION,
  UsageDatabase,
  type AgentInput,
  type FileState,
  type MessageInput,
} from '../electron/db';
import { RANK } from '../electron/subagents';
import { cleanupTempDirs, openMemoryDb, rowCount, tempDir, tokensBy, tokenTotal } from './helpers';

const open: UsageDatabase[] = [];

function track(db: UsageDatabase): UsageDatabase {
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  cleanupTempDirs();
});

const NOON = Date.parse('2026-11-10T12:00:00Z');

function fileState(filePath = '/logs/session.jsonl'): FileState {
  return {
    path: filePath,
    root: '/logs',
    projectFolder: 'folder',
    isSubagent: false,
    agentId: null,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    headLength: 0,
    headHash: '',
    metaRead: false,
    project: null,
    lines: 0,
    usageRecords: 0,
    skipped: 0,
  };
}

function message(overrides: Partial<MessageInput> & { dedupKey: string }): MessageInput {
  return {
    timestamp: NOON,
    sessionId: 's1',
    project: 'demo-app',
    modelId: 'claude-opus-5-5',
    model: 'Opus 5.5',
    kind: 'main',
    agentId: null,
    rank: RANK.ownMain,
    stopReason: 'end_turn',
    tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 100 },
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInput> & { agentId: string }): AgentInput {
  return { sessionId: 's1', agentType: 'unknown', meta: null, ...overrides };
}

function store(db: UsageDatabase, messages: MessageInput[], agents: AgentInput[] = []) {
  const counts = db.ingestBatch(fileState(), messages, agents);
  db.refreshDerived();
  return counts;
}

function dump(db: UsageDatabase, table: string): unknown[] {
  return db.raw.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3, 4, 5, 6, 7`).all();
}

describe('schema', () => {
  it('creates the tables and records the schema version', () => {
    const db = track(openMemoryDb());
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([
      'agent_meta',
      'files',
      'hourly',
      'machines',
      'messages',
      'sessions',
      'settings',
      'subagents',
    ]);
  });

  it('keeps the machine id across restarts', () => {
    const file = path.join(tempDir(), 'usage.db');
    const first = new UsageDatabase(file, { timeZone: 'UTC', machineName: 'studio' });
    const { machineId } = first;
    expect(machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.listMachines()).toEqual([
      {
        id: machineId,
        name: 'studio',
        platform: expect.any(String),
        isLocal: true,
        lastSync: null,
      },
    ]);
    first.close();

    const second = track(new UsageDatabase(file, { timeZone: 'UTC', machineName: 'renamed-host' }));
    expect(second.machineId).toBe(machineId);
    expect(second.listMachines()).toHaveLength(1);
    expect(second.listMachines()[0]?.name).toBe('studio');
  });

  it('refuses a database written by a newer version of the app', () => {
    const file = path.join(tempDir(), 'usage.db');
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new UsageDatabase(file)).toThrow(DatabaseVersionError);
  });

  it('keeps the subagent description out of everything that can be synced', () => {
    const db = track(openMemoryDb());
    const columns = (table: string) =>
      db.raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all() as string[];
    expect(columns('agent_meta')).toContain('description');
    for (const table of ['hourly', 'sessions', 'subagents', 'messages']) {
      expect(columns(table)).not.toContain('description');
    }
  });
});

describe('deduplication', () => {
  it('stores a response once, whatever the number of copies', () => {
    const db = track(openMemoryDb());
    expect(store(db, [message({ dedupKey: 'a' }), message({ dedupKey: 'a' })])).toEqual({
      inserted: 1,
      duplicates: 1,
      upgraded: 0,
    });
    expect(store(db, [message({ dedupKey: 'a' })])).toEqual({
      inserted: 0,
      duplicates: 1,
      upgraded: 0,
    });
    expect(rowCount(db, 'messages')).toBe(1);
    expect(tokenTotal(db)).toBe(115);
    expect(tokenTotal(db, 'hourly')).toBe(115);
  });

  it('keeps the most complete copy of a streamed response', () => {
    const partial = message({
      dedupKey: 'a',
      stopReason: null,
      tokens: { input: 300, output: 1, cacheWrite: 0, cacheRead: 2000 },
    });
    const complete = message({
      dedupKey: 'a',
      tokens: { input: 300, output: 40, cacheWrite: 0, cacheRead: 2000 },
    });

    const forward = track(openMemoryDb());
    expect(store(forward, [partial, complete])).toEqual({
      inserted: 1,
      duplicates: 0,
      upgraded: 1,
    });
    const backward = track(openMemoryDb());
    expect(store(backward, [complete, partial])).toEqual({
      inserted: 1,
      duplicates: 1,
      upgraded: 0,
    });

    for (const db of [forward, backward]) {
      expect(db.raw.prepare('SELECT output, stop_reason FROM messages').get()).toEqual({
        output: 40,
        stop_reason: 'end_turn',
      });
      expect(tokenTotal(db, 'hourly')).toBe(2340);
      expect(tokenTotal(db, 'sessions')).toBe(2340);
    }
  });

  it('refreshes the derived tables when a later copy completes a response', () => {
    const db = track(openMemoryDb());
    store(db, [
      message({
        dedupKey: 'a',
        stopReason: null,
        tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
      }),
    ]);
    expect(tokenTotal(db, 'hourly')).toBe(2);
    store(db, [
      message({ dedupKey: 'a', tokens: { input: 1, output: 9, cacheWrite: 0, cacheRead: 0 } }),
    ]);
    expect(tokenTotal(db, 'hourly')).toBe(10);
    expect(tokenTotal(db, 'sessions')).toBe(10);
  });

  it('moves a response to the main session when a /btw transcript logged it first', () => {
    const db = track(openMemoryDb());
    const inAside = message({
      dedupKey: 'a',
      kind: 'aside',
      agentId: 'aside_question-1',
      rank: RANK.aside,
    });
    store(db, [inAside], [agent({ agentId: 'aside_question-1', agentType: 'aside_question' })]);
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ aside: 115 });
    expect(rowCount(db, 'subagents')).toBe(1);

    expect(store(db, [message({ dedupKey: 'a' })])).toEqual({
      inserted: 0,
      duplicates: 0,
      upgraded: 1,
    });
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ main: 115 });
    expect(rowCount(db, 'subagents')).toBe(0);
    expect(
      db.raw.prepare('SELECT messages, subagent_count, subagent_tokens FROM sessions').get(),
    ).toEqual({
      messages: 1,
      subagent_count: 0,
      subagent_tokens: 0,
    });

    // The other way round, the main session keeps it.
    expect(store(db, [inAside])).toEqual({ inserted: 0, duplicates: 1, upgraded: 0 });
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ main: 115 });
  });

  it('prefers the session that owns a line over a file that copied it', () => {
    const db = track(openMemoryDb());
    store(db, [
      message({ dedupKey: 'a', sessionId: 'fork', project: 'copy', rank: RANK.copiedMain }),
    ]);
    store(db, [message({ dedupKey: 'a', sessionId: 'original', project: 'demo-app' })]);
    expect(db.raw.prepare('SELECT session_id, project FROM sessions').all()).toEqual([
      { session_id: 'original', project: 'demo-app' },
    ]);
    expect(tokensBy(db, 'hourly', 'project')).toEqual({ 'demo-app': 115 });
  });
});

describe('derived tables', () => {
  it('summarizes a session with its subagents', () => {
    const db = track(openMemoryDb());
    const at = (minutes: number) => NOON + minutes * 60_000;
    store(
      db,
      [
        message({ dedupKey: 'm1', timestamp: at(0) }),
        message({
          dedupKey: 'm2',
          timestamp: at(20),
          model: 'Sonnet 5.5',
          modelId: 'claude-sonnet-5-5',
        }),
        message({ dedupKey: 'm3', timestamp: at(30) }),
        message({
          dedupKey: 's1',
          timestamp: at(5),
          kind: 'task',
          agentId: 'agent-1',
          rank: RANK.subagent,
          model: 'Haiku 5.5',
          modelId: 'claude-haiku-5-5',
          tokens: { input: 30, output: 10, cacheWrite: 7000, cacheRead: 0 },
        }),
        message({
          dedupKey: 's2',
          timestamp: at(45),
          kind: 'task',
          agentId: 'agent-1',
          rank: RANK.subagent,
          model: 'Haiku 5.5',
          modelId: 'claude-haiku-5-5',
          tokens: { input: 5, output: 60, cacheWrite: 200, cacheRead: 7000 },
        }),
      ],
      [
        agent({
          agentId: 'agent-1',
          agentType: 'Explore',
          meta: { agentType: 'Explore', description: 'Synthetic task.', toolUseId: null },
        }),
      ],
    );

    expect(db.raw.prepare('SELECT * FROM sessions').get()).toEqual({
      machine_id: db.machineId,
      session_id: 's1',
      project: 'demo-app',
      model: 'Opus 5.5',
      // Start and end are the main session's: the subagent that ran until 12:45 is left out.
      start_ts: at(0),
      end_ts: at(30),
      start_day: '2026-11-10',
      messages: 3,
      input: 65,
      output: 85,
      cache_write: 7200,
      cache_read: 7300,
      subagent_count: 1,
      subagent_tokens: 14305,
    });

    expect(db.listSubagents()).toEqual([
      {
        sessionId: 's1',
        agentId: 'agent-1',
        project: 'demo-app',
        agentType: 'Explore',
        kind: 'task',
        model: 'Haiku 5.5',
        startTs: at(5),
        endTs: at(45),
        calls: 2,
        // Total input of the first call: what the agent loads before doing anything.
        startupInput: 7030,
        tokens: { input: 35, output: 70, cacheWrite: 7200, cacheRead: 7000 },
      },
    ]);

    expect(
      db.raw
        .prepare(
          `SELECT model, kind, agent_type, messages, input + output + cache_write + cache_read AS tokens
           FROM hourly ORDER BY model`,
        )
        .all(),
    ).toEqual([
      { model: 'Haiku 5.5', kind: 'task', agent_type: 'Explore', messages: 2, tokens: 14305 },
      { model: 'Opus 5.5', kind: 'main', agent_type: '', messages: 2, tokens: 230 },
      { model: 'Sonnet 5.5', kind: 'main', agent_type: '', messages: 1, tokens: 115 },
    ]);
  });

  it('classifies a subagent that never answered as a warm-up, until it does', () => {
    const db = track(openMemoryDb());
    const first = message({
      dedupKey: 'w1',
      kind: 'task',
      agentId: 'agent-w',
      rank: RANK.subagent,
      stopReason: null,
      tokens: { input: 8, output: 1, cacheWrite: 0, cacheRead: 4000 },
    });
    store(db, [first], [agent({ agentId: 'agent-w' })]);
    expect(db.listSubagents()[0]?.kind).toBe('warmup');
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ warmup: 4009 });
    // Warm-ups are not counted as subagent invocations of the session.
    expect(db.raw.prepare('SELECT subagent_count FROM sessions').pluck().get()).toBe(0);

    store(db, [
      message({
        dedupKey: 'w2',
        timestamp: NOON + 3 * 3_600_000,
        kind: 'task',
        agentId: 'agent-w',
        rank: RANK.subagent,
        tokens: { input: 5, output: 50, cacheWrite: 0, cacheRead: 4000 },
      }),
    ]);
    expect(db.listSubagents()[0]?.kind).toBe('task');
    // The first call sits in another hour: its row moves from 'warmup' to 'task' too.
    expect(tokensBy(db, 'hourly', 'kind')).toEqual({ task: 4009 + 4055 });
    expect(db.raw.prepare('SELECT subagent_count FROM sessions').pluck().get()).toBe(1);
  });

  it('does not treat /btw transcripts as warm-ups', () => {
    const db = track(openMemoryDb());
    store(
      db,
      [
        message({
          dedupKey: 'a1',
          kind: 'aside',
          agentId: 'aside_question-1',
          rank: RANK.aside,
          stopReason: null,
          tokens: { input: 8, output: 1, cacheWrite: 0, cacheRead: 0 },
        }),
      ],
      [agent({ agentId: 'aside_question-1', agentType: 'aside_question' })],
    );
    expect(db.listSubagents()[0]).toMatchObject({ kind: 'aside', agentType: 'aside_question' });
  });

  it('never replaces an agent type read from a meta file with a guess', () => {
    const db = track(openMemoryDb());
    const call = (key: string) =>
      message({ dedupKey: key, kind: 'task', agentId: 'agent-1', rank: RANK.subagent });
    const meta = { agentType: 'Plan', description: 'Synthetic plan.', toolUseId: 'toolu_1' };

    store(db, [call('a')], [agent({ agentId: 'agent-1' })]);
    expect(db.listSubagents()[0]?.agentType).toBe('unknown');
    store(db, [call('b')], [agent({ agentId: 'agent-1', agentType: 'Plan', meta })]);
    expect(db.listSubagents()[0]?.agentType).toBe('Plan');
    store(db, [call('c')], [agent({ agentId: 'agent-1' })]);
    expect(db.listSubagents()[0]?.agentType).toBe('Plan');
    expect(tokensBy(db, 'hourly', 'agent_type')).toEqual({ Plan: 345 });
    expect(db.raw.prepare('SELECT description FROM agent_meta').pluck().get()).toBe(
      'Synthetic plan.',
    );
  });

  it('gives the same result when rebuilt at once or refreshed step by step', () => {
    const messages: MessageInput[] = [];
    const agents: AgentInput[] = [];
    for (let i = 0; i < 700; i++) {
      const sessionId = `session-${i % 90}`;
      const isSubagent = i % 3 === 0;
      // Every 99th record is a lone call with one output token and no stop reason: a warm-up.
      const agentId = isSubagent ? (i % 99 === 0 ? `warm-${i}` : `agent-${i % 40}`) : null;
      messages.push(
        message({
          dedupKey: `key-${i}`,
          timestamp: NOON + i * 7 * 60_000,
          sessionId,
          project: `project-${i % 5}`,
          model: i % 4 === 0 ? 'Sonnet 5.5' : 'Opus 5.5',
          kind: isSubagent ? (i % 2 === 0 ? 'task' : 'workflow') : 'main',
          agentId,
          rank: isSubagent ? RANK.subagent : RANK.ownMain,
          stopReason: i % 11 === 0 ? null : 'end_turn',
          tokens: {
            input: i % 13,
            output: i % 9 === 0 ? 1 : 20 + (i % 50),
            cacheWrite: i % 7,
            cacheRead: i * 3,
          },
        }),
      );
      if (agentId) agents.push(agent({ sessionId, agentId }));
    }

    const atOnce = track(openMemoryDb('Europe/Paris'));
    store(atOnce, messages, agents);

    const stepByStep = track(openMemoryDb('Europe/Paris'));
    for (let i = 0; i < messages.length; i += 25) {
      store(stepByStep, messages.slice(i, i + 25), agents);
    }

    for (const table of ['hourly', 'sessions', 'subagents']) {
      const strip = (rows: unknown[]) =>
        rows.map((row) => ({ ...(row as Record<string, unknown>), machine_id: '' }));
      expect(strip(dump(stepByStep, table))).toEqual(strip(dump(atOnce, table)));
    }
    expect(tokenTotal(atOnce, 'hourly')).toBe(tokenTotal(atOnce));
    expect(rowCount(atOnce, 'subagents', "kind = 'warmup'")).toBeGreaterThan(0);
  });
});

describe('durability', () => {
  it('rebuilds the derived tables after a crash between storing and refreshing', () => {
    const file = path.join(tempDir(), 'usage.db');
    const crashed = new UsageDatabase(file, { timeZone: 'UTC' });
    crashed.ingestBatch(fileState(), [message({ dedupKey: 'a' })], []);
    expect(rowCount(crashed, 'sessions')).toBe(0);
    crashed.close();

    const reopened = track(new UsageDatabase(file, { timeZone: 'UTC' }));
    expect(rowCount(reopened, 'sessions')).toBe(1);
    expect(tokenTotal(reopened, 'hourly')).toBe(115);
  });

  it('remembers how far each file was read', () => {
    const file = path.join(tempDir(), 'usage.db');
    const first = new UsageDatabase(file, { timeZone: 'UTC' });
    const state: FileState = {
      ...fileState('/logs/a.jsonl'),
      size: 2048,
      mtimeMs: 1_794_312_000_123.5,
      offset: 2000,
      headLength: 256,
      headHash: 'abc',
      isSubagent: true,
      agentId: 'agent-1',
      metaRead: true,
      project: 'demo-app',
      lines: 12,
      usageRecords: 7,
      skipped: 2,
    };
    first.ingestBatch(state, [], []);
    first.close();

    const second = track(new UsageDatabase(file, { timeZone: 'UTC' }));
    expect(second.loadFileStates().get('/logs/a.jsonl')).toEqual(state);
    expect(second.stats()).toMatchObject({ files: 1, subagentFiles: 1, skippedLines: 2 });
  });
});

describe('time zone', () => {
  it('buckets by the local day and hour of the configured zone', () => {
    const lateEvening = Date.parse('2026-11-10T23:30:00Z');
    const paris = track(openMemoryDb('Europe/Paris'));
    store(paris, [message({ dedupKey: 'a', timestamp: lateEvening })]);
    expect(paris.raw.prepare('SELECT local_day, local_hour FROM hourly').get()).toEqual({
      local_day: '2026-11-11',
      local_hour: 0,
    });

    const losAngeles = track(openMemoryDb('America/Los_Angeles'));
    store(losAngeles, [message({ dedupKey: 'a', timestamp: lateEvening })]);
    expect(losAngeles.raw.prepare('SELECT local_day, local_hour FROM hourly').get()).toEqual({
      local_day: '2026-11-10',
      local_hour: 15,
    });
  });

  it('recomputes local days when the system time zone changed', () => {
    const file = path.join(tempDir(), 'usage.db');
    const before = new UsageDatabase(file, { timeZone: 'America/Los_Angeles' });
    store(before, [message({ dedupKey: 'a', timestamp: Date.parse('2026-11-10T23:30:00Z') })]);
    expect(before.raw.prepare('SELECT start_day FROM sessions').pluck().get()).toBe('2026-11-10');
    before.close();

    const after = track(new UsageDatabase(file, { timeZone: 'Europe/Paris' }));
    expect(after.timeZone).toBe('Europe/Paris');
    // The stored timestamp is UTC and did not move.
    expect(after.raw.prepare('SELECT ts, local_day, local_hour FROM messages').get()).toEqual({
      ts: Date.parse('2026-11-10T23:30:00Z'),
      local_day: '2026-11-11',
      local_hour: 0,
    });
    expect(after.raw.prepare('SELECT local_day, local_hour FROM hourly').all()).toEqual([
      { local_day: '2026-11-11', local_hour: 0 },
    ]);
    expect(after.raw.prepare('SELECT start_day FROM sessions').pluck().get()).toBe('2026-11-11');
  });
});
