# Progress

Status of the build plan in [SPEC.md](SPEC.md) §8. Read this first when resuming work.

## Done

| Step                           | Commit                | Content                                                                       |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| 1. Scaffold + repo files       | `33a47d4`             | Electron + Vite + React + TS, title bar, sidebar, page shells, repo files, CI |
| 2. Parser, subagents, database | `09c4ceb`             | Recursive scan, dedup, subagents, SQLite history, incremental reads           |
| 3. IPC API + Overview          | `380bda0` + follow-up | `getOverview`, KPI cards, daily chart, shortcut cards, cost estimate          |
| 4. Projects page               | `92776dd`             | `getProjects`, `getProjectDetail`, sortable `DataTable`, analysis panel       |
| 5. Models page                 | `6e79f86` + follow-up | `getModels`, model cards, weekly share (12 weeks), token types per model      |
| 6. Calendar page               | `43c447e`             | `getCalendar`, 12-month heatmap, streak KPIs, weekday / hour / month charts   |
| 7. Sessions page               | (this commit)         | `getSessions`, `getSessionDetail`, histograms, paged table, detail drawer     |

CI (lint, typecheck, tests on macOS and Windows) is green up to `e018d16`.

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
- Token types bar: raw input, output, cache read, cache write, as shares of the model's tokens. Its label shows the cache hit rate (cache read / total input). Cache read dominates (about 98% on real data), so every non-zero segment is at least 4 px wide, and the four shares are written under the bar ("<0.1%" rather than "0%" for a type with tokens). Token counts are in the tooltips.
- Weekly share opens in % mode (each week with usage is a 100% bar, Recharts `stackOffset="expand"`); a small "Tokens | %" toggle in the header switches to token heights. The choice is not remembered. `SegmentedControl` has a `size="small"` variant for card headers.
- Model cards stretch to fill the row (`auto-fit`), at most four per row, at least 290 px wide.
- No KPI row: the spec and the mockup have none on this page.
- `TooltipRow` takes a `color` for swatches without a theme class.

**Calendar page**

- `getCalendar(machineIds?)` returns `{ hasData, today, heatmap, kpis, byWeekday, bestWeekday, byHour, byMonth }`. Only the machine filter applies. The main process decides today (`db.localDay(now)`) and sends it back; the page refetches when `useToday` changes, so the calendar rolls over at midnight.
- The 12 months = 365 days ending today (`today - 364` to today). They always span exactly 53 Monday-first weeks, because `today - 364` is the same weekday as today. `heatmap.weeks[i].days` has 7 entries, `null` for the days before the range (start of the first column) and after today (end of the last). Heatmap total = Overview total over `heatmap.from`…`heatmap.to` (tested).
- Heat levels are computed in the main process: 0 = no usage, 1 to 4 by quartile of the active days (`thresholds` = where levels 2, 3, 4 start). Quartiles rather than a share of the maximum, so one huge day does not turn every other day into level 1. The legend swatches give the token range of each level in their tooltip.
- KPIs: active days x / 365. The current streak is the same rule as the Overview (from yesterday while today is empty), now returned as `{ days, from, to }`; `currentStreak` in `aggregate.ts` returns that object and the Overview keeps `.days`. It also ignores `hourly` rows with 0 tokens now. The longest streak is counted inside the 365 days only (a run that started before is cut). Ties go to the most recent run and the most recent best day.
- By weekday and by hour cover the 365 days. By month covers the 12 calendar months ending with the current one (Dec 2025 to Nov 2026 on 2026-11-12): the first month starts on its 1st, a little after the heatmap's `from`, and the current month is partial ("so far" in its tooltip). The busiest weekday (`bestWeekday`, chosen in the main process) is drawn in `--accent-light` and named in the card header.
- Sessions per heatmap day = sessions **with activity that day**, subagents included, from `messages` (`COUNT(DISTINCT session_id)` per `local_day`). A session that runs past midnight counts on both days. Start-day counting showed "55.5M tokens, 0 sessions" on real data. `messages` holds only this machine's responses, so another machine's filter gives 0 sessions per day until sync carries them (see Database below).
- Clicking a day with usage navigates to `/sessions?day=YYYY-MM-DD` (`sessionsOfDay()` and `SESSIONS_DAY_PARAM` in `src/routes.ts`). Days without usage do nothing (`aria-disabled`).
- Heatmap UI (`src/components/Heatmap.tsx`): a CSS grid of `<button>`s with roving focus. The grid is one tab stop; the arrow keys move by a day (up/down) or a week (left/right), Home/End go to the first day / today. The tooltip opens on hover, and on keyboard focus only (`:focus-visible`), so a mouse click does not leave it stuck open. It sits above the cell, or below it when the card has no room above, and is kept inside the card horizontally. Today has a thin white inner border. Month labels sit over the column holding the 1st of the month, plus the first column when the next label is at least 3 columns away. Cells grow with the width, up to about 30 px (they fill a maximized 1920 px window).
- The header's period selector is disabled on this page (greyed, tooltip "The calendar always shows the last 12 months"): `Page periodIgnored`, `SegmentedControl disabledReason`.
- Layout: the three charts sit side by side from 1280 px (weekday, hour, month); below that, weekday and hour share a row and the months take the next one.
- New reusable pieces: `CategoryBars` (one labeled bar per category, optional highlight), `formatDay(day, { weekday: true })` → `Tue, Nov 10`, `formatMonth`, `en.dates.weekdays` / `weekdaysLong`. `HourBars` takes a `shareLabel`.

**Sessions page**

- `getSessions(filters: SessionFilters, page, sort)` returns `{ hasData, kpis, sizeHist, durationHist, rows, total, page, pageSize, projects, models }`. `getSessionDetail(machineId, sessionId)`: the machine id is added to the SPEC §6 signature because `sessions` is keyed by both. It returns `null` for an unknown session.
- Day filter: `SessionFilters.day` replaces `from`…`to`. It lists the sessions **with activity that day** (`messages.local_day`, subagents included), the same rule as the heatmap tooltip, so the click shows as many rows as the tooltip said (tested, including a session that runs past midnight). Shown as a removable chip; while it is on, the header's period selector is greyed with the reason. Removing it replaces the history entry. An invalid `?day=` is ignored. Like the heatmap, only this machine has sessions by day until sync.
- Without a day, a session counts on its start day, so the page's count equals the Overview's Sessions card (tested). Session totals include their subagents and add up to the Overview total when no session crosses the period's edges (tested).
- Project filter = sessions with activity in the project (`session_projects`, as on Projects). Model filter = the main model (the Model column). The menus list the period's projects and models, their own choice aside. Filters are page state, not in the URL. `agentTypes` and `kinds` do not apply here.
- Durations are active time everywhere on the page (KPIs, histogram, Duration column, timeline), instead of the spec's "last − first of the main session" for the histogram. The first-to-last span is only in the drawer ("First to last").
- Messages = main-session responses (`sessions.messages`); subagent calls are not messages. Sessions per active day = sessions / days on which they started (1 with the day filter). Biggest session = most tokens, the latest on a tie. Histogram bins include their lower bound (`50k` is in 50–200k).
- Cost per session: this machine's sessions are priced model by model from `messages` (1-hour cache writes included), and the sum over a period equals the Overview cost (tested). Other machines' sessions will only have their main model, which then prices all their tokens (see Database below).
- Sorting and paging run in the main process: every matching session is loaded, priced, sorted in JS (cost needs the pricing), then cut into pages of 25. A page past the end returns the last one. Ties go to the latest start; sessions without a cost go last in both directions. The page resets to the first when the filters or the sort change.
- Drawer (`src/components/SessionDrawer.tsx`): next to the table from 1600 px (`2fr / minmax(420px, 1fr)`, sticky), over the right side of the page below that. It takes the focus on open; Escape or the close button closes it and puts the focus back. It shows the stats, the main vs subagents split (bar, plus a token-type table), then every subagent transcript, warm-ups included and greyed, so main + subagents = the session total. Its Subagents count leaves warm-ups out, like the table. Timeline bars sit on the span of the session and its subagents; the faint band is the main session.
- New reusable pieces: controlled sorting in `DataTable` (`sort` + `onSortChange`, `Column.sortable`); `CategoryBars` items take `value` (was `tokens`) with optional `valueLabel` / `formatValue`, for count histograms; `KpiCard title`; `formatDecimal`; `db.localDayTime(ts)` and `LocalClock.toLocalMinute`; CSS `.icon-button`, `.select-field`, `.filter-chip`, `.pager`.

**Database**

- Schema version 4. Versions 2 and 3 empty the `files` table so the transcripts still on disk are read again to fill the new columns. Version 4 adds `session_projects` and rebuilds the derived tables from `messages` (checked on a real version-3 database).
- Sync (step 10): the `sessions` rows of the sync format carry one project. To keep per-project session counts for other machines, they will also need the list of projects of each session (with tokens), or a `sessionProjects` array.
- Sync (step 10): the heatmap counts sessions with activity per day from `messages`, which the sync format does not have. The sync files will need per-day session activity (for example the active days of each session) for other machines' heatmap tooltips and the Sessions day filter.
- Sync (step 10): session costs of other machines need per-model tokens per session (with the 1-hour cache share). Until then they are priced at the session's main model.

## Open points

- The container flags are set only in the local dev database. A new database, such as the installed app's, needs them again: there is no Settings control until step 9.
- The first real subagent transcript on this PC (an Explore run, 2026-11-11) shows up in the Projects panel under TTfCC. Workflow, `/btw` and warm-up agents are still verified only on synthetic fixtures.
- Not checked yet: the macOS title bar, and the Windows window buttons, which screenshots do not capture.
- Prices must be verified before release.
- File watching is not in yet (step 9): the app scans only at startup.
- `getSessions` loads every session of the range to sort and page them in JS. Instant on this PC's history (a few dozen sessions); re-check with years of data, `1y` on a heavy user.

## Step 8 starts here: Agents page

Spec: SPEC.md §5, Agents. Suggested effort: `high`.

1. Same path as the other pages: types in `shared/types.ts`, a channel in `shared/ipc.ts`, `preload.ts`, a `handle()` in `electron/main.ts` with an `empty*` fallback. SPEC §6: `getAgents(f)` → `{ kpis, daily, byType, startupByType, top, kinds, modelsMainVsSub }`.
2. The `subagents` table has one row per invocation with `kind` (warm-ups already derived), `agent_type`, `active_ms`, `startup_input`, `calls` and the token types. Warm-ups are not invocations (see "Reading the logs"); keep them out of the averages, but show them in the Kinds breakdown. Tokens per day come from `hourly` (`kind <> 'main'`), as on the Overview and Projects.
3. Durations are active time, as on Sessions. Agent type names go through `agentTypeLabel` / `agentKindLabel` (`src/lib/agents.ts`).
4. Reuse `MainSubagentBars` (main vs subagents per day), `HBars` (startup cost by type), `DataTable` (by type, top 10) and `SplitBar`. A row of the top 10 could open its session in `SessionDrawer` (it takes `machineId` + `sessionId`).
5. Empty state when there are no subagents yet (SPEC §5 Empty states).
6. Tests in `tests/aggregate.test.ts`: subagent share and invocations match the Overview shortcut; warm-ups counted apart; the fixture's agent types and kinds.

Run tests from PowerShell: under Git Bash, vitest loads twice (drive letter case) and fails with "failed to find the current suite". Bash heredocs that contain quotes also fail in this shell: write files with the editor tools instead.
