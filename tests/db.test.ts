import Database from 'better-sqlite3';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DatabaseVersionError,
  MIGRATIONS,
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
    subfolder: '',
    modelId: 'claude-opus-5-5',
    model: 'Opus 5.5',
    kind: 'main',
    agentId: null,
    rank: RANK.ownMain,
    stopReason: 'end_turn',
    tokens: { input: 10, output: 5, cacheWrite: 0, cacheRead: 100 },
    cacheWrite1h: 0,
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
  // Sorted by the first columns (up to 7), which hold every table's primary key.
  const columns = Math.min(7, (db.raw.pragma(`table_info(${table})`) as unknown[]).length);
  const order = Array.from({ length: columns }, (_, index) => index + 1).join(', ');
  return db.raw.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
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
      'session_projects',
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
      cache_write_1h: 0,
      subagent_count: 1,
      subagent_tokens: 14305,
      // 12:00 to 12:45 through every response of the session, subagents included.
      active_ms: 45 * 60_000,
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
        // Its two calls are 40 minutes apart: a pause that long is not active time.
        activeMs: 0,
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

  it('measures active time without the pauses longer than 30 minutes', () => {
    const db = track(openMemoryDb());
    const at = (minutes: number) => NOON + minutes * 60_000;
    store(db, [
      message({ dedupKey: 'a', timestamp: at(0) }),
      message({ dedupKey: 'b', timestamp: at(10) }),
      // Exactly 30 minutes still counts.
      message({ dedupKey: 'c', timestamp: at(40) }),
      // 31 minutes does not.
      message({ dedupKey: 'd', timestamp: at(71) }),
      message({ dedupKey: 'e', timestamp: at(76) }),
      // The session is resumed two days later.
      message({ dedupKey: 'f', timestamp: at(2 * 24 * 60) }),
      message({ dedupKey: 'g', timestamp: at(2 * 24 * 60 + 3) }),
      message({ dedupKey: 'solo', sessionId: 'one-response' }),
    ]);
    const session = (id: string) =>
      db.raw
        .prepare('SELECT active_ms, end_ts - start_ts AS span FROM sessions WHERE session_id = ?')
        .get(id);
    expect(session('s1')).toEqual({
      active_ms: (10 + 30 + 5 + 3) * 60_000,
      span: (2 * 24 * 60 + 3) * 60_000,
    });
    expect(session('one-response')).toEqual({ active_ms: 0, span: 0 });
  });

  it('upgrades a database created with the first schema', () => {
    const file = path.join(tempDir(), 'usage.db');
    const old = new Database(file);
    const firstStep = MIGRATIONS[0];
    if (!firstStep) throw new Error('missing first migration');
    firstStep(old);
    old.pragma('user_version = 1');
    old.exec(`
      INSERT INTO settings (key, value) VALUES ('machine_id', 'machine-1'), ('time_zone', 'UTC'), ('derived_dirty', '0');
      INSERT INTO machines (id, name, platform, is_local) VALUES ('machine-1', 'studio', 'darwin', 1);
      INSERT INTO files (path, root, project_folder, is_subagent, size, mtime_ms, read_offset, head_length, head_hash)
        VALUES ('/logs/a.jsonl', '/logs', 'folder', 0, 900, 1, 900, 256, 'abc');
    `);
    const insert = old.prepare(
      `INSERT INTO messages (dedup_key, ts, local_day, local_hour, session_id, project, model_id, model,
                             kind, agent_id, input, output, cache_write, cache_read, stop_reason, rank)
       VALUES (?, ?, '2026-11-10', 12, 's1', 'demo-app', 'claude-opus-5-5', 'Opus 5.5',
               'main', NULL, 10, 5, 0, 100, 'end_turn', 4)`,
    );
    insert.run('a', NOON);
    insert.run('b', NOON + 12 * 60_000);
    old.close();

    const db = track(new UsageDatabase(file, { timeZone: 'UTC' }));
    expect(db.raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.machineId).toBe('machine-1');
    expect(db.raw.prepare('SELECT messages, active_ms FROM sessions').get()).toEqual({
      messages: 2,
      active_ms: 12 * 60_000,
    });
    expect(tokenTotal(db, 'hourly')).toBe(230);
    // The file list is emptied so the next scan reads every transcript again and learns
    // how the cache writes were split. The usage itself is kept.
    expect(rowCount(db, 'files')).toBe(0);
    expect(rowCount(db, 'messages')).toBe(2);
    expect(db.raw.prepare('SELECT DISTINCT subfolder, cache_write_1h FROM messages').all()).toEqual(
      [{ subfolder: '', cache_write_1h: 0 }],
    );
  });

  it('splits a container folder by the directory directly under it', () => {
    const db = track(openMemoryDb());
    const at = (minutes: number) => NOON + minutes * 60_000;
    store(
      db,
      [
        message({ dedupKey: 'a', timestamp: at(0), project: 'workspace', subfolder: 'alpha' }),
        message({ dedupKey: 'b', timestamp: at(5), project: 'workspace', subfolder: 'alpha' }),
        message({ dedupKey: 'c', timestamp: at(10), project: 'workspace', subfolder: '' }),
        message({ dedupKey: 'd', sessionId: 's2', project: 'workspace', subfolder: 'beta' }),
        message({
          dedupKey: 'e',
          timestamp: at(6),
          project: 'workspace',
          subfolder: 'alpha',
          kind: 'task',
          agentId: 'agent-1',
          rank: RANK.subagent,
        }),
        message({ dedupKey: 'f', sessionId: 's3', project: 'other', subfolder: 'src' }),
      ],
      [agent({ agentId: 'agent-1' })],
    );
    const projects = () => tokensBy(db, 'hourly', 'project');
    expect(projects()).toEqual({ workspace: 5 * 115, other: 115 });

    db.setContainerProjects(['workspace', ' workspace ', '']);
    expect(db.getContainerProjects()).toEqual(['workspace']);
    // Responses made at the top of the folder keep its name; other folders are untouched.
    expect(projects()).toEqual({
      'workspace › alpha': 3 * 115,
      'workspace › beta': 115,
      workspace: 115,
      other: 115,
    });
    expect(
      db.raw.prepare('SELECT session_id, project FROM sessions ORDER BY session_id').all(),
    ).toEqual([
      { session_id: 's1', project: 'workspace › alpha' },
      { session_id: 's2', project: 'workspace › beta' },
      { session_id: 's3', project: 'other' },
    ]);
    expect(db.listSubagents()[0]?.project).toBe('workspace › alpha');
    expect(db.stats().projects).toBe(4);
    // Raw history is unchanged, so the flag can be removed again.
    expect(
      db.raw.prepare('SELECT DISTINCT project FROM messages ORDER BY 1').pluck().all(),
    ).toEqual(['other', 'workspace']);
    expect(tokenTotal(db, 'hourly')).toBe(tokenTotal(db));

    // New usage arriving later is split too.
    store(db, [
      message({ dedupKey: 'g', sessionId: 's4', project: 'workspace', subfolder: 'gamma' }),
    ]);
    expect(projects()['workspace › gamma']).toBe(115);

    db.setContainerProjects([]);
    expect(projects()).toEqual({ workspace: 6 * 115, other: 115 });
  });

  it('survives a container setting it cannot read', () => {
    const db = track(openMemoryDb());
    db.setSetting('container_projects', '{"broken"');
    expect(db.getContainerProjects()).toEqual([]);
    db.setSetting('container_projects', '["a", 3, null, ""]');
    expect(db.getContainerProjects()).toEqual(['a']);
    store(db, [message({ dedupKey: 'a', project: 'a', subfolder: 'b' })]);
    expect(tokensBy(db, 'hourly', 'project')).toEqual({ 'a › b': 115 });
  });

  it('records the subfolder a response was made in, also when a later copy brings it', () => {
    const db = track(openMemoryDb());
    const subfolder = () => db.raw.prepare('SELECT subfolder FROM messages').pluck().get();

    store(db, [message({ dedupKey: 'a' })]);
    expect(subfolder()).toBe('');
    expect(store(db, [message({ dedupKey: 'a', subfolder: 'packages' })])).toMatchObject({
      upgraded: 1,
    });
    expect(subfolder()).toBe('packages');
    // A copy that knows less does not erase it.
    expect(store(db, [message({ dedupKey: 'a' })])).toMatchObject({ duplicates: 1 });
    expect(subfolder()).toBe('packages');
    // A copy that belongs somewhere better brings its own.
    store(db, [message({ dedupKey: 'b', subfolder: 'old', rank: RANK.copiedMain })]);
    store(db, [message({ dedupKey: 'b', subfolder: 'src' })]);
    expect(
      db.raw.prepare("SELECT subfolder FROM messages WHERE dedup_key = 'b'").pluck().get(),
    ).toBe('src');
  });

  it('records the 1-hour share of cache writes, also when a later copy brings it', () => {
    const db = track(openMemoryDb());
    const write = (cacheWrite1h: number) =>
      message({
        dedupKey: 'a',
        tokens: { input: 1, output: 2, cacheWrite: 5000, cacheRead: 0 },
        cacheWrite1h,
      });
    expect(store(db, [write(0)])).toMatchObject({ inserted: 1 });
    // The same response read again, this time with the breakdown.
    expect(store(db, [write(4000)])).toEqual({ inserted: 0, duplicates: 0, upgraded: 1 });
    expect(store(db, [write(4000)])).toEqual({ inserted: 0, duplicates: 1, upgraded: 0 });

    for (const table of ['messages', 'hourly', 'sessions']) {
      expect(db.raw.prepare(`SELECT cache_write, cache_write_1h FROM ${table}`).get()).toEqual({
        cache_write: 5000,
        cache_write_1h: 4000,
      });
    }
    // The 1-hour share is part of the cache writes, not an extra token type.
    expect(tokenTotal(db, 'hourly')).toBe(5003);
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

    for (const table of ['hourly', 'sessions', 'session_projects', 'subagents']) {
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
