// Generates a synthetic Claude Code `projects` folder: fake projects, sessions and subagents
// of every kind (task, workflow, /btw aside, warm-up, legacy inline sidechains). Everything
// is invented: fake paths (C:\Users\alex\dev\…), random ids, placeholder text.
//
// Usage: node scripts/gen-demo-data.mjs <output-projects-folder> [end-day YYYY-MM-DD]
//
// The data covers the 35 days that end with `end-day` (default: today). To look at it in
// the app, point the home folder at a fake one, for example on Windows:
//   node scripts/gen-demo-data.mjs <fake-home>/.claude/projects
//   $env:USERPROFILE = '<fake-home>'; electron . --user-data-dir=<scratch folder>
//
// The output folder must be new, empty, or one this script wrote before (it holds a
// marker file); the script never deletes anything else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.token-tracker-demo-data';

const [output, endDay] = process.argv.slice(2);
if (!output) {
  console.error('Usage: node scripts/gen-demo-data.mjs <output-projects-folder> [YYYY-MM-DD]');
  process.exit(1);
}
const root = path.resolve(output);
const realRoots = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.config', 'claude', 'projects'),
].map((dir) => path.resolve(dir).toLowerCase());
if (realRoots.includes(root.toLowerCase())) {
  console.error(`Refusing to write into the real Claude Code log folder ${root}.`);
  process.exit(1);
}
if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
  if (!fs.existsSync(path.join(root, MARKER))) {
    console.error(`${root} is not empty and was not written by this script: pick another folder.`);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, MARKER), 'Synthetic data from scripts/gen-demo-data.mjs\n');

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const int = (min, max) => Math.floor(min + rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

const PROJECTS = ['demo-app', 'data-pipeline', 'web-shop', 'notes-cli', 'game-proto'];
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

let counter = 0;
function assistant({ ts, session, cwd, model, u, stop = 'end_turn', sidechain = false, agentId }) {
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
      id: `msg_demo_${counter}`,
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
    requestId: `req_demo_${counter}`,
    uuid: `uuid-demo-${counter}`,
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

const DAY = 86_400_000;
// Mid-afternoon UTC of the last day; sessions start some hours before it.
const now = endDay
  ? Date.parse(`${endDay}T15:00:00Z`)
  : Math.min(Date.now(), Date.parse(`${new Date().toISOString().slice(0, 10)}T15:00:00Z`));
if (!Number.isFinite(now)) {
  console.error('The end day must be written YYYY-MM-DD.');
  process.exit(1);
}
let sessions = 0;

for (let dayBack = 34; dayBack >= 0; dayBack--) {
  if (rand() < 0.2) continue; // days off
  const perDay = int(1, 3);
  for (let s = 0; s < perDay; s++) {
    sessions++;
    const project = pick(PROJECTS);
    const folder = `C--Users-alex-dev-${project}`;
    const cwd = `C:\\Users\\alex\\dev\\${project}`;
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
console.log(`${sessions} synthetic sessions written to ${root}`);
