# Progress

Status of the build plan in [SPEC.md](SPEC.md) §8. Read this first when resuming work.

## Done

| Step                           | Commit                | Content                                                                       |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| 1. Scaffold + repo files       | `33a47d4`             | Electron + Vite + React + TS, title bar, sidebar, page shells, repo files, CI |
| 2. Parser, subagents, database | `09c4ceb`             | Recursive scan, dedup, subagents, SQLite history, incremental reads           |
| 3. IPC API + Overview          | `380bda0` + follow-up | `getOverview`, KPI cards, daily chart, shortcut cards, cost estimate          |
| 4. Projects page               | `92776dd`             | `getProjects`, `getProjectDetail`, sortable `DataTable`, analysis panel       |
| 5. Models page                 | "Add the Models page" | `getModels`, model cards, weekly share (12 weeks), token types per model      |

CI (lint, typecheck, tests on macOS and Windows) is green up to `f4c2318`.

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

**Projects page**

- `getProjects` returns `{ hasData, kpis, rows }` rather than the bare `ProjectRow[]` of SPEC §6, so the KPI row also comes from the main process.
- Sessions per project: a session counts in every project where it has activity, from the derived table `session_projects` (one row per session and project, with the session's start day and its tokens in that project). So no project shows tokens with 0 sessions, and the column does not add up to the session total; its header tooltip says "Sessions with activity in this project". Tok/session = the project's tokens in those sessions / their count, subagents included.
- Global session totals (Projects KPI, Overview, the future Sessions page) still count each session once, from `sessions`, whose `project` stays the one with the most tokens.
- `startDayWhere` now applies the project filter too (sessions, session_projects and subagents have a project column).
- "Last used" is the last day with usage of the project, whatever the selected period (the machine and other filters still apply). Out/In = output / total input; the panel's "output %" = output / all tokens.
- Agent types in the panel are grouped by type and kind, so a warm-up never mixes with real invocations. `aside_question` shows as `/btw`, `unknown` as "Unknown type" (`src/lib/agents.ts`, ids in `shared/agents.ts`).
- Layout: the panel sits next to the table from 1600 px (`2fr / minmax(460px, 1fr)`). Inside, the panel lays itself out with container queries (1, 2 or 3-zone grid), whatever its position.
- Reusable pieces for later steps: `DataTable` (sort on header click, `aria-sort`, nulls last, optional row selection through a button in the first cell), `src/lib/sort.ts`, `MainSubagentBars` (Agents page), `HourBars` (Calendar), `HBars`, `SplitBar` (Machines), `ChartTooltip`, `formatRelativeDay`.

**Models page**

- `getModels` returns `{ hasData, cards, weekly, weeklyModels }`. `weekly[i].tokens` is an array in the order of `weeklyModels` (largest first over the 12 weeks), not a record keyed by model name.
- The weekly chart always covers the 12 weeks (Monday to Sunday, `weekStart` / `lastWeeks` in `shared/period.ts`) that end with the week of the period's last day, whatever the period's length. The machine and other filters apply. The current week is partial.
- One color per model, the same on the cards and in the charts: the period's models in card order, then the models seen only in the 12 weeks (`seriesColor` in `src/lib/chart.ts`: accent, light, dark, pale, then two heat colors).
- Card numbers: messages = deduplicated responses (warm-ups included, they are API calls); output/msg = output / messages; subagent share = tokens with `kind <> 'main'` / model tokens; top project = most tokens on that model. Each card's cost is that model alone; a model without a price shows "—".
- Token types bar: raw input, output, cache read, cache write, as shares of the model's tokens. Its label shows the cache hit rate (cache read / total input).
- No KPI row: the spec and the mockup have none on this page.
- `TooltipRow` takes a `color` for swatches without a theme class.

**Database**

- Schema version 4. Versions 2 and 3 empty the `files` table so the transcripts still on disk are read again to fill the new columns. Version 4 adds `session_projects` and rebuilds the derived tables from `messages` (checked on a real version-3 database).
- Sync (step 10): the `sessions` rows of the sync format carry one project. To keep per-project session counts for other machines, they will also need the list of projects of each session (with tokens), or a `sessionProjects` array.

## Open points

- The container flags are set only in the local dev database. A new database, such as the installed app's, needs them again: there is no Settings control until step 9.
- The first real subagent transcript on this PC (an Explore run, 2026-11-11) shows up in the Projects panel under TTfCC. Workflow, `/btw` and warm-up agents are still verified only on synthetic fixtures.
- Not checked yet: the macOS title bar, and the Windows window buttons, which screenshots do not capture.
- Prices must be verified before release.
- File watching is not in yet (step 9): the app scans only at startup.

## Step 6 starts here: Calendar page

Spec: SPEC.md §5, Calendar. Suggested effort: `high`.

1. Same path as `getModels`: types in `shared/types.ts`, a channel in `shared/ipc.ts`, `preload.ts`, a `handle()` in `electron/main.ts` with an `empty*` fallback. SPEC §6 signature: `getCalendar(machineIds?)`; it ignores the period but follows the machine filter. It needs today's local day: pass `now` like `getOverview` (`db.localDay(now)`).
2. `getCalendar` in `electron/aggregate.ts`: heatmap of the last 12 months (53 columns × 7 rows, weeks start Monday: reuse `weekStart`), KPIs (active days x/365, current streak: reuse `currentStreak`, longest streak, best day, average per active day), tokens by weekday, by hour (24) and by month (12).
3. UI in `src/pages/Calendar.tsx`: a custom CSS-grid heatmap (ramp `--heat-0` to `--heat-4`, month and day labels, "Less → More" legend, a tooltip per cell). Reuse `KpiCard` (`kpi-grid--5`), `HourBars`, `ChartTooltip`. Best weekday in `--accent-light`. Clicking a day opens Sessions filtered to that day: the Sessions page comes in step 7, so navigate with the day in the route and let step 7 read it.
4. Tests in `tests/aggregate.test.ts`: the heatmap days add up to the Overview total over the same range; streaks across a gap; weekday of a Sunday (fixture 2026-11-08, `win` root).

Run tests from PowerShell: under Git Bash, vitest loads twice (drive letter case) and fails with "failed to find the current suite". Bash heredocs that contain quotes also fail in this shell: write files with the editor tools instead.
