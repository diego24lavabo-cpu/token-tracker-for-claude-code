/**
 * Subagent detection.
 *
 * Claude Code delegates work to subagents (Task tool, built-in agents, custom agents,
 * workflow agents). Each one has its own transcript:
 *
 *   projects/<encoded-project-path>/
 *   ├─ <session-id>.jsonl                      main session
 *   └─ <session-id>/subagents/
 *      ├─ agent-<agentId>.jsonl                one transcript per invocation
 *      ├─ agent-<agentId>.meta.json            { agentType, description, toolUseId }
 *      ├─ agent-aside_question-<id>.jsonl      `/btw` side questions
 *      └─ workflows/wf_<id>/agent-<agentId>.jsonl
 *
 * Older Claude Code versions wrote subagent lines inline in the main session file, marked
 * with `isSidechain: true`. Both layouts are supported.
 */
import fs from 'node:fs';
import type { AgentKind } from '../shared/types';
import type { UsageRecord } from './parser';

/** What the location of a transcript says about it. Warm-ups are only known from content. */
export type BaseKind = Exclude<AgentKind, 'warmup'>;

export const UNKNOWN_AGENT_TYPE = 'unknown';
/** Agent type given to `/btw` side questions, which have no meta file. */
export const ASIDE_AGENT_TYPE = 'aside_question';
/** Legacy sidechain lines without an `agentId` are grouped per session under this id. */
export const INLINE_AGENT_ID = 'inline';

const ASIDE_FILE_PREFIX = 'agent-aside_question';
const META_MAX_BYTES = 1024 * 1024;
const DESCRIPTION_MAX_CHARS = 2000;
const AGENT_TYPE_MAX_CHARS = 120;

/** What the path of a `.jsonl` file tells about its content. */
export interface LogFileClass {
  /** First path segment under the `projects` root, for example `-Users-alex-dev-demo-app`. */
  projectFolder: string;
  /** True when the file sits under a `subagents/` folder. */
  isSubagentFile: boolean;
  /** Session the file belongs to: its own name, or the session folder it sits in. */
  fileSessionId: string | null;
  /** Subagent identity taken from `agent-<agentId>.jsonl`. Null for main session files. */
  agentId: string | null;
  kind: BaseKind;
  /** Path of the sibling `agent-<agentId>.meta.json`. Null for main session files. */
  metaPath: string | null;
}

/** Classifies a transcript from its path. `root` is the `projects` folder it was found in. */
export function classifyLogFile(root: string, filePath: string): LogFileClass {
  const relative = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';
  const stem = fileName.replace(/\.jsonl$/i, '');
  // A transcript directly under the root has no project folder.
  const projectFolder = segments.length > 1 ? (segments[0] ?? '') : '';
  const inner = segments.slice(1, -1);

  const subagentsIndex = inner.indexOf('subagents');
  if (subagentsIndex === -1) {
    return {
      projectFolder,
      isSubagentFile: false,
      fileSessionId: inner[0] ?? (stem || null),
      agentId: null,
      kind: 'main',
      metaPath: null,
    };
  }

  let kind: BaseKind = 'task';
  if (fileName.startsWith(ASIDE_FILE_PREFIX)) kind = 'aside';
  else if (inner[subagentsIndex + 1] === 'workflows') kind = 'workflow';

  return {
    projectFolder,
    isSubagentFile: true,
    fileSessionId: subagentsIndex > 0 ? (inner[subagentsIndex - 1] ?? null) : null,
    agentId: stem.replace(/^agent-/, '') || null,
    kind,
    metaPath: filePath.replace(/\.jsonl$/i, '.meta.json'),
  };
}

export interface AgentMeta {
  agentType: string;
  /** Task text given to the subagent. Kept locally only: never synced, never exported. */
  description: string | null;
  toolUseId: string | null;
}

/** Reads `agent-<agentId>.meta.json`. Returns null when it is missing or unreadable. */
export async function readAgentMeta(metaPath: string): Promise<AgentMeta | null> {
  try {
    const stat = await fs.promises.stat(metaPath);
    if (!stat.isFile() || stat.size > META_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const meta = parsed as Record<string, unknown>;

    const agentType = typeof meta.agentType === 'string' ? meta.agentType.trim() : '';
    if (!agentType) return null;
    return {
      agentType: agentType.slice(0, AGENT_TYPE_MAX_CHARS),
      description:
        typeof meta.description === 'string' && meta.description
          ? meta.description.slice(0, DESCRIPTION_MAX_CHARS)
          : null,
      toolUseId: typeof meta.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null,
    };
  } catch {
    return null;
  }
}

/** Agent type of a transcript: from its meta file, else from what its location implies. */
export function agentTypeFor(kind: BaseKind, meta: AgentMeta | null): string {
  if (meta) return meta.agentType;
  return kind === 'aside' ? ASIDE_AGENT_TYPE : UNKNOWN_AGENT_TYPE;
}

/**
 * How strongly a record belongs where it was found. The same API response can be logged
 * in several places: a resumed session copies earlier lines into a new file, and a `/btw`
 * transcript can repeat the whole parent conversation. Each response is stored once; when
 * copies disagree about where it belongs, the highest rank wins.
 */
export const RANK = {
  /** A `/btw` transcript, which may only be repeating its parent's history. */
  aside: 1,
  /** A subagent transcript or an inline sidechain line. */
  subagent: 2,
  /** A main session line whose `sessionId` is not the file's own: copied history. */
  copiedMain: 3,
  /** A main session line in its own session file. */
  ownMain: 4,
} as const;

/** Where one usage record belongs. */
export interface Attribution {
  sessionId: string;
  kind: BaseKind;
  /** Null for the main session. */
  agentId: string | null;
  rank: number;
}

/**
 * Decides whether a record belongs to the main session or to a subagent.
 *
 * A record is a subagent record when its file sits under `subagents/` or when it has
 * `isSidechain: true`. A subagent is identified by its `agentId`, never by the
 * `sessionId` found in its file: that one points at the parent session, which is how
 * the subagent is linked to its parent.
 */
export function attributeRecord(file: LogFileClass, record: UsageRecord): Attribution {
  const sessionId = record.sessionId ?? file.fileSessionId ?? 'unknown';

  if (file.isSubagentFile) {
    return {
      sessionId,
      kind: file.kind,
      agentId: file.agentId ?? record.agentId ?? INLINE_AGENT_ID,
      rank: file.kind === 'aside' ? RANK.aside : RANK.subagent,
    };
  }

  if (record.isSidechain) {
    return {
      sessionId,
      kind: 'task',
      agentId: record.agentId ?? INLINE_AGENT_ID,
      rank: RANK.subagent,
    };
  }

  const isOwnSession = record.sessionId === null || record.sessionId === file.fileSessionId;
  return {
    sessionId,
    kind: 'main',
    agentId: null,
    rank: isOwnSession ? RANK.ownMain : RANK.copiedMain,
  };
}
