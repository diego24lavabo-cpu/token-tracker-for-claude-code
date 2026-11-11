/**
 * Discovery and incremental reading of Claude Code transcripts.
 *
 * Every `*.jsonl` file under the `projects` roots is found recursively. For each file the
 * database remembers its size, modification time and how many bytes were read, so a later
 * scan only reads what was appended. Files are streamed in chunks and never loaded whole.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentInput, DatabaseStats, FileState, MessageInput, UsageDatabase } from './db';
import {
  locateInSessionFolder,
  modelDisplayName,
  parseLine,
  projectNameFromCwd,
  projectNameFromFolder,
  type SessionFolderLocation,
  type UsageRecord,
} from './parser';
import {
  agentTypeFor,
  attributeRecord,
  classifyLogFile,
  readAgentMeta,
  type AgentMeta,
  type LogFileClass,
} from './subagents';

/** Bytes read from disk at a time. A single line can span several chunks. */
const CHUNK_BYTES = 1024 * 1024;
/** How many leading bytes identify a file, to notice when it is replaced. */
const HEAD_BYTES = 256;
/** Stored as modification time while a file is only partly read, so the next scan retries it. */
const PARTIAL_READ = -1;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
/** Some editors put this invisible character at the start of a file they save. */
const BYTE_ORDER_MARK = 0xfeff;

export interface ScanSummary {
  roots: string[];
  filesFound: number;
  subagentFilesFound: number;
  filesRead: number;
  filesUnchanged: number;
  filesFailed: number;
  bytesRead: number;
  linesRead: number;
  /** Assistant records with usage found in the bytes read, duplicates included. */
  usageRecords: number;
  /** Records stored for the first time. */
  imported: number;
  duplicates: number;
  /** Known records completed or moved by a better copy. */
  upgraded: number;
  /** Lines that could not be read: broken JSON or a malformed assistant record. */
  skippedLines: number;
  durationMs: number;
  /** State of the whole database after the scan. */
  database: DatabaseStats;
}

interface DiscoveredFile {
  path: string;
  root: string;
  size: number;
  mtimeMs: number;
  /** True when a sibling `.meta.json` exists. */
  hasMeta: boolean;
  cls: LogFileClass;
}

interface ScanContext {
  db: UsageDatabase;
  summary: ScanSummary;
  /** Project recovered for each session folder, keyed by root and folder name. */
  folderProjects: Map<string, string>;
  /** Cache of `locateInSessionFolder`, which is needed once per record. */
  cwdLocations: Map<string, SessionFolderLocation | null>;
  modelNames: Map<string, string>;
}

const folderKey = (root: string, projectFolder: string) => `${root}\u0000${projectFolder}`;

/** Finds every transcript under `root`. Unreadable folders are skipped. */
async function discover(root: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const pending = [root];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    const currentDir = dir;

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry.name);
        // Symbolic links are not followed, which also rules out loops.
        if (entry.isDirectory()) {
          pending.push(fullPath);
          return;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) return;
        try {
          const stat = await fs.promises.stat(fullPath);
          found.push({
            path: fullPath,
            root,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hasMeta: names.has(entry.name.replace(/\.jsonl$/i, '.meta.json')),
            cls: classifyLogFile(root, fullPath),
          });
        } catch {
          // The file disappeared between the listing and the stat.
        }
      }),
    );
  }
  return found;
}

async function readHead(
  filePath: string,
  length: number,
): Promise<{ length: number; hash: string }> {
  if (length <= 0) return { length: 0, hash: '' };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      length: bytesRead,
      hash: createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Project of a record. The session folder is the reference: the record's `cwd` is walked
 * up until it matches the folder, so a `cd` into a subfolder does not create a new
 * project. A `cwd` outside the folder's tree falls back to `basename(cwd)`, except in a
 * subagent transcript, where the project is the parent session's.
 */
function resolveProject(
  record: UsageRecord,
  file: DiscoveredFile,
  context: ScanContext,
): SessionFolderLocation {
  const key = folderKey(file.root, file.cls.projectFolder);

  if (record.cwd) {
    const cacheKey = `${record.cwd}\u0000${file.cls.projectFolder}`;
    let location = context.cwdLocations.get(cacheKey);
    if (location === undefined) {
      location = locateInSessionFolder(record.cwd, file.cls.projectFolder);
      context.cwdLocations.set(cacheKey, location);
    }
    if (location) {
      context.folderProjects.set(key, location.project);
      return location;
    }

    if (file.cls.isSubagentFile) {
      const parentProject = context.folderProjects.get(key);
      if (parentProject) return { project: parentProject, subfolder: '' };
    }
    const fromCwd = projectNameFromCwd(record.cwd);
    if (fromCwd) return { project: fromCwd, subfolder: '' };
  }

  return {
    project: context.folderProjects.get(key) ?? projectNameFromFolder(file.cls.projectFolder),
    subfolder: '',
  };
}

function modelName(modelId: string, context: ScanContext): string {
  let name = context.modelNames.get(modelId);
  if (name === undefined) {
    name = modelDisplayName(modelId);
    context.modelNames.set(modelId, name);
  }
  return name;
}

/** Reads what is new in one file and stores it. */
async function readFile(
  file: DiscoveredFile,
  previous: FileState | undefined,
  context: ScanContext,
): Promise<void> {
  const { db, summary } = context;
  const { cls } = file;

  // Start over when the file is new, shrank, or no longer begins with the same bytes.
  let startOver = !previous || file.size < previous.offset;
  if (previous && !startOver && previous.headLength > 0) {
    const head = await readHead(file.path, previous.headLength);
    startOver = head.length !== previous.headLength || head.hash !== previous.headHash;
  }
  const head = await readHead(file.path, Math.min(HEAD_BYTES, file.size));

  const state: FileState = {
    path: file.path,
    root: file.root,
    projectFolder: cls.projectFolder,
    isSubagent: cls.isSubagentFile,
    agentId: cls.agentId,
    size: file.size,
    mtimeMs: file.mtimeMs,
    offset: startOver || !previous ? 0 : previous.offset,
    headLength: head.length,
    headHash: head.hash,
    metaRead: startOver || !previous ? false : previous.metaRead,
    project: startOver || !previous ? null : previous.project,
    lines: startOver || !previous ? 0 : previous.lines,
    usageRecords: startOver || !previous ? 0 : previous.usageRecords,
    skipped: startOver || !previous ? 0 : previous.skipped,
  };

  let meta: AgentMeta | null = null;
  let metaStored = state.metaRead;
  if (cls.metaPath && file.hasMeta && !state.metaRead) {
    meta = await readAgentMeta(cls.metaPath);
    state.metaRead = meta !== null;
  }

  let messages: MessageInput[] = [];
  let agents: AgentInput[] = [];
  const seenAgents = new Set<string>();

  const handleLine = (line: Buffer, terminated: boolean): void => {
    let end = line.length;
    if (end > 0 && line[end - 1] === CARRIAGE_RETURN) end--;
    if (end === 0) return;
    let text = line.toString('utf8', 0, end);
    if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
    if (!/\S/.test(text)) return;

    const parsed = parseLine(text);
    // A line still being written is read again by the next scan, so it is not counted yet.
    if (terminated) {
      state.lines++;
      summary.linesRead++;
    }
    if (parsed.kind === 'ignored') return;
    if (parsed.kind === 'skipped') {
      if (terminated) {
        state.skipped++;
        summary.skippedLines++;
      }
      return;
    }
    if (terminated) {
      state.usageRecords++;
      summary.usageRecords++;
    }

    const { record } = parsed;
    const attribution = attributeRecord(cls, record);
    messages.push({
      dedupKey: record.dedupKey,
      timestamp: record.timestamp,
      sessionId: attribution.sessionId,
      ...resolveProject(record, file, context),
      modelId: record.modelId,
      model: modelName(record.modelId, context),
      kind: attribution.kind,
      agentId: attribution.agentId,
      rank: attribution.rank,
      stopReason: record.stopReason,
      tokens: record.tokens,
      cacheWrite1h: record.cacheWrite1h,
    });

    if (attribution.agentId !== null) {
      const agentKey = `${attribution.sessionId}\u0000${attribution.agentId}`;
      if (!seenAgents.has(agentKey)) {
        seenAgents.add(agentKey);
        const agentMeta = cls.isSubagentFile ? meta : null;
        agents.push({
          sessionId: attribution.sessionId,
          agentId: attribution.agentId,
          agentType: agentTypeFor(attribution.kind, agentMeta),
          meta: agentMeta,
        });
        if (agentMeta) metaStored = true;
      }
    }
  };

  const commit = (complete: boolean): void => {
    state.project =
      context.folderProjects.get(folderKey(file.root, cls.projectFolder)) ?? state.project;
    const counts = db.ingestBatch(
      complete ? state : { ...state, mtimeMs: PARTIAL_READ },
      messages,
      agents,
    );
    summary.imported += counts.inserted;
    summary.duplicates += counts.duplicates;
    summary.upgraded += counts.upgraded;
    messages = [];
    agents = [];
  };

  let carry: Buffer[] = [];
  const stream = fs.createReadStream(file.path, {
    start: state.offset,
    highWaterMark: CHUNK_BYTES,
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    summary.bytesRead += chunk.length;
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, from);
      if (newline === -1) break;
      const piece = chunk.subarray(from, newline);
      const line = carry.length > 0 ? Buffer.concat([...carry, piece]) : piece;
      carry = [];
      state.offset += line.length + 1;
      handleLine(line, true);
      from = newline + 1;
    }
    if (from < chunk.length) carry.push(chunk.subarray(from));
    commit(false);
  }

  // A last line without a newline may still be growing. It is read now, so nothing is
  // lost if it is complete, but the offset stays before it: deduplication makes reading
  // it again harmless.
  if (carry.length > 0) handleLine(Buffer.concat(carry), false);
  commit(true);

  if (meta && !metaStored) db.applyLateMeta(state, meta);
}

/**
 * Scans the given `projects` folders and stores what is new. Rows are never deleted when
 * a source file disappears: the database is the permanent history.
 */
export async function scanLogs(db: UsageDatabase, roots: string[]): Promise<ScanSummary> {
  const started = performance.now();
  const summary: ScanSummary = {
    roots,
    filesFound: 0,
    subagentFilesFound: 0,
    filesRead: 0,
    filesUnchanged: 0,
    filesFailed: 0,
    bytesRead: 0,
    linesRead: 0,
    usageRecords: 0,
    imported: 0,
    duplicates: 0,
    upgraded: 0,
    skippedLines: 0,
    durationMs: 0,
    database: db.stats(),
  };

  const states = db.loadFileStates();
  const context: ScanContext = {
    db,
    summary,
    folderProjects: new Map(),
    cwdLocations: new Map(),
    modelNames: new Map(),
  };
  for (const state of states.values()) {
    if (state.project)
      context.folderProjects.set(folderKey(state.root, state.projectFolder), state.project);
  }

  const files = (await Promise.all(roots.map(discover))).flat();
  // Main sessions first, oldest first: when a response was copied into several files,
  // the earliest one keeps it.
  files.sort(
    (a, b) =>
      Number(a.cls.isSubagentFile) - Number(b.cls.isSubagentFile) ||
      a.mtimeMs - b.mtimeMs ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  summary.filesFound = files.length;
  summary.subagentFilesFound = files.filter((file) => file.cls.isSubagentFile).length;

  for (const file of files) {
    const previous = states.get(file.path);
    const unchanged =
      previous !== undefined && previous.size === file.size && previous.mtimeMs === file.mtimeMs;

    try {
      if (!unchanged) {
        await readFile(file, previous, context);
        summary.filesRead++;
        continue;
      }
      summary.filesUnchanged++;
      // The meta file of a subagent can show up after its transcript was read.
      if (file.cls.metaPath && file.hasMeta && !previous.metaRead) {
        const meta = await readAgentMeta(file.cls.metaPath);
        if (meta) db.applyLateMeta({ ...previous, metaRead: true }, meta);
      }
    } catch (error) {
      summary.filesFailed++;
      console.warn(`[scan] Could not read a transcript (${errorCode(error)}), it will be retried.`);
    }
  }

  db.refreshDerived();
  summary.database = db.stats();
  summary.durationMs = Math.round(performance.now() - started);
  return summary;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.name : 'unknown error';
}

const integer = new Intl.NumberFormat('en-US');

/** A few lines describing a scan, for the console. They contain counts only. */
export function formatSummary(summary: ScanSummary): string[] {
  const { database } = summary;
  const { tokens } = database;
  const total = tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;
  const n = (value: number) => integer.format(value);

  return [
    `[scan] ${n(summary.filesFound)} transcript files (${n(summary.subagentFilesFound)} from subagents) ` +
      `in ${n(summary.roots.length)} folder(s): ${n(summary.filesRead)} read, ` +
      `${n(summary.filesUnchanged)} unchanged, ${n(summary.filesFailed)} failed`,
    `[scan] ${n(summary.linesRead)} lines, ${n(summary.usageRecords)} usage records: ` +
      `${n(summary.imported)} new, ${n(summary.duplicates)} duplicates, ` +
      `${n(summary.upgraded)} completed, ${n(summary.skippedLines)} lines skipped`,
    `[scan] database: ${n(database.messages)} messages, ${n(database.sessions)} sessions, ` +
      `${n(database.subagentRuns)} subagent runs, ${n(database.projects)} projects, ` +
      `${n(database.models)} models`,
    `[scan] tokens: ${n(total)} total = ${n(tokens.input)} input + ${n(tokens.output)} output + ` +
      `${n(tokens.cacheWrite)} cache write + ${n(tokens.cacheRead)} cache read`,
    `[scan] done in ${n(summary.durationMs)} ms (${n(summary.bytesRead)} bytes read)`,
  ];
}
