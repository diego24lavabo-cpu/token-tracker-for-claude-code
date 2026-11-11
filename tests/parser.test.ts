import { describe, expect, it } from 'vitest';
import {
  encodeProjectPath,
  locateInSessionFolder,
  modelDisplayName,
  parseLine,
  projectNameFromCwd,
  projectNameFromFolder,
  projectNameFromSessionFolder,
} from '../electron/parser';
import { assistantLine, MAC_CWD, SESSION_A } from './helpers';

/** Parses a line that is expected to carry usage. */
function usage(line: string) {
  const parsed = parseLine(line);
  if (parsed.kind !== 'usage') throw new Error(`expected usage, got ${JSON.stringify(parsed)}`);
  return parsed.record;
}

/** An assistant record whose fields can be replaced or removed. */
function custom(
  change: (record: Record<string, unknown>, message: Record<string, unknown>) => void,
) {
  const record = JSON.parse(assistantLine({ id: 'x' })) as Record<string, unknown>;
  change(record, record.message as Record<string, unknown>);
  return JSON.stringify(record);
}

describe('parseLine', () => {
  it('reads an assistant record with usage', () => {
    const record = usage(
      assistantLine({
        id: 'a',
        ts: '2026-11-10T12:52:03.120Z',
        u: [1234, 567, 8900, 45000],
        stop: 'tool_use',
      }),
    );
    expect(record).toEqual({
      dedupKey: 'msg_test_a:req_test_a',
      timestamp: Date.UTC(2026, 10, 10, 12, 52, 3, 120),
      sessionId: SESSION_A,
      cwd: MAC_CWD,
      modelId: 'claude-opus-5-5',
      isSidechain: false,
      agentId: null,
      stopReason: 'tool_use',
      tokens: { input: 1234, output: 567, cacheWrite: 8900, cacheRead: 45000 },
      cacheWrite1h: 0,
    });
  });

  it('reads how much of the cache write went to the 1-hour cache', () => {
    const split = usage(assistantLine({ id: 'a', u: [1, 2, 5000, 0], cache1h: 4000 }));
    expect(split.tokens.cacheWrite).toBe(5000);
    expect(split.cacheWrite1h).toBe(4000);

    expect(usage(assistantLine({ id: 'b', u: [1, 2, 5000, 0], cache1h: 5000 })).cacheWrite1h).toBe(
      5000,
    );
    expect(usage(assistantLine({ id: 'c', u: [1, 2, 5000, 0], cache1h: 0 })).cacheWrite1h).toBe(0);

    // It can never exceed the total written.
    const inconsistent = custom(
      (_, message) =>
        (message.usage = {
          output_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 900 },
        }),
    );
    expect(usage(inconsistent).cacheWrite1h).toBe(100);
  });

  it('reads the subagent markers', () => {
    const record = usage(
      assistantLine({ id: 'a', sidechain: true, agentId: 'a1b2c3', stop: null }),
    );
    expect(record.isSidechain).toBe(true);
    expect(record.agentId).toBe('a1b2c3');
    expect(record.stopReason).toBeNull();
  });

  it('gives streamed copies of one response the same key', () => {
    const first = usage(assistantLine({ id: 'a', u: [10, 1, 0, 0], stop: null }));
    const last = usage(assistantLine({ id: 'a', u: [10, 40, 0, 0] }));
    expect(first.dedupKey).toBe(last.dedupKey);
    expect(usage(assistantLine({ id: 'b' })).dedupKey).not.toBe(first.dedupKey);
  });

  it('falls back to the message id, then to a hash of the line', () => {
    const withoutRequest = custom((record) => delete record.requestId);
    expect(usage(withoutRequest).dedupKey).toBe('msg_test_x');

    const withoutIds = custom((record, message) => {
      delete record.requestId;
      delete message.id;
    });
    const key = usage(withoutIds).dedupKey;
    expect(key).toMatch(/^line:[0-9a-f]{40}$/);
    expect(usage(withoutIds).dedupKey).toBe(key);
    const other = custom((record, message) => {
      delete record.requestId;
      delete message.id;
      record.timestamp = '2026-11-10T13:00:00.000Z';
    });
    expect(usage(other).dedupKey).not.toBe(key);
  });

  it('skips lines that are not valid JSON objects', () => {
    expect(parseLine('{"type":"assistant","message":{"usage":{"input_tok')).toEqual({
      kind: 'skipped',
      reason: 'invalid-json',
    });
    expect(parseLine('[1,2,3]')).toEqual({ kind: 'skipped', reason: 'not-an-object' });
    expect(parseLine('"text"')).toEqual({ kind: 'skipped', reason: 'not-an-object' });
    expect(parseLine('null')).toEqual({ kind: 'skipped', reason: 'not-an-object' });
  });

  it('ignores records that are not assistant responses', () => {
    expect(parseLine('{"type":"user","message":{"role":"user","content":"Synthetic."}}')).toEqual({
      kind: 'ignored',
      reason: 'other-type',
    });
    expect(parseLine('{"type":"summary","summary":"Synthetic."}')).toEqual({
      kind: 'ignored',
      reason: 'other-type',
    });
    expect(parseLine('{}')).toEqual({ kind: 'ignored', reason: 'other-type' });
  });

  it('ignores the rollup a parent session stores after a subagent run', () => {
    const rollup = JSON.stringify({
      type: 'user',
      sessionId: SESSION_A,
      timestamp: '2026-11-10T12:06:50.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'Synthetic.' }] },
      toolUseResult: {
        status: 'completed',
        totalTokens: 99999,
        totalDurationMs: 95000,
        totalToolUseCount: 7,
        usage: { input_tokens: 11111, output_tokens: 22222 },
      },
    });
    expect(parseLine(rollup)).toEqual({ kind: 'ignored', reason: 'other-type' });
  });

  it('skips an assistant record without usage', () => {
    expect(parseLine(custom((_, message) => delete message.usage))).toEqual({
      kind: 'skipped',
      reason: 'missing-usage',
    });
    expect(parseLine(custom((record) => delete record.message))).toEqual({
      kind: 'skipped',
      reason: 'missing-usage',
    });
    expect(parseLine(custom((_, message) => (message.usage = 'none')))).toEqual({
      kind: 'skipped',
      reason: 'missing-usage',
    });
  });

  it('ignores synthetic messages', () => {
    expect(parseLine(custom((_, message) => (message.model = '<synthetic>')))).toEqual({
      kind: 'ignored',
      reason: 'synthetic',
    });
  });

  it('ignores a response that used no tokens', () => {
    expect(parseLine(assistantLine({ id: 'a', u: [0, 0, 0, 0] }))).toEqual({
      kind: 'ignored',
      reason: 'empty-usage',
    });
  });

  it('skips usage without any valid number', () => {
    const invalid = custom(
      (_, message) => (message.usage = { input_tokens: 'many', output_tokens: null }),
    );
    expect(parseLine(invalid)).toEqual({ kind: 'skipped', reason: 'invalid-usage' });
  });

  it('treats missing or invalid token fields as zero', () => {
    const partial = custom(
      (_, message) =>
        (message.usage = { output_tokens: 12.9, input_tokens: -5, cache_read_input_tokens: '7' }),
    );
    expect(usage(partial).tokens).toEqual({ input: 0, output: 12, cacheWrite: 0, cacheRead: 0 });
  });

  it('adds up the cache write breakdown when the total is missing', () => {
    const breakdown = custom(
      (_, message) =>
        (message.usage = {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 4000 },
        }),
    );
    expect(usage(breakdown).tokens.cacheWrite).toBe(4300);

    const both = custom(
      (_, message) =>
        (message.usage = {
          output_tokens: 2,
          cache_creation_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 300 },
        }),
    );
    expect(usage(both).tokens.cacheWrite).toBe(50);
  });

  it('skips a record without a usable timestamp', () => {
    expect(parseLine(assistantLine({ id: 'a', ts: 'not-a-date' }))).toEqual({
      kind: 'skipped',
      reason: 'invalid-timestamp',
    });
    expect(parseLine(custom((record) => delete record.timestamp))).toEqual({
      kind: 'skipped',
      reason: 'invalid-timestamp',
    });
  });

  it('accepts epoch timestamps in seconds or milliseconds', () => {
    const expected = Date.UTC(2026, 10, 10, 12, 0, 0);
    expect(usage(custom((record) => (record.timestamp = expected))).timestamp).toBe(expected);
    expect(usage(custom((record) => (record.timestamp = expected / 1000))).timestamp).toBe(
      expected,
    );
  });

  it('tolerates missing optional fields', () => {
    const bare = custom((record, message) => {
      delete record.sessionId;
      delete record.cwd;
      delete record.isSidechain;
      delete message.model;
      delete message.stop_reason;
    });
    const record = usage(bare);
    expect(record.sessionId).toBeNull();
    expect(record.cwd).toBeNull();
    expect(record.isSidechain).toBe(false);
    expect(record.modelId).toBe('unknown');
    expect(record.stopReason).toBeNull();
  });

  it('never keeps response text', () => {
    const record = usage(assistantLine({ id: 'a' }));
    expect(JSON.stringify(record)).not.toContain('Synthetic response');
  });
});

describe('modelDisplayName', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-2', 'Fable 5.2'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-5-5-20261001', 'Haiku 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-opus-4-1-20250805', 'Opus 4.1'],
    ['claude-sonnet-4-20250514', 'Sonnet 4'],
    ['claude-opus-4', 'Opus 4'],
    ['claude-mythos-6-0', 'Mythos 6.0'],
    ['claude-nova-12-3', 'Nova 12.3'],
  ])('derives %s → %s', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });

  it.each([
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['claude-3-7-sonnet-20250219', 'Sonnet 3.7'],
    ['claude-3-opus-20240229', 'Opus 3'],
    ['claude-3-5-haiku-latest', 'Haiku 3.5'],
  ])('understands the older order %s → %s', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });

  it.each([
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'Sonnet 4.5'],
    ['anthropic.claude-opus-5-5-v2', 'Opus 5.5'],
    ['claude-opus-4-1@20250805', 'Opus 4.1'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
    ['Claude-Opus-5-5', 'Opus 5.5'],
  ])('strips what providers add: %s → %s', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });

  it('uses the override map for ids outside the pattern', () => {
    expect(modelDisplayName('claude-2.1')).toBe('Claude 2.1');
  });

  it('shows unknown formats as they are', () => {
    expect(modelDisplayName('gpt-4o')).toBe('gpt-4o');
    expect(modelDisplayName('claude-opus-next')).toBe('claude-opus-next');
    expect(modelDisplayName('claude-opus-5-5-preview-build')).toBe('claude-opus-5-5-preview-build');
    expect(modelDisplayName('')).toBe('unknown');
  });
});

describe('project names', () => {
  it('encodes a path the way Claude Code names its project folders', () => {
    expect(encodeProjectPath('/Users/alex/dev/demo-app')).toBe('-Users-alex-dev-demo-app');
    expect(encodeProjectPath('C:\\Users\\alex\\dev\\demo-app')).toBe('C--Users-alex-dev-demo-app');
    expect(encodeProjectPath('/Users/alex/dev/my_app.v2')).toBe('-Users-alex-dev-my-app-v2');
  });

  it('recovers the project from the session folder', () => {
    expect(projectNameFromSessionFolder(MAC_CWD, '-Users-alex-dev-demo-app')).toBe('demo-app');
    expect(projectNameFromSessionFolder(`${MAC_CWD}/`, '-Users-alex-dev-demo-app')).toBe(
      'demo-app',
    );
    expect(
      projectNameFromSessionFolder('/Users/alex/dev/my_app.v2', '-Users-alex-dev-my-app-v2'),
    ).toBe('my_app.v2');
  });

  it('keeps the project when the shell moved into a subfolder', () => {
    expect(
      projectNameFromSessionFolder(`${MAC_CWD}/packages/web/src`, '-Users-alex-dev-demo-app'),
    ).toBe('demo-app');
    expect(
      projectNameFromSessionFolder(
        'C:\\Users\\alex\\dev\\demo-app\\src',
        'C--Users-alex-dev-demo-app',
      ),
    ).toBe('demo-app');
  });

  it('tells which directory under the project a cwd is in', () => {
    const folder = '-Users-alex-dev-demo-app';
    expect(locateInSessionFolder(MAC_CWD, folder)).toEqual({ project: 'demo-app', subfolder: '' });
    expect(locateInSessionFolder(`${MAC_CWD}/packages`, folder)).toEqual({
      project: 'demo-app',
      subfolder: 'packages',
    });
    expect(locateInSessionFolder(`${MAC_CWD}/packages/web/src`, folder)).toEqual({
      project: 'demo-app',
      subfolder: 'packages',
    });
    expect(
      locateInSessionFolder(
        'C:\\Users\\alex\\dev\\demo-app\\src\\ui',
        'C--Users-alex-dev-demo-app',
      ),
    ).toEqual({ project: 'demo-app', subfolder: 'src' });
    expect(locateInSessionFolder('/Users/alex/dev/scratch-pad', folder)).toBeNull();
  });

  it('reads Windows paths on any platform, ignoring case', () => {
    expect(
      projectNameFromSessionFolder('C:\\Users\\alex\\dev\\demo-app', 'C--Users-alex-dev-demo-app'),
    ).toBe('demo-app');
    expect(projectNameFromSessionFolder('E:\\Work\\Demo', 'e--Work-Demo')).toBe('Demo');
    expect(
      projectNameFromSessionFolder('C:/Users/alex/dev/demo-app', 'C--Users-alex-dev-demo-app'),
    ).toBe('demo-app');
  });

  it('returns null when the cwd is outside the session folder', () => {
    expect(
      projectNameFromSessionFolder('/Users/alex/dev/scratch-pad', '-Users-alex-dev-demo-app'),
    ).toBeNull();
    expect(projectNameFromSessionFolder('/Users/alex/dev', '-Users-alex-dev-demo-app')).toBeNull();
    expect(projectNameFromSessionFolder(MAC_CWD, '')).toBeNull();
  });

  it('takes the basename of a cwd with the right separator', () => {
    expect(projectNameFromCwd('/Users/alex/dev/demo-app')).toBe('demo-app');
    expect(projectNameFromCwd('/Users/alex/dev/demo-app/')).toBe('demo-app');
    expect(projectNameFromCwd('C:\\Users\\alex\\dev\\demo-app')).toBe('demo-app');
    expect(projectNameFromCwd('C:\\Users\\alex\\dev\\demo-app\\')).toBe('demo-app');
    expect(projectNameFromCwd('\\\\server\\share\\demo-app')).toBe('demo-app');
    expect(projectNameFromCwd('/')).toBeNull();
    expect(projectNameFromCwd('C:\\')).toBeNull();
  });

  it('decodes the last segment of a folder name as a last resort', () => {
    expect(projectNameFromFolder('C--Users-alex-dev-demo-app')).toBe('app');
    expect(projectNameFromFolder('-Users-alex-dev-tracker')).toBe('tracker');
    expect(projectNameFromFolder('')).toBe('unknown');
  });
});
