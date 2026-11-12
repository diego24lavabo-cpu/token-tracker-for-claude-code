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
| 7. Sessions page               | `c3dff4b`             | `getSessions`, `getSessionDetail`, histograms, paged table, detail drawer     |
| 8. Agents page                 | `d002f1d`             | `getAgents`, KPIs, daily main vs subagents, by type, startup, kinds, top 10   |
| 9. Settings, CSV, watching     | `7f1b298`             | Settings page, container switches, price editor, chokidar, CSV, rebuild       |
| 9b. Container folder groups    | (this commit)         | `<folder> › <subfolder>` names, expandable folder rows on Projects            |

CI (lint, typecheck, tests on macOS and Windows) is green up to `e018d16`.

## Decisions and deviations from the spec

**Repository**

- Mockups live in `docs/mockup/` but are gitignored: they show real project names. Files renamed `01-overview.png` to `09-settings.png`.
- TypeScript is pinned to `~6.0`: `typescript-eslint` does not support 7 yet.
- `release.yml` is deferred to step 11. CI uses Node 24 and `actions/checkout@v7`, `actions/setup-node@v7`.
- `scripts/gen-demo-data.mjs <projects-folder> [end-day]` writes a synthetic Claude Code `projects` folder: 5 fake projects, about 50 sessions over the 35 days ending today (or `end-day`), with subagents of every kind (task, workflow, `/btw`, warm-up, legacy inline lines with and without `agentId`). Seeded, so the same day gives the same data; fake paths only (`C:\Users\alex\dev\…`). It refuses the real log folders and any non-empty folder it did not write (it leaves a `.token-tracker-demo-data` marker). Used for the step 8 screenshots. **Step 11's demo mode should reuse it** (for example by generating into a temporary folder and scanning that into an in-memory database), rather than writing a second generator.
- No `electron-builder install-app-deps` postinstall. better-sqlite3 13 ships prebuilt Node-API binaries that load in both Node (tests) and Electron. `.npmrc` sets `ignore-scripts=true` and `electron-builder.yml` sets `npmRebuild: false`; Electron downloads its binary on first run.

**App shell**

- Sidebar items use the small square bullets of the mockup, not lucide icons.
- The packaged app cancels every network request and has a strict CSP; the dev server CSP allows HMR. Vite keeps every asset a file (`assetsInlineLimit: 0`) because the CSP blocks `data:` fonts.
- Dev runs use their own data folder, `%APPDATA%\Token Tracker for Claude Code (dev)`. Demo mode (`npm run dev:demo`) is only a flag so far; sample data comes in step 11.
- `vite.config.mts` deletes `ELECTRON_RUN_AS_NODE`, which VS Code leaks into child processes.
- Ctrl+1…8 (Cmd on macOS) open the sections, by physical key so AZERTY works.

**Reading the logs**

- Project = the directory a session folder stands for, recovered by walking `cwd` up until its encoding matches the folder name. `basename(cwd)` is only the fallback for a `cwd` outside that tree. Reason: `cd` into subfolders would otherwise split projects. The first-level subfolder is stored per response (`messages.subfolder`).
- Container folders: a folder project listed in the `container_projects` setting is reported under its first-level subfolders, named **`<folder> › <subfolder>`** (for example `VS Code › Astrophotography_TM`; `PROJECT_SEPARATOR` and `containerOf` / `subfolderOf` in `shared/projects.ts`). Responses at the top of the folder keep the folder's name. This is applied when the derived tables are built, so `messages` keeps the raw names and the flags can change without losing history. Because the full name is the project name in every derived table, every page, filter and export shows it as is (Overview main project, Sessions table and project filter, Agents top 10, CSV); only the Projects table shortens it under its folder.
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
- **Container folder groups** (after step 9): a project named `<folder> › <subfolder>` is nested in `ProjectRow.children` of one row for the folder; the folder's own top-level usage (the project named like the folder) is one more child, labeled `<folder> (root)`. Grouping goes by the separator in the name, not by this machine's flags, so it will also work for synced names. The folder row is computed in SQL by folder (`BY_FOLDER` in `aggregate.ts`), not summed in JS: tokens, input, output and shares equal the sum of the children (tested), but sessions count a session once per folder (a session working in two subfolders counts in both children and once in the folder), and active days, main model and last used are the folder's own. The KPIs still count projects (the leaves), so "Active projects" includes each subfolder.
- Table: folders are collapsed by default, with a ▸/▾ button in front of the select button of the first cell (`DataTable rowPrefix`, `rowClassName`); children are indented. Sorting is controlled by the page: top-level rows sort by the chosen column, children within their folder by the same column. Search matches the label (subfolder name, or `<folder> (root)`); a match inside a folder opens it and shows only the matching children, a match on the folder name shows the folder as the user left it. Clicking the folder row shows the whole folder's analysis (`getProjectDetail(project, filters, folder = true)`, `ProjectDetail.folder`, the panel title says "whole folder"); clicking a child shows only that project. The projects CSV lists the leaves (full names), largest first.
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

**Agents page**

- `getAgents(filters)` returns `{ hasData, hasSubagents, kpis, daily, byType, startupByType, top, kinds, modelsMainVsSub }`. `hasSubagents` = any subagent run ever on the selected machines; without one the page shows the "No subagents yet" empty state (what subagents are), whatever the period.
- Two sources, as on the other pages: tokens per day, the subagent share and the models bars come from `hourly` (by local day of each response); everything per run (KPI averages, by type, startup, kinds, top 10) from `subagents`, where a run counts on its **start day** and in its main project. So the "by type" tokens add up to the subagent total when no run crosses the period's edges (true on the fixture, tested).
- KPI rules. Subagent share and invocations are the Overview shortcut's numbers (tested). Invocations = runs that are not warm-ups, `/btw` included; per session = invocations / sessions started in the period. **The averages (tokens + median, startup cost, duration) use only task and workflow runs**: `/btw` side questions re-log the conversation and warm-ups never ran, so they would skew them (the card tooltips say so). Sessions with subagents = sessions with `subagent_count > 0` (warm-ups do not count).
- By type: one row per agent type **and kind**, warm-ups included as their own rows (greyed run count with a tooltip: not invocations). Share = part of the table's tokens. Output % = output / all tokens. Main model = the model with the most tokens in these runs. Cost: this machine's runs are priced model by model from `messages` (1-hour cache included; the sum over types = the Overview cost of the subagent kinds, tested); another machine's run only has its main model, which prices all its tokens.
- Startup by type: average first-request input, largest first, warm-ups left out. Workflow types are labeled `wf · <type>`.
- Kinds: always the four kinds (task, workflow, `/btw`, warm-up) with run counts and share of subagent tokens, a one-line description under each and an info tooltip. Badges use `agentKindName` (`Task`, `Workflow`, `/btw`, `Warm-up`).
- Top 10: the runs with the most tokens, warm-ups left out; clicking a row opens its session in `SessionDrawer` (same layout rules as the Sessions page). The legacy inline bucket (agent id `inline`, now `INLINE_AGENT_ID` in `shared/agents.ts`) is labeled "Inline (legacy)" there (`agentRunLabel`); in the by-type table it stays under "Unknown type", as in the Projects panel.
- Models used: two stacked bars (main sessions, subagents), colored by one shared model order (largest overall first, `seriesColor`), with the shares written under each bar.
- Layout: KPI row of 6 (`kpi-grid--6`, 3 + 3 below 1180 px). Daily chart + Kinds side by side at every width (`3fr / 2fr`, `2fr / 1fr` from 1280 px); by-type table full width (scrolls inside its card at 1100); startup + models side by side; top 10 full width. Checked at 1100, 1440 and 1920 px on a synthetic data folder (51 sessions, 115 invocations of every kind, warm-ups and legacy inline lines; from `scripts/gen-demo-data.mjs`) and at 1440 on the real logs.
- New reusable pieces: `HBars` items take `value` (shown instead of the percentage) and `title`; `.kind-badge`, `.info-hint`, `.chart-card-header--stacked`.

**Settings page, file watching, CSV (step 9)**

- API added to SPEC §6: `getSettings()`, `setSettings(patch)` (launch at login, file watching, container projects, pricing; returns the new `SettingsData` and sends `usageUpdated`), `addLogFolder()`, `removeLogFolder(path)`, `scanNow()`, `exportCsv(kind, filters)`, `rebuildDatabase()`, `keepHistoryLonger()`. Patches are checked in `electron/settings.ts` (`parseSettingsPatch`), prices strictly by `validatePricing` (an invalid entry throws instead of being dropped, max 10,000 $/M).
- Preferences live in the database's `settings` table: `file_watching` (on unless `'0'`), `extra_log_roots` (JSON list of absolute paths), plus the existing `container_projects`. Launch at login is read from and written to the OS (`app.setLoginItemSettings`); it is disabled in dev runs ("Available in the installed app") and on Linux.
- **Container folders control**: a card listing every folder project with usage in subfolders (from `messages`, raw names, this machine only), plus the flagged ones even without usage. Each row: name, subfolder count, top 4 subfolders, share of its tokens in subfolders, and a switch. Flagged first, then by tokens in subfolders. A switch calls `setContainerProjects`, which rebuilds the derived tables (on the task chain, see below). On the real logs it lists `VS Code` (2 subfolders, 87%), `AURA_GAME` and `TTfCC`.
- **Task chain** in `main.ts`: scans, rebuilds, container changes and watcher changes run one after another (`serial`). A scan requested while one is already waiting is merged into it.
- **File watching** (`electron/watcher.ts`, chokidar 4, kept external by `notBundle` like better-sqlite3): watches the existing roots recursively, `ignoreInitial`, files other than `*.jsonl` / `*.meta.json` ignored, folders always followed. Debounce 2 s **with a 10 s maximum wait**: Claude Code appends every few seconds during a long answer, so a pure 2 s debounce could postpone the refresh for minutes. While watching, the roots are re-checked every 60 s, so a folder that appears later is picked up. Turning watching on runs a catch-up scan. Later scans log one line instead of the full summary.
- **Rebuild database** = forget the `files` table (`resetFileStates`) and scan: every transcript still on disk is read again and the derived tables are rebuilt in full. Messages are never deleted, so usage whose transcript is gone survives (tested). Native confirmation dialog.
- **Keep history longer**: reads `cleanupPeriodDays` from `claudeSettingsFile()` (the first `CLAUDE_CONFIG_DIR` folder, else `~/.claude/settings.json`). The button shows while the value (default 30) is below 365. After a native confirmation it writes 365, keeping every other key (`JSON.stringify(…, 2)` through a temp file + rename). A file that is not valid JSON (comments) is never written: the dialog says to edit it by hand.
- **Add folder**: picking `~/.claude` means its `projects` subfolder (`logFolderFromPick`). Added folders show an "Added" badge and a remove button; removing one stops reading it, history stays. `AppInfo.logRoots` now includes them.
- **CSV export**: native save dialog, default `Downloads/token-tracker-<kind>-<from>-to-<to>.csv`, for the header's period and machines. UTF-8 with BOM, CRLF, raw numbers (shares as fractions, costs rounded to 4 decimals, empty cell = no price), text cells starting with `= + - @` prefixed with `'`. Projects, models and agent types come from `getProjects` / `getModels` / `getAgents`. Daily comes from a new `getDailyExport` (same `hourly` source as the Overview chart, with the four token types, API calls and the day's cost; its totals and cost equal the Overview's, tested).
- **Price editor**: rows for the used models (most tokens first), "Show all models" for the rest. A row is complete or, for a model without a default price, empty (= no price). "Reset to defaults" only fills the form; nothing is saved until "Save prices". `lastChecked` is a `YYYY-MM-DD` text field with a "Today" button, not `<input type="date">`, which displays in the OS language (`03.11.2026`).
- Native dialog strings are in `en.dialogs` (`src/i18n/en.ts`, imported by `main.ts`).
- Layout: Data sources, Application, Container folders, Sync in CSS columns (3 from 1280 px, 2 below; cards pack top to bottom), the price table full width below. The Sync card is a read-only placeholder (status, this machine, known machines) for step 10. New CSS: `.button` (+ `--primary`, `--small`), `.switch` (`Switch` component, `role="switch"`), `.settings-*`, `.warning-badge`. New format helpers: `formatBytes`, `formatTimeAgo`.
- Empty state: when no log folder exists, the Overview says so and offers "Choose a folder…" and "Open Settings".
- Checked at 1100, 1440 and 1920 px on synthetic data plus a synthetic container folder, driven over CDP: the switch splits the folder, an appended transcript line appears within 4.5 s, a saved price changes the cost and Reset restores it, an invalid price blocks saving. Not checked by a human yet: the native dialogs (folder picker, save, confirmations).

**Database**

- Schema version 5. Versions 2 and 3 empty the `files` table so the transcripts still on disk are read again to fill the new columns. Version 4 adds `session_projects` and rebuilds the derived tables from `messages` (checked on a real version-3 database). Version 5 only rebuilds the derived tables, for the `<folder> › <subfolder>` names (checked on a version-4 database with a flagged folder).

## Open points

- The container flags, file watching switch and added folders are per database: the dev database and the installed app's each keep their own (set them in Settings).
- The first real subagent transcript on this PC (an Explore run, 2026-11-11) shows up in the Projects panel under TTfCC and on the Agents page. Workflow, `/btw`, warm-up and legacy inline agents are still verified only on synthetic data.
- Not checked yet: the macOS title bar, and the Windows window buttons, which screenshots do not capture.
- Prices must be verified before release.
- Launch at login is only testable in the installed app (step 11).
- chokidar 4 uses one `fs.watch` per folder. Fine for this PC's history; re-check the startup time and handle count with ~500 session folders (SPEC §9).
- `getSessions` loads every session of the range to sort and page them in JS. Instant on this PC's history (a few dozen sessions); re-check with years of data, `1y` on a heavy user. `getAgents` does the same with the period's subagent runs.

**Step 10 (sync format) — open points**

- **Required: the sync format must carry per-model tokens for each session** (the four token types plus the 1-hour cache-write share, per model), so the costs of other machines' sessions are exact. Today a session of another machine only has its main model, which prices all its tokens (`sessionCosts` in `aggregate.ts`). The same applies to subagent runs (`subagentRuns[].tokens` per model), used by the Agents page's per-type costs (`agentTypeModels`).
- The `sessions` rows carry one project. To keep per-project session counts for other machines, they also need the projects of each session with their tokens (or a `sessionProjects` array).
- The heatmap counts sessions with activity per day from `messages`, which the sync format does not have. The sync files need per-day session activity (for example the active days of each session) for other machines' heatmap tooltips and the Sessions day filter.
- Container folders are applied when the derived tables are built, so the synced aggregates carry the **source machine's** split, as `<folder> › <subfolder>` names; the Projects page groups them by that name whatever machine they come from. Decide whether a machine's flags should also apply to other machines' unsplit names (a folder named `VS Code` flagged on one machine only), or leave it to the project aliases of SPEC §5b.
- Sync should export after a scan that changed something (SPEC §5b: 60 s debounce, at most every 5 min): hook it on the task chain in `main.ts` after `scanLogs`, and put its own card where the Sync placeholder is.

## Step 10 starts here: Google Drive sync + Machines page

Spec: SPEC.md §5b, §5 Machines and Settings → Sync, §8 step 10, §9 sync tests. Suggested effort: **`xhigh`**.

1. Read "Step 10 (sync format) — open points" above first: the sync files need per-model tokens per session and per subagent run, the projects of each session, and per-day session activity, or other machines' costs and counts will be approximate.
2. `electron/sync.ts`: Drive folder detection (any `GoogleDrive-*` account, any "My Drive" language, Windows drive letters, folder picker fallback), atomic per-year export, polling read of `machines/*/` (30 s), broken JSON / conflict copies ignored, other machines stored in their own tables.
3. Settings: replace the read-only Sync card (`SyncCard` in `src/pages/Settings.tsx`) with on/off, folder, this machine's name, known machines, "Sync now", project aliases, "Remove this machine". Title bar status.
4. Machines page (SPEC §5) and the machine selector with real machines.
5. To check a page on many fake sessions: `node scripts/gen-demo-data.mjs <fake-home>/.claude/projects`, then start the built app with `USERPROFILE` (and `HOME`) set to `<fake-home>` and `--user-data-dir=<scratch folder>` (see "Repository"). A second machine can be faked the same way with another fake home and data folder.
   Run tests from PowerShell: under Git Bash, vitest loads twice (drive letter case) and fails with "failed to find the current suite". Bash heredocs that contain quotes also fail in this shell: write files with the editor tools instead.
