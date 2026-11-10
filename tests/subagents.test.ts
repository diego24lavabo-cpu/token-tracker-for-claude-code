import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLine } from '../electron/parser';
import {
  agentTypeFor,
  attributeRecord,
  classifyLogFile,
  INLINE_AGENT_ID,
  RANK,
  readAgentMeta,
} from '../electron/subagents';
import {
  assistantLine,
  cleanupTempDirs,
  fixtureRoot,
  SESSION_A,
  SESSION_B,
  tempDir,
} from './helpers';

afterEach(cleanupTempDirs);

const ROOT = '/Users/alex/.claude/projects';
const FOLDER = `${ROOT}/-Users-alex-dev-demo-app`;
const WIN_ROOT = 'C:\\Users\\alex\\.claude\\projects';
const WIN_FOLDER = `${WIN_ROOT}\\C--Users-alex-dev-demo-app`;

function record(options: Parameters<typeof assistantLine>[0]) {
  const parsed = parseLine(assistantLine(options));
  if (parsed.kind !== 'usage') throw new Error('expected a usage record');
  return parsed.record;
}

describe('classifyLogFile', () => {
  it('recognizes a main session file', () => {
    expect(classifyLogFile(ROOT, `${FOLDER}/${SESSION_A}.jsonl`)).toEqual({
      projectFolder: '-Users-alex-dev-demo-app',
      isSubagentFile: false,
      fileSessionId: SESSION_A,
      agentId: null,
      kind: 'main',
      metaPath: null,
    });
  });

  it('recognizes a subagent transcript and its meta file', () => {
    const file = `${FOLDER}/${SESSION_A}/subagents/agent-a1b2c3.jsonl`;
    expect(classifyLogFile(ROOT, file)).toEqual({
      projectFolder: '-Users-alex-dev-demo-app',
      isSubagentFile: true,
      fileSessionId: SESSION_A,
      agentId: 'a1b2c3',
      kind: 'task',
      metaPath: `${FOLDER}/${SESSION_A}/subagents/agent-a1b2c3.meta.json`,
    });
  });

  it('recognizes workflow agents', () => {
    const file = `${FOLDER}/${SESSION_A}/subagents/workflows/wf_demo01/agent-a1b2c3.jsonl`;
    const cls = classifyLogFile(ROOT, file);
    expect(cls.kind).toBe('workflow');
    expect(cls.agentId).toBe('a1b2c3');
    expect(cls.fileSessionId).toBe(SESSION_A);
  });

  it('recognizes /btw side questions by their file name', () => {
    const cls = classifyLogFile(
      ROOT,
      `${FOLDER}/${SESSION_A}/subagents/agent-aside_question-a1b2c3.jsonl`,
    );
    expect(cls.kind).toBe('aside');
    expect(cls.agentId).toBe('aside_question-a1b2c3');
  });

  it('reads Windows paths', () => {
    const cls = classifyLogFile(
      WIN_ROOT,
      `${WIN_FOLDER}\\${SESSION_A}\\subagents\\agent-b1b2c3.jsonl`,
    );
    expect(cls).toMatchObject({
      projectFolder: 'C--Users-alex-dev-demo-app',
      isSubagentFile: true,
      fileSessionId: SESSION_A,
      agentId: 'b1b2c3',
      kind: 'task',
      metaPath: `${WIN_FOLDER}\\${SESSION_A}\\subagents\\agent-b1b2c3.meta.json`,
    });
    expect(classifyLogFile(WIN_ROOT, `${WIN_FOLDER}\\${SESSION_A}.jsonl`)).toMatchObject({
      isSubagentFile: false,
      fileSessionId: SESSION_A,
    });
  });

  it('treats another transcript inside a session folder as part of that session', () => {
    const cls = classifyLogFile(ROOT, `${FOLDER}/${SESSION_A}/extra/spill.jsonl`);
    expect(cls).toMatchObject({ isSubagentFile: false, fileSessionId: SESSION_A, kind: 'main' });
  });

  it('accepts a transcript directly under the root', () => {
    expect(classifyLogFile(ROOT, `${ROOT}/${SESSION_A}.jsonl`)).toMatchObject({
      projectFolder: '',
      isSubagentFile: false,
      fileSessionId: SESSION_A,
    });
  });
});

describe('attributeRecord', () => {
  const mainFile = classifyLogFile(ROOT, `${FOLDER}/${SESSION_A}.jsonl`);
  const agentFile = classifyLogFile(ROOT, `${FOLDER}/${SESSION_A}/subagents/agent-a1b2c3.jsonl`);
  const asideFile = classifyLogFile(
    ROOT,
    `${FOLDER}/${SESSION_A}/subagents/agent-aside_question-a9.jsonl`,
  );

  it('attributes a main session line to its session', () => {
    expect(attributeRecord(mainFile, record({ id: 'a' }))).toEqual({
      sessionId: SESSION_A,
      kind: 'main',
      agentId: null,
      rank: RANK.ownMain,
    });
  });

  it('ranks history copied from another session lower', () => {
    expect(attributeRecord(mainFile, record({ id: 'a', session: SESSION_B }))).toEqual({
      sessionId: SESSION_B,
      kind: 'main',
      agentId: null,
      rank: RANK.copiedMain,
    });
  });

  it('uses the file name as session when the record has none', () => {
    expect(attributeRecord(mainFile, record({ id: 'a', session: null }))).toMatchObject({
      sessionId: SESSION_A,
      rank: RANK.ownMain,
    });
  });

  it('identifies a subagent by its file, and links it to the parent through sessionId', () => {
    expect(
      attributeRecord(agentFile, record({ id: 'a', sidechain: true, agentId: 'a1b2c3' })),
    ).toEqual({
      sessionId: SESSION_A,
      kind: 'task',
      agentId: 'a1b2c3',
      rank: RANK.subagent,
    });
    // No agentId and no sidechain flag: the location alone makes it a subagent record.
    expect(attributeRecord(agentFile, record({ id: 'b' }))).toMatchObject({
      kind: 'task',
      agentId: 'a1b2c3',
    });
    // The session of a subagent is the one written in its records.
    expect(attributeRecord(agentFile, record({ id: 'c', session: SESSION_B }))).toMatchObject({
      sessionId: SESSION_B,
      agentId: 'a1b2c3',
    });
    expect(attributeRecord(agentFile, record({ id: 'd', session: null }))).toMatchObject({
      sessionId: SESSION_A,
    });
  });

  it('gives /btw transcripts the lowest rank', () => {
    expect(attributeRecord(asideFile, record({ id: 'a' }))).toEqual({
      sessionId: SESSION_A,
      kind: 'aside',
      agentId: 'aside_question-a9',
      rank: RANK.aside,
    });
  });

  it('handles legacy sidechain lines inside a main session file', () => {
    expect(
      attributeRecord(mainFile, record({ id: 'a', sidechain: true, agentId: 'legacyagent01' })),
    ).toEqual({
      sessionId: SESSION_A,
      kind: 'task',
      agentId: 'legacyagent01',
      rank: RANK.subagent,
    });
    expect(attributeRecord(mainFile, record({ id: 'b', sidechain: true }))).toEqual({
      sessionId: SESSION_A,
      kind: 'task',
      agentId: INLINE_AGENT_ID,
      rank: RANK.subagent,
    });
  });
});

describe('readAgentMeta', () => {
  const subagents = path.join(
    fixtureRoot('mac'),
    '-Users-alex-dev-demo-app',
    '11111111-1111-4111-8111-111111111111',
    'subagents',
  );

  it('reads the agent type and description', async () => {
    expect(await readAgentMeta(path.join(subagents, 'agent-a1b2c3d4e5f60001.meta.json'))).toEqual({
      agentType: 'Explore',
      description: 'Synthetic task description.',
      toolUseId: 'toolu_demo_0001',
    });
  });

  it('returns null when the file is missing', async () => {
    expect(
      await readAgentMeta(path.join(subagents, 'agent-a1b2c3d4e5f60002.meta.json')),
    ).toBeNull();
  });

  it('returns null for unusable content', async () => {
    const dir = tempDir();
    const write = (name: string, content: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    };
    expect(await readAgentMeta(write('broken.meta.json', '{"agentType":"Expl'))).toBeNull();
    expect(await readAgentMeta(write('array.meta.json', '["Explore"]'))).toBeNull();
    expect(
      await readAgentMeta(write('notype.meta.json', '{"description":"Synthetic."}')),
    ).toBeNull();
    expect(await readAgentMeta(write('number.meta.json', '{"agentType":42}'))).toBeNull();
    expect(await readAgentMeta(write('blank.meta.json', '{"agentType":"  "}'))).toBeNull();
  });

  it('keeps only strings and caps their length', async () => {
    const file = path.join(tempDir(), 'long.meta.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ agentType: ' code-reviewer ', description: 'x'.repeat(5000), toolUseId: 7 }),
    );
    const meta = await readAgentMeta(file);
    expect(meta?.agentType).toBe('code-reviewer');
    expect(meta?.description).toHaveLength(2000);
    expect(meta?.toolUseId).toBeNull();
  });
});

describe('agentTypeFor', () => {
  it('prefers the meta file, then what the location implies', () => {
    const meta = { agentType: 'Explore', description: null, toolUseId: null };
    expect(agentTypeFor('task', meta)).toBe('Explore');
    expect(agentTypeFor('task', null)).toBe('unknown');
    expect(agentTypeFor('workflow', null)).toBe('unknown');
    expect(agentTypeFor('aside', null)).toBe('aside_question');
  });
});
