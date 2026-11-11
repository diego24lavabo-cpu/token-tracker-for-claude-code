# Progress

Status of the build plan in [SPEC.md](SPEC.md) §8. Read this first when resuming work.

## Done

| Step                           | Commit                | Content                                                                       |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| 1. Scaffold + repo files       | `33a47d4`             | Electron + Vite + React + TS, title bar, sidebar, page shells, repo files, CI |
| 2. Parser, subagents, database | `09c4ceb`             | Recursive scan, dedup, subagents, SQLite history, incremental reads           |
| 3. IPC API + Overview          | `380bda0` + follow-up | `getOverview`, KPI cards, daily chart, shortcut cards, cost estimate          |

CI (lint, typecheck, tests on macOS and Windows) is green up to `380bda0`.

## Decisions and deviations from the spec

**Repository**

- Mockups live in `docs/mockup/` but are gitignored: they show real project names. Files renamed `01-overview.png` to `09-settings.png`.
- TypeScript is pinned to `~6.0`: `typescript-eslint` does not support 7 yet.
- `release.yml` is deferred to step 11. CI uses Node 24 and `actions/checkout@v7`, `actions/setup-node@v7`.
- No `electron-builder install-app-deps` postinstall. better-sqlite3 13 ships prebuilt Node-API binaries that load in both Node (tests) and Electron. `.npmrc` sets `ignore-scripts=true` and `electron-builder.yml` sets `npmRebuild: false`; Electron downloads its binary on first run.

**App shell**

- Sidebar items use the small square bullets of the mockup, not lucide icons.
- The packaged app cancels every network request and has a strict CSP; the dev server CSP allows HMR. Vite keeps every asset a file (`assetsInlineLimit: 0`) because the CSP blocks `data:` fonts.
- Dev runs use their own data folder, `%APPDATA%\Token Tracker for Claude Code (dev)`. Demo mode (`npm run dev:demo`) is only a flag so far; sample data comes in step 11.
- `vite.config.mts` deletes `ELECTRON_RUN_AS_NODE`, which VS Code leaks into child processes.
- Ctrl+1…8 (Cmd on macOS) open the sections, by physical key so AZERTY works.

**Reading the logs**

- Project = the directory a session folder stands for, recovered by walking `cwd` up until its encoding matches the folder name. `basename(cwd)` is only the fallback for a `cwd` outside that tree. Reason: `cd` into subfolders would otherwise split projects. The first-level subfolder is stored per response (`messages.subfolder`).
- Container folders: a folder project listed in the `container_projects` setting is reported under its first-level subfolders. Responses at the top of the folder keep its name. This is applied when the derived tables are built, so `messages` keeps the raw names and the flags can change without losing history.
- Duplicated responses: the key is `message.id:requestId`, global. The largest token values and the first stop reason win. When copies sit in different places, the owning main session beats copied history, which beats a subagent, which beats a `/btw` transcript. Files are read main sessions first, then oldest first.
- "Lines skipped" counts only unreadable lines (broken JSON, malformed assistant records), not the many lines without usage.
- Warm-up agent: a task or workflow agent with at most 1 output token in total and no stop reason. Warm-ups are not counted as invocations; `/btw` side questions are.
- Legacy inline sidechain lines without `agentId` form one `inline` agent per session.
- A last line without a newline is read, but the offset stays before it, so it is read again once complete.
- When the system time zone changes, local days and hours are recomputed from the UTC timestamps.

**Numbers**

- Durations are active time: the sum of gaps between consecutive responses, leaving out any gap over 30 minutes. A session's gaps run across all its responses, subagents included. The first-to-last span is stored too and is shown only in the session drawer (step 7).
- 1-hour cache writes are stored separately (`cache_write_1h`, part of `cache_write`) and priced at 2× input instead of 1.25×. `pricing.json` has five prices per model. Defaults come from Anthropic's price list cached on 2026-11-03, with a TODO to verify. Haiku 5.5's cache-read price is derived, and its price for prompts over 100K tokens is not modelled.
- Period comparison: "New activity" when the period before had under 5% of the current usage, otherwise a signed percentage.
- The Machines shortcut card ignores the machine filter.
- The streak counts back from today; when today has no usage yet, from yesterday.

**Database**

- Schema version 3. Versions 2 and 3 empty the `files` table so the transcripts still on disk are read again to fill the new columns.

## Open points

- The container flags are set only in the local dev database. A new database, such as the installed app's, needs them again: there is no Settings control until step 9.
- There are no subagent transcripts on this PC: subagent handling is verified only on synthetic fixtures.
- Not checked yet: the macOS title bar, and the Windows window buttons, which screenshots do not capture.
- Prices must be verified before release.
- File watching is not in yet (step 9): the app scans only at startup.

## Step 4 starts here: Projects page

Spec: SPEC.md §5, Projects. Suggested effort: `high`.

1. Types in `shared/types.ts`, channels in `shared/ipc.ts`, then `preload.ts` and a `handle()` in `electron/main.ts`, following `getOverview`.
2. `getProjects(filters)` and `getProjectDetail(project, filters)` in `electron/aggregate.ts`. Sources: `hourly` (tokens by day, hour, model, kind, agent type, machine), `sessions` (count and tokens per project, by `start_day`), `subagents`. Reuse `hourlyWhere` and `startDayWhere`, and validate input with `parseFilters`.
3. UI in `src/pages/Projects.tsx`: KPI row, a sortable and searchable table (a reusable `DataTable` is needed, since every table must sort), and the analysis panel. The panel sits next to the table at 1600 px and wider. Reuse `KpiCard`, `useRangeFilters`, `useUsageQuery`, `src/lib/chart.ts` and `src/lib/format.ts`. All strings go in `src/i18n/en.ts`.
4. Tests in `tests/aggregate.test.ts` against the fixtures. The fixture totals are listed at the top of `tests/scanner.test.ts`.
