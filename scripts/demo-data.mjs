// Synthetic Claude Code `projects` folder: fake projects, sessions and subagents of every
// kind (task, workflow, /btw aside, warm-up, legacy inline sidechains). Everything is
// invented: fake paths (C:\Users\alex\dev\… or /Users/alex/dev/…), seeded random ids,
// placeholder text.
//
// Used by scripts/gen-demo-data.mjs (command line) and by the app's demo mode
// (electron/demo.ts). Plain JavaScript so that both Node and the app bundle can load it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Left in every folder written here, so a later run may replace it. */
export const DEMO_MARKER = '.token-tracker-demo-data';

export const DEMO_PROJECTS = ['demo-app', 'data-pipeline', 'web-shop', 'notes-cli', 'game-proto'];

const MAIN_MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5'];
/** [agent type, model, startup tokens] */
const TASK_TYPES = [
  ['Explore', 'claude-haiku-5-5', 8000],
  ['Explore', 'claude-haiku-5-5', 8000],
  ['Plan', 'claude-fable-5-2', 12000],
  ['general-purpose', 'claude-opus-5-5', 18000],
  ['code-reviewer', 'claude-opus-5-5', 80000],
  ['test-runner', 'claude-sonnet-5-5', 16000],
];
const WORKFLOW_TYPES = [
  ['build-check', 'claude-sonnet-5-5', 21000],
  ['lint-fix', 'claude-haiku-5-5', 9000],
];

const DAY = 86_400_000;

/**
 * Empties `root` for new data, or throws when it is a real Claude Code log folder or a
 * non-empty folder this module did not write. Nothing else is ever deleted.
 */
function prepareFolder(root) {
  const realRoots = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
    ...(process.env.CLAUDE_CONFIG_DIR ?? '')
      .split(',')
      .filter((dir) => dir.trim())
      .map((dir) => path.join(dir.trim(), 'projects')),
  ].map((dir) => path.resolve(dir).toLowerCase());
  if (realRoots.includes(root.toLowerCase())) {
    throw new Error(`Refusing to write into the real Claude Code log folder ${root}.`);
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    if (!fs.existsSync(path.join(root, DEMO_MARKER))) {
      throw new Error(`${root} is not empty and was not written by this script.`);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, DEMO_MARKER), 'Synthetic data from scripts/demo-data.mjs\n');
}

/**
 * Writes a synthetic `projects` folder into `output` and returns the number of sessions.
 *
 * @param {string} output
 * @param {import('./demo-data.d.mts').DemoDataOptions} [options]
 */
export function generateDemoData(output, options = {}) {
  const {
    endDay,
    days = 35,
    seed: initialSeed = 42,
    paths = 'windows',
    projects = DEMO_PROJECTS,
    sessionsPerDay = [1, 3],
    dayOffRate = 0.2,
  } = options;
  const root = path.resolve(output);

  // Mid-afternoon UTC of the last day; sessions start some hours before it.
  const now = endDay
    ? Date.parse(`${endDay}T15:00:00Z`)
    : Math.min(Date.now(), Date.parse(`${new Date().toISOString().slice(0, 10)}T15:00:00Z`));
  if (!Number.isFinite(now)) throw new Error('The end day must be written YYYY-MM-DD.');
  if (!Number.isInteger(days) || days < 1) throw new Error('The number of days must be 1 or more.');

  prepareFolder(root);

  // mulberry32: 32-bit integer steps, so the sequence does not repeat after a few thousand
  // draws (which gave later sessions the ids, and files, of earlier ones).
  let seed = initialSeed >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => Math.floor(min + rand() * (max - min + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

  // Ids must not collide between two folders generated for two fake machines.
  const idPrefix = `demo${initialSeed}`;
  let counter = 0;
  function assistant({
    ts,
    session,
    cwd,
    model,
    u,
    stop = 'end_turn',
    sidechain = false,
    agentId,
  }) {
    counter++;
    return JSON.stringify({
      parentUuid: null,
      isSidechain: sidechain,
      userType: 'external',
      cwd,
      sessionId: session,
      version: '2.1.300',
      ...(agentId ? { agentId } : {}),
      type: 'assistant',
      message: {
        id: `msg_${idPrefix}_${counter}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'Synthetic response.' }],
        stop_reason: stop,
        stop_sequence: null,
        usage: {
          input_tokens: u[0],
          output_tokens: u[1],
          cache_creation_input_tokens: u[2],
          cache_read_input_tokens: u[3],
        },
      },
      requestId: `req_${idPrefix}_${counter}`,
      uuid: `uuid-${idPrefix}-${counter}`,
      timestamp: new Date(ts).toISOString(),
    });
  }

  function write(file, lines) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((line) => line + '\n').join(''));
  }

  function writeMeta(dir, agentId, agentType, description) {
    fs.writeFileSync(
      path.join(dir, `agent-${agentId}.meta.json`),
      JSON.stringify({ agentType, description, toolUseId: `toolu_${hex(8)}` }),
    );
  }

  /** A subagent run: `calls` responses from `start`, the first one loading `startup` tokens. */
  function runLines({ session, cwd, model, start, calls, startup, agentId, warmup = false }) {
    const lines = [];
    let ts = start;
    let context = startup;
    for (let i = 0; i < calls; i++) {
      const last = i === calls - 1;
      const u = warmup
        ? [4, 1, 0, startup]
        : [int(5, 60), int(40, 900), i === 0 ? startup : int(500, 4000), i === 0 ? 0 : context];
      lines.push(
        assistant({
          ts,
          session,
          cwd,
          model,
          u,
          stop: warmup ? null : last ? 'end_turn' : 'tool_use',
          sidechain: true,
          agentId,
        }),
      );
      context += u[2] + int(200, 2000);
      ts += int(4, 40) * 1000;
    }
    return { lines, end: ts };
  }

  const location = (project) =>
    paths === 'posix'
      ? { folder: `-Users-alex-dev-${project}`, cwd: `/Users/alex/dev/${project}` }
      : { folder: `C--Users-alex-dev-${project}`, cwd: `C:\\Users\\alex\\dev\\${project}` };

  let sessions = 0;
  for (let dayBack = days - 1; dayBack >= 0; dayBack--) {
    if (rand() < dayOffRate) continue; // days off
    const perDay = int(sessionsPerDay[0], sessionsPerDay[1]);
    for (let s = 0; s < perDay; s++) {
      sessions++;
      const project = pick(projects);
      const { folder, cwd } = location(project);
      const session = uuid();
      const model = pick(MAIN_MODELS);
      let ts = now - dayBack * DAY - int(1, 10) * 3600_000 - int(0, 59) * 60_000;
      const main = [];
      const responses = int(6, 40);
      let context = int(15000, 30000);
      const legacy = sessions % 9 === 0;
      const subagentDir = path.join(root, folder, session, 'subagents');

      for (let r = 0; r < responses; r++) {
        main.push(
          assistant({
            ts,
            session,
            cwd,
            model,
            u: [int(5, 80), int(50, 1500), int(300, 5000), context],
          }),
        );
        context += int(500, 6000);
        ts += int(10, 240) * 1000;

        if (rand() >= 0.14) continue;
        const agentId = hex(16);
        if (legacy) {
          // Legacy inline sidechain lines in the main file, with and without agentId.
          const run = runLines({
            session,
            cwd,
            model: 'claude-sonnet-5-5',
            start: ts,
            calls: int(2, 6),
            startup: int(5000, 9000),
            agentId: rand() < 0.5 ? agentId : undefined,
          });
          main.push(...run.lines);
          ts = run.end;
          continue;
        }
        const roll = rand();
        if (roll < 0.6) {
          const [type, agentModel, startup] = pick(TASK_TYPES);
          const run = runLines({
            session,
            cwd,
            model: agentModel,
            start: ts,
            calls: int(3, 30),
            startup: startup + int(-1500, 1500),
            agentId,
          });
          write(path.join(subagentDir, `agent-${agentId}.jsonl`), run.lines);
          writeMeta(subagentDir, agentId, type, 'Synthetic task.');
          ts = run.end;
        } else if (roll < 0.75) {
          const [type, agentModel, startup] = pick(WORKFLOW_TYPES);
          const wf = path.join(subagentDir, 'workflows', `wf_${hex(6)}`);
          const run = runLines({
            session,
            cwd,
            model: agentModel,
            start: ts,
            calls: int(4, 25),
            startup: startup + int(-1000, 1000),
            agentId,
          });
          write(path.join(wf, `agent-${agentId}.jsonl`), run.lines);
          writeMeta(wf, agentId, type, 'Synthetic step.');
          ts = run.end;
        } else if (roll < 0.85) {
          // /btw side question: re-reads the whole history.
          const run = runLines({
            session,
            cwd,
            model,
            start: ts,
            calls: 1,
            startup: context,
            agentId,
          });
          write(path.join(subagentDir, `agent-aside_question-${agentId}.jsonl`), run.lines);
        } else {
          // Warm-up: one output token, no stop reason.
          const [type, agentModel] = pick(TASK_TYPES);
          const run = runLines({
            session,
            cwd,
            model: agentModel,
            start: ts,
            calls: 1,
            startup: int(4000, 6000),
            agentId,
            warmup: true,
          });
          write(path.join(subagentDir, `agent-${agentId}.jsonl`), run.lines);
          writeMeta(subagentDir, agentId, type, 'Synthetic warm-up.');
        }
      }
      write(path.join(root, folder, `${session}.jsonl`), main);
    }
  }
  return sessions;
}
