# Test fixtures

Everything in this folder is **synthetic**: invented project names, fake paths
(`/Users/alex/dev/demo-app`, `C:\Users\alex\dev\demo-app`), fake ids and placeholder
text. Never add real Claude Code logs here.

Each root mimics a Claude Code `projects` folder.

| Path | What it covers |
| --- | --- |
| `mac/projects/-Users-alex-dev-demo-app/1111….jsonl` | streamed duplicates, a broken line, a record without usage, a synthetic message, the subagent rollup that must not be counted, a `cwd` in a subfolder, partial streamed counts |
| `…/1111…/subagents/agent-…0001.jsonl` + `.meta.json` | task subagent with a meta file |
| `…/1111…/subagents/agent-…0002.jsonl` | subagent without a meta file and without `agentId` on its records |
| `…/1111…/subagents/agent-…0003.jsonl` | warm-up agent: one output token, no stop reason |
| `…/1111…/subagents/agent-aside_question-…0004.jsonl` | `/btw` side question that repeats its parent's history |
| `…/1111…/subagents/workflows/wf_demo01/agent-…0005.jsonl` | workflow agent |
| `mac/projects/-Users-alex-dev-demo-app/2222….jsonl` | legacy inline sidechain lines, with and without `agentId` |
| `mac/projects/-Users-alex-dev-other-tool/3333….jsonl` | a second project, a `cwd` outside the session folder, a record without `cwd`, timestamps close to midnight UTC |
| `win/projects/C--Users-alex-dev-demo-app/` | Windows paths, with one subagent |

The expected totals are written out in `tests/scanner.test.ts`.
