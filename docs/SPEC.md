# Token Tracker for Claude Code — Build Spec

> Paste this whole file into Claude Code (or put it in the repo as `docs/SPEC.md` and tell Claude Code: "Read docs/SPEC.md and build the app step by step").
> This is a **public open-source project on GitHub** from day one — see §2b.
> UI language: **English**. Code, comments and commit messages: English.

> **Visual reference.** Screenshots of the approved mockup are in the project folder **`docs/mockup/`** (one image per section: Overview, Projects, Models, Calendar, Sessions, Agents, Machines, Settings). **Open and study them before writing any UI code**, and match them as closely as possible: layout, spacing, colors, typography, chart styles. The mockup labels are in French; the real app is in English (§9). Where this spec and an image disagree, the spec wins. Mockup numbers are fake sample data: never copy them as values. The mockup images are kept **local only** (`docs/mockup/` is gitignored), so they are not part of the public repo.

> **Effort per step.** I switch the reasoning effort myself in Claude Code. At the **end of each step**, when you tell me how to test it, also say which effort to select for the next step, using this table:
>
> | Step (§8) | Effort |
> |---|---|
> | 1. Scaffold + repo files | `high` |
> | 2. Parser, subagents, local database + tests | **`xhigh`** |
> | 3. IPC API + Overview page | `high` |
> | 4. Projects page | `high` |
> | 5. Models page | `high` |
> | 6. Calendar page | `high` |
> | 7. Sessions page | `high` |
> | 8. Agents page | `high` |
> | 9. Settings, CSV export, file watching | `high` |
> | 10. Google Drive sync + Machines page | **`xhigh`** |
> | 11. Packaging `.dmg` + `.exe` + release workflow + demo mode | `high` |
> | 12. Windows testing & fixes | `high` |
>
> Bug-fix rounds: use the same effort as the step they belong to. If a bug persists after 2 attempts, recommend `xhigh`.

---

## 1. Goal

Build a **cross-platform desktop app (macOS + Windows)** — one codebase, native-feeling on both — that reads the local Claude Code session logs and shows a dark dashboard of token usage:

- an essential **Overview**, plus detailed analysis pages for **projects**, **models**, **calendar**, **sessions**, **subagents** and **machines**
- **multi-machine sync** through Google Drive (a Mac and a Windows PC in my case)

Everything runs **locally**. No network calls, no API keys, no telemetry.

---

## 2. Data source (important — read carefully)

### 2.1 Where the logs are
Claude Code writes JSONL transcripts under a `projects` folder. Scan **all** of these roots that exist, and merge them:

```
~/.claude/projects/
~/.config/claude/projects/          (newer installs)
$CLAUDE_CONFIG_DIR/projects/        (if the env var is set)
%USERPROFILE%\.claude\projects\     (Windows)
```

**Scan recursively** (`**/*.jsonl`), never just one level deep. The current layout is:

```
projects/<encoded-project-path>/
├─ <session-id>.jsonl                        # main session
└─ <session-id>/
   └─ subagents/
      ├─ agent-<agentId>.jsonl               # one transcript per subagent invocation
      ├─ agent-<agentId>.meta.json           # { "agentType", "description", "toolUseId" }
      └─ workflows/wf_<id>/
         ├─ agent-<agentId>.jsonl            # workflow-spawned agents
         └─ agent-<agentId>.meta.json
```

The session folder can also hold other spill-over files (large tool outputs). Only `*.jsonl` files with usage records matter; ignore the rest.

Use `os.homedir()` + `path.join` everywhere, and never hardcode `/` separators. On Windows the encoded folder name looks like `C--Users-alex-dev-demo-app` and `cwd` looks like `C:\Users\alex\dev\demo-app`. Use `path.win32.basename` or `path.posix.basename` depending on the string, so a Mac can also read Windows records (needed for sync).

### 2.2 Record format
Each line is a JSON object. The ones that carry usage have `"type": "assistant"` and look roughly like this:

```json
{
  "type": "assistant",
  "timestamp": "2026-11-10T12:52:03.120Z",
  "sessionId": "…",
  "cwd": "/Users/alex/dev/demo-app",
  "requestId": "req_…",
  "isSidechain": false,
  "agentId": "…",
  "message": {
    "id": "msg_…",
    "model": "claude-opus-5-5",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 567,
      "cache_creation_input_tokens": 8900,
      "cache_read_input_tokens": 45000
    }
  }
}
```

### 2.3 Parsing rules
1. **Be defensive.** The schema is not officially documented and changes between Claude Code versions. Skip lines that fail to parse or lack `message.usage`, never crash, and count the skipped lines.
2. **Deduplicate.** A streamed response is written as several lines that repeat the same `message.id` with the same usage object, and resumed sessions can repeat lines too. Dedup key = `message.id + requestId` (fall back to `message.id` alone, then to a hash of the line). Deduplicate **globally** (across files), not per file.
3. **Project name** = `basename(cwd)` when `cwd` exists. Otherwise decode the folder name (last segment). For subagent files, the project is the parent session's project.
4. **Model name**: derive it with a generic rule, so future models display correctly without a code change: `claude-<family>-<major>-<minor>[-date]` → `"<Family> <major>.<minor>"` (e.g. `claude-opus-5-5` → `Opus 5.5`, `claude-fable-5-2` → `Fable 5.2`). Keep a small override map for exceptions. Unknown formats: show the raw ID. Ignore `<synthetic>` models.
5. **Time zone**: bucket days and hours in the **system's local time zone** (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Never hardcode a zone. Store UTC timestamps, and convert only when aggregating for display.
6. Keep the 4 token types separate: input, output, cache write (`cache_creation_input_tokens`), cache read.
7. **Input vs Output**: total input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (everything sent to Claude). Total output = `output_tokens`. Use only the numbers from the logs, never estimate from text.

### 2.4 Subagents (important — handle in detail)
Claude Code can delegate work to **subagents** (Task tool, built-in agents like Explore or Plan, custom agents, workflow agents). Each one has its own context and its own API calls, and subagents often account for a large share of a session's tokens. They must be **counted** and **analysed**.

**Detection**
- A record belongs to a subagent if `isSidechain === true`, **or** its file sits under a `subagents/` folder.
- Subagent identity = `agentId` (from the record, or from the file name `agent-<agentId>.jsonl`). **Never** use the subagent file's `sessionId` as its identity, because it points at the **parent** session. Link the subagent to its parent through that `sessionId`.
- **Agent type** = `agentType` from the sibling `agent-<agentId>.meta.json` (e.g. `Explore`, `Plan`, `general-purpose`, `code-reviewer`). Missing meta file → `unknown`. Keep `description` from the meta file **locally only** (it can contain task text): never sync it, and never show it in demo screenshots.
- **Kind** of subagent, for grouping:
  - `task`: normal subagent files
  - `workflow`: files under `subagents/workflows/`
  - `aside`: files named `agent-aside_question-*` (created by the `/btw` side-question feature). They can re-log the whole conversation history, so show them as their own category, never mixed with normal subagents.
  - `warmup`: subagent transcripts with only 1 output token and `stop_reason: null` (background agents that never completed). Count them as their own kind so they are visible but don't distort the averages.
- **Legacy format**: older Claude Code versions wrote subagent lines **inline** in the main session file with `isSidechain: true` and no separate files. Support both. Inline sidechain lines without an `agentId` are grouped per session as one "inline subagents" bucket.

**No double counting**
- When the parent session delegates, it records a **rollup** of the subagent run (duration, token total, tool counts) inside a tool result. **Never** add those rollup numbers to the totals: they summarise usage that already appears in the subagent's own transcript. Only `message.usage` on assistant records counts.
- The global dedup (rule 2) also covers subagent files.

**Per-invocation metrics** (one row per `agentId`)
- parent session, project, machine, agent type, kind, model(s)
- start, end and duration (first and last timestamp)
- number of API calls (deduplicated assistant messages)
- tokens by type, plus total input and total output
- **startup cost** = total input of the **first** API call (the context the subagent loads before doing anything: system prompt, CLAUDE.md, tools)
- est. cost

### 2.5 Local storage (required)
Claude Code deletes old transcripts after `cleanupPeriodDays` (30 days by default, set in `~/.claude/settings.json`). The app therefore **keeps its own permanent history**:
- Use **SQLite** via `better-sqlite3`, stored in the app's user data folder (`app.getPath('userData')`). Rebuild it for Electron with `electron-builder install-app-deps` (postinstall), on both macOS and Windows.
- Tables (suggestion): `messages` (one row per deduplicated assistant record, with token types, model, project, session, agentId, isSubagent, kind, machineId, UTC timestamp), `sessions`, `subagents`, `files` (path, size, mtime, last byte offset read), `machines`, `settings`.
- **Never delete** rows because the source file disappeared.
- **Incremental scan**: for each file, store size, mtime and the last byte offset read. On change, read only the new bytes. If a file shrinks or gets replaced, re-read it fully (dedup protects against duplicates).
- Settings shows a hint with a button "Keep Claude Code history longer" that explains how to raise `cleanupPeriodDays`. Never edit the user's settings file without explicit confirmation.
- Schema migrations are versioned (`PRAGMA user_version`).

### 2.6 Cost estimate
- Show an **estimated** cost "at API prices" (for subscription users this is only an equivalent).
- Prices per million tokens (input / output / cache write / cache read) per model live in an editable `pricing.json` in the user data folder, editable from Settings, with a `lastChecked` date.
- Ship it with placeholder values and a clear TODO: **"Verify current prices at https://www.anthropic.com/pricing before release"**. Do not invent prices silently. Unknown model → cost shown as "—".

---

## 2b. Open source on GitHub

The repo is **public** from the first commit. Everything must be safe to publish and easy for others to install and contribute to.

### Naming & branding
- App name: **Token Tracker for Claude Code**. Repo name: `token-tracker-for-claude-code`. Bundle id: `io.github.<github-username>.tokentracker`. **Ask me for my GitHub username and the name for the license in step 1.**
- Do **not** use Anthropic's logo or the Claude logo. Make an original app icon: a simple abstract mark in `--accent` on `--bg-card`.
- README and the About screen must say: *"Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic."*

### Privacy: nothing personal in the repo, ever
- `.gitignore` must cover: `node_modules/`, `dist/`, `release/`, `out/`, `.env*`, `*.log`, `*.db`, `*.sqlite*`, exported CSVs, a personalised `pricing.json`, `.DS_Store`, `Thumbs.db`.
- **Test fixtures are 100% synthetic** (`tests/fixtures/`): invented project names, fake paths like `/Users/alex/dev/demo-app` and `C:\Users\alex\dev\demo-app`, fake ids, no real prompt or response text. Include fixtures for the new subagent layout, workflow agents, `/btw` aside files, warm-up agents and the legacy inline sidechain format.
- **Demo mode** (`npm run dev:demo`, plus an env flag) loads generated sample data, subagents included. All README screenshots are taken in demo mode, never with real data.
- No secrets, tokens or personal emails anywhere in code, config or git history. Commits use my GitHub no-reply email.
- Before every commit, check that `git status` contains no data file. Never commit anything from `~/.claude`.

### Repo files (create in step 1)
- `LICENSE` (**MIT**), `README.md` (hero screenshot in demo mode, features, install from Releases + opening unsigned apps on macOS and Windows, how sync works and what is synced, privacy section, build from source, disclaimer), `docs/SPEC.md` (this file), `docs/mockup/` (the reference images, local only and gitignored), `CONTRIBUTING.md`, `CHANGELOG.md` (Keep a Changelog, semver from `0.1.0`), `SECURITY.md`, `.github/ISSUE_TEMPLATE/` (bug, feature), `.github/pull_request_template.md`, `.editorconfig`, ESLint, Prettier.

### CI/CD with GitHub Actions
- `ci.yml`: on every push and PR, run install, lint, typecheck and `npm test` on **macos-latest and windows-latest**.
- `release.yml`: on a `v*` tag, build the `.dmg` (arm64 + x64) and the `.exe` (NSIS + portable), then upload them to a **draft GitHub Release** with the CHANGELOG section as notes.
- Builds are **unsigned** for now. Put the signing/notarization steps in the workflow, commented out, with a note (Apple Developer ID + notarization, Windows code-signing certificate).
- Prepare `electron-updater` config for GitHub Releases, but keep it disabled.

### Making it work for anyone, not just me
- No hardcoded usernames, emails, paths, machine names, project names or time zones.
- Google Drive detection works for **any** account (`GoogleDrive-*`) and any Drive language (`My Drive`, `Mon Drive`, `Meine Ablage`, `Mi unidad`…), with a folder picker as fallback.
- Sync is **off by default**, turned on in Settings with a clear explanation of what gets written to Drive.

---

## 3. Tech stack

- **Electron + Vite + React + TypeScript**
- Charts: **Recharts**, plus a **custom CSS-grid heatmap** for the calendar
- Storage: **SQLite (`better-sqlite3`)** in the main process (§2.5)
- File watching: **chokidar**. Refresh the dashboard automatically when a JSONL file changes (debounce 2 s). Watch the `projects` roots recursively, so new `subagents/` folders are picked up.
- Parsing in the **Electron main process** (Node `fs` streams + `readline`, never load a whole big file into one string). Send data to the renderer through a typed `contextBridge` IPC API (`contextIsolation: true`, `nodeIntegration: false`, strict CSP).
- Packaging: **electron-builder**
  - macOS: `dmg`, arm64 (Apple Silicon) + x64
  - Windows: `nsis` installer (`.exe`) + `portable`, x64
  - Scripts: `npm run dist:mac` on the Mac, `npm run dist:win` on Windows; CI builds both on tags (§2b)
- Window, per platform:
  - macOS: `titleBarStyle: 'hiddenInset'` (traffic lights on top of the dark UI)
  - Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay: { color: '#181816', symbolColor: '#F0EEE6', height: 44 }`
  - Leave the left 80 px of the title bar empty on macOS and the right 140 px on Windows (`process.platform`)
  - Min size 1100×720; the title bar is a drag region
- Cmd shortcuts on macOS / Ctrl on Windows; "Launch at login" via `app.setLoginItemSettings`; tray/menu-bar icon optional
- The UI and colors are **identical** on both platforms; only the title bar differs
- Tooling: ESLint, Prettier, vitest; `npm run dev`, `npm run dev:demo`, `npm run build`, `npm test`, `npm run dist:*`

---

## 4. Design system (must match `docs/mockup/`)

Dark background, all charts in **Claude orange**.

| Token | Value | Usage |
|---|---|---|
| `--bg-app` | `#0E0E0D` | outside / window background |
| `--bg-surface` | `#141413` | main area |
| `--bg-sidebar` | `#181816` | sidebar, title bar |
| `--bg-card` | `#1C1B19` | cards |
| `--border` | `#2A2925` | card borders, dividers |
| `--text` | `#F0EEE6` | primary text |
| `--text-muted` | `#A3A094` | labels, axes (passes 4.5:1 on cards) |
| `--accent` | `#D97757` | Claude orange, main chart color |
| `--accent-light` | `#F2B59B` | hover, 2nd series, highlights |
| `--accent-dark` | `#8E4A33` | 3rd series, 2nd machine |
| `--accent-pale` | `#FAE3D8` | 4th series |
| `--accent-output` | `#F2C4B0` | output segment in stacked bars |
| `--accent-bg` | `#2A1F1A` | selected nav item / selected row |

Heatmap ramp (0 → 4): `#262522`, `#5A3326`, `#8E4A33`, `#C2633F`, `#E8865F`.

Multi-series colors (models, token types, machines, main vs subagents) must differ in **lightness**, not only hue.

Typography: **Inter** for UI and **JetBrains Mono** for every number (bundle the fonts locally, no Google Fonts at runtime). Radius: cards 12 px, buttons 7–8 px. Spacing scale: 4 / 8 / 12 / 16 / 24 / 32. No emoji, no gradients, icons = simple stroke SVG (`lucide-react`).

---

## 5. Screens & layout

**Principle: the Overview shows only the essentials. Every detail lives in its own section, opened from the sidebar.** Each section page is packed with analysis (KPI row, charts, tables). The machine and period selectors in the header apply to every section.

### Global layout
- Left **sidebar** (220 px): logo "Token Tracker", then nav = Overview · Projects · Models · Calendar · Sessions · Agents · Machines · Settings (Settings separated at the bottom). Clicking an item switches the page in place (client-side routing, no reload) and highlights it. A small box at the bottom shows the data source path.
- Header of every page: title + one-line subtitle on the left. On the right: **machine selector** (`All | <machine names>`) and **period selector** (`7d | 30d | 90d | 1y`, default 30d). The 12-month heatmap ignores the period but follows the machine filter.
- Title bar: "Google Drive · N machines · synced X min ago" (or "Local only" when sync is off) with a small orange dot.
- Every chart has tooltips. Every table is sortable.

### Responsive layout: landscape first
The app will mostly be used in a **wide, landscape window** (laptop screen or desktop monitor, often maximized). Optimize every page for horizontal space and make it **adapt fluidly to the window size**:
- **Use the width.** Put cards and charts side by side instead of stacking them. Avoid long single-column pages that need lots of vertical scrolling.
- **Breakpoints** (window width), as a guide:
  - **≥ 1600 px** (large monitor): KPI rows on one line (4–6 cards). 2–3 charts per row. On Projects and Sessions, show the analysis panel or detail drawer **next to** the table instead of below it.
  - **1280–1600 px** (typical laptop, maximized): KPI rows on one line where possible. 2 charts per row.
  - **1100–1280 px** (minimum): cards wrap to 2–3 per row, charts go 1–2 per row, wide tables scroll horizontally inside their card.
- **Charts resize** with their container (Recharts `ResponsiveContainer`). Bar counts stay readable: thin bars and fewer x-labels when the chart gets narrow.
- **No fixed page width**: content fills the window, with a comfortable max width only for very wide screens (e.g. 2200 px, centered).
- Re-layout instantly while the window is being resized, with no reload and no jumps.
- The mockup screenshots in `docs/mockup/` were captured in a fairly narrow window, so some sections look stacked vertically. In the real app, use the side-by-side layouts above when there is room.

### Overview (home): essentials only
1. **4 KPI cards**: Total tokens (sub-line "+18% vs previous period", compared with the previous period of the same length) · Input tokens (+ % of total) · Output tokens (+ % of total) · Estimated cost (API prices).
2. **Tokens per day**: one stacked bar per day (input in `--accent`, output in `--accent-output` on top), y-axis with 3 ticks, "Peak: X" in the header. Tooltip: date · total · input · output · subagent share.
3. **6 shortcut cards**. Each one is a button that opens its section and shows one headline number:
   - Main project (name, %, tokens) → Projects
   - Main model (name, %, cache hit rate) → Models
   - Activity (current streak, active days) → Calendar
   - Sessions (count, average tokens) → Sessions
   - Subagents (share of total tokens, number of invocations) → Agents
   - Machines (share per machine, last sync) → Machines

Nothing else on the Overview.

### Projects
- **KPI row**: active projects · main project (+ %) · average tokens per session · output/input ratio ("1 token generated for N read") · share of the top 3 projects.
- **All-projects table** with search: Project · Tokens + share bar · Input · Output · Out/In % · **Subagent %** · Sessions · Tokens/session · Active days · Main model · Last used.
- **Project analysis panel** for the selected row (default = first row), with an `--accent` border:
  - summary line (tokens, sessions, output %, subagent %, est. cost)
  - tokens per day for that project (main vs subagents stacked)
  - models used (horizontal bars with %)
  - split by machine
  - top agent types used in this project
  - hour-of-day distribution (24 bars)

### Models
- **One card per model**: name + share, total tokens, input/output split bar, Input, Output, cache hit rate (`cache_read / total input`), est. cost, messages, average output per message, **share used by subagents**, top project.
- **Weekly share** (last 12 weeks): stacked bars, one segment per model.
- **Token types per model**: one horizontal stacked bar per model (input / output / cache read / cache write), with the cache hit rate in the label.

### Calendar
- **KPI row**: active days over 12 months (x/365 and %) · current streak · longest streak · best day (tokens + date) · average per active day.
- **12-month heatmap** (53 columns × 7 rows, weeks start Monday), with month labels, day labels, a "Less → More" legend and a tooltip per cell. Clicking a day opens Sessions filtered to that day.
- **3 charts side by side**: by weekday (best day highlighted in `--accent-light`) · by hour of day (24 bars) · by month (12 bars).

### Sessions
- **KPI row**: sessions (+ per active day) · average duration (+ median) · tokens per session (+ median) · messages per session · biggest session (project + date).
- **Session size histogram**: <50k / 50–200k / 200–500k / 0.5–1M / >1M.
- **Session duration histogram**: <10 min / 10–30 / 30–60 / 1–2 h / >2 h. Duration = last − first timestamp of the main session (subagents excluded).
- **Sessions table**, paginated, filterable by day, project, model and machine: Start · Machine · Project · Model · Duration · Messages · **Subagents (count)** · Input · Output · Est. cost. Session totals **include their subagents**.
- Clicking a session opens a **session detail drawer**: main vs subagent tokens, then a timeline of its subagent invocations (type, start, duration, tokens, model).

### Agents (subagents)
- **KPI row**:
  - subagent share of total tokens
  - subagent invocations (+ per session)
  - average tokens per invocation (+ median)
  - average **startup cost** (first-request input)
  - average subagent duration
  - sessions that used subagents (%)
- **Main vs subagents per day**: stacked bars (main in `--accent`, subagents in `--accent-dark`).
- **By agent type** table: Type · Kind · Invocations · Total tokens + share bar · Avg tokens/invocation · Avg startup cost · Avg duration · Avg API calls · Output % · Main model · Est. cost.
- **Startup cost by agent type**: horizontal bars. It shows how much context each agent loads before doing anything; a large CLAUDE.md or many tools make it grow.
- **Biggest invocations**: top 10 table: Date · Project · Type · Model · Duration · Tokens · Startup cost.
- **Kinds**: a small breakdown of task / workflow / aside (`/btw`) / warm-up, with a short info tooltip explaining each one.
- **Models used by subagents** vs main sessions (two stacked bars).

### Machines
- **One card per machine**: icon, name, platform, tokens + %, active days, sessions, projects, est. cost, sync status ("Synced 2 min ago", warning after 7 days).
- **Per week** (last 12 weeks): grouped bars, one per machine.
- **Projects by machine**: one stacked bar per project.

### Settings
- **Data sources**: auto-detected folders + "Add folder", files scanned, lines skipped, subagent files found, database size, history retention hint (§2.5).
- **Sync** (§5b): on/off, Drive folder, this machine's name, known machines, "Sync now", project aliases.
- **Pricing**: table editor (per model, 4 prices), "Reset", `lastChecked`.
- **App**: launch at login, file watching on/off, CSV export (daily, per project, per model, per agent type), "Rebuild database" (re-scan everything, with confirmation), version, About + disclaimer.

### Empty & error states
- No logs found → a friendly empty state explaining where Claude Code stores logs, plus a button to pick a folder.
- No subagents yet → the Agents page explains what subagents are, with an empty state.
- Parsing warnings → a small badge in Settings ("12 lines skipped").

---

## 5b. Multi-machine sync via Google Drive

I use the app on **two machines** (a MacBook and a Windows desktop PC). Both run Claude Code. The dashboard shows the **combined** usage, with a filter per machine.

### Principle
- Sync goes through the **Google Drive for desktop** client installed on each machine. The app only reads and writes files in the local synced folder. **No Google API, no OAuth, no server.**
- Each machine is the **only writer** of its own files, so there are never write conflicts. It reads every other machine's files.
- Only **aggregated numbers** are synced: date, hour, project name (basename only), model, agent type, kind and token counts. **Never** prompt or response content, subagent descriptions, file paths or code.

### Folder detection
Auto-detect the Google Drive root, then use `<DriveRoot>/ClaudeTokenTracker/`:
- macOS: `~/Library/CloudStorage/GoogleDrive-*/<My Drive in any language>/`
- Windows: scan drive letters (default `G:\`) for the "My Drive" folder in any language. Also check `%USERPROFILE%\Google Drive\` (older clients).
- If nothing is found, or several accounts are found, ask the user to pick the folder (Settings → "Sync folder"). Store the choice.

### File layout
```
ClaudeTokenTracker/
├─ machines/
│  ├─ <machineId>/
│  │  ├─ machine.json      # { machineId, name, platform, appVersion, schemaVersion, lastSync }
│  │  ├─ 2026.json         # aggregates for that year
│  │  └─ 2027.json
│  └─ <otherMachineId>/…
└─ README.txt              # short explanation, written once
```

- `machineId` = a random UUID created on first launch and stored locally. `name` is editable in Settings (default: the hostname).
- `<year>.json` (compact, versioned):
```json
{
  "schemaVersion": 1,
  "machineId": "…",
  "hourly": [
    ["2026-11-10", 13, "demo-app", "Opus 5.5", "main", "", 1200, 540, 8800, 41000, 7],
    ["2026-11-10", 13, "demo-app", "Sonnet 5.5", "task", "Explore", 300, 120, 7000, 2000, 3]
  ],
  "sessions": [
    { "id": "…", "project": "demo-app", "model": "Opus 5.5", "start": "…", "end": "…", "messages": 27,
      "tokens": { "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0 },
      "subagentCount": 3, "subagentTokens": 0 }
  ],
  "subagents": [
    { "id": "<agentId>", "session": "…", "project": "demo-app", "type": "Explore", "kind": "task", "model": "Sonnet 5.5",
      "start": "…", "end": "…", "calls": 9, "startupInput": 7578,
      "tokens": { "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0 } }
  ]
}
```
`hourly` row = `[localDay, localHour, project, model, kind ("main" | "task" | "workflow" | "aside" | "warmup"), agentType ("" for main), input, output, cacheWrite, cacheRead, messageCount]`. Day and hour are in the **source machine's** local time.
- Expected size: about 3–5 MB per machine per year. Plain JSON is fine. Use `.json.gz` if a file goes over 5 MB.

### Write rules
- **Atomic write**: write `2026.json.tmp`, then rename it to `2026.json`.
- Write after each local re-scan that changes something (debounce 60 s), at most once every 5 min, plus on app quit.
- Only rewrite the years that changed. Update `machine.json.lastSync` on every write.

### Read and merge rules
- Watch `machines/*/` with chokidar in polling mode (**30 s interval**), because Drive folders on Windows sometimes miss native events.
- Ignore broken or partial JSON (Drive may still be downloading). Keep the last good version and retry later.
- Ignore Drive conflict copies (`2026 (1).json` etc.) and log them.
- Merge = add all machines' records together. They never overlap, because each machine exports only its own logs.
- **Projects with the same name on both machines are merged**, with a per-machine breakdown. Settings → "Project aliases" maps different names to one project.
- The local machine's data always comes from its own database. Only other machines' data comes from Drive (stored in a separate table, replaced on each read).

### Offline and errors
- Drive missing or not running → the app works with local data and shows "Sync pending".
- Per machine: name, platform icon, last sync time, warning after 7 days without sync.
- Settings → "Remove this machine" hides a machine. It never deletes its files on Drive without confirmation.

---

## 6. Data model & IPC API

```ts
type TokenBreakdown = { input: number; output: number; cacheWrite: number; cacheRead: number };
type AgentKind = 'main' | 'task' | 'workflow' | 'aside' | 'warmup';

interface Filters {
  from: string; to: string;          // local days 'YYYY-MM-DD'
  machineIds?: string[];             // default: all
  projects?: string[]; models?: string[]; agentTypes?: string[]; kinds?: AgentKind[];
}
```

The main process does the heavy aggregation in SQL and exposes typed endpoints:

```ts
window.api.getMachines(): Promise<Machine[]>;
window.api.getOverview(f: Filters): Promise<{ kpis; daily: DailyPoint[]; shortcuts }>;
window.api.getProjects(f: Filters): Promise<ProjectRow[]>;
window.api.getProjectDetail(project: string, f: Filters): Promise<ProjectDetail>;
window.api.getModels(f: Filters): Promise<{ cards: ModelCard[]; weekly: WeeklyShare[] }>;
window.api.getCalendar(machineIds?: string[]): Promise<{ heatmap; kpis; byWeekday; byHour; byMonth }>;
window.api.getSessions(f: Filters, page: number, sort: SortSpec): Promise<{ kpis; sizeHist; durationHist; rows: SessionRow[]; total: number }>;
window.api.getSessionDetail(sessionId: string): Promise<{ main: TokenBreakdown; subagents: SubagentRow[] }>;
window.api.getAgents(f: Filters): Promise<{ kpis; daily; byType: AgentTypeRow[]; startupByType; top: SubagentRow[]; kinds; modelsMainVsSub }>;
window.api.getMachinesDetail(f: Filters): Promise<{ cards; weekly; projectsByMachine }>;
window.api.getSettings() / setSettings(…) / exportCsv(kind) / rebuildDatabase();
window.api.onUsageUpdated(cb: () => void): () => void;
```

Define the exact types in `shared/types.ts`, used by both main and renderer. Every number the UI shows must come from these endpoints. Do not compute business logic in components.

---

## 7. Project structure

```
token-tracker-for-claude-code/
├─ electron/
│  ├─ main.ts            # window, IPC registration, lifecycle
│  ├─ preload.ts         # contextBridge api
│  ├─ db.ts              # SQLite schema, migrations, queries
│  ├─ scanner.ts         # recursive discovery, incremental reads, chokidar
│  ├─ parser.ts          # JSONL line parsing, dedup, model names
│  ├─ subagents.ts       # sidechain detection, meta.json, kinds, linking to parent
│  ├─ aggregate.ts       # SQL aggregations behind each endpoint
│  ├─ pricing.ts         # pricing.json, cost calc
│  ├─ paths.ts           # log folders + Google Drive folder (mac/win)
│  └─ sync.ts            # export own aggregates, read & merge other machines
├─ shared/types.ts
├─ src/
│  ├─ App.tsx, router
│  ├─ theme.css          # CSS variables from §4
│  ├─ i18n/en.ts         # every UI string
│  ├─ components/        # Sidebar, Header, MachineSelector, PeriodSelector, KpiCard, ShortcutCard,
│  │                     # StackedDailyBars, HBar, Donut, Heatmap, Histogram, DataTable, Drawer, EmptyState
│  ├─ pages/             # Overview, Projects, Models, Calendar, Sessions, Agents, Machines, Settings
│  └─ lib/format.ts      # 12.4M / 412k / $7.90 / Nov 10
├─ tests/                # vitest + synthetic fixtures (§2b)
├─ docs/SPEC.md, docs/mockup/
├─ package.json
└─ electron-builder.yml
```

---

## 8. Work plan (in this order; stop after each step so I can test)

1. **Scaffold**: Electron + Vite + React + TS, dark window with title bar, sidebar (all 8 items) and empty pages with the shared header. `npm run dev` must work. Look at `docs/mockup/` first. Create every repo file from §2b, ask me for my GitHub username and license name, make the first commit, and give me the exact `gh repo create … --public` + push commands.
2. **Parser, subagents, local database**: recursive scan, dedup, model names, time zone, subagent detection (§2.4), SQLite storage with incremental reads (§2.5). Vitest tests on synthetic fixtures: duplicates, broken lines, missing usage, two `cwd`s, Windows paths, new subagent layout + meta.json, workflow agents, `/btw` aside files, warm-up agents, legacy inline sidechains, the parent rollup that must **not** be counted, and a source file deleted after import (history kept). Print a summary in the console.
3. **IPC API + Overview**: typed endpoints (§6), KPI cards, stacked daily chart and shortcut cards with real data, plus the machine and period selectors (single machine for now).
4. **Projects page** (table + analysis panel).
5. **Models page**.
6. **Calendar page** (heatmap, streaks, weekday / hour / month charts; clicking a day opens Sessions).
7. **Sessions page** (KPIs, histograms, paginated table, session detail drawer).
8. **Agents page** (§5 Agents).
9. **Settings**, CSV export, pricing editor, file watching, "Rebuild database", empty states.
10. **Google Drive sync + Machines page** (§5b): folder detection, export, merge, machine selector with real machines, Machines page. Test with a fake second machine folder before using the real Windows PC.
11. **Packaging + release**: `.dmg` and `.exe` with electron-builder, `release.yml`, demo mode, README screenshots in demo mode. Test by pushing a `v0.1.0` tag, which should create a draft Release with both files. Explain how to open an unsigned app on macOS (right-click → Open) and Windows (SmartScreen → "More info" → "Run anyway"; labels may appear in the OS language).
12. **Windows testing**: clone on the Windows PC, `npm install`, `npm run dev`, check log detection (subagents included), the native SQLite module, the title bar, fonts and sync.

After each step: tell me which command to run, what I should see, and which effort to select next.

---

## 9. Quality bar

- Startup < 2 s with ~500 session files + their subagent files (incremental scan + SQLite).
- UI in English. Numbers formatted the English way (`12.4M`, `1,080k`, `$7.90`), dates in English (`Nov 10`). All UI strings live in `src/i18n/en.ts`.
- Visual result matches `docs/mockup/`.
- Keyboard accessible: real `<button>`s, focus rings in `--accent`, `aria-label` on icon buttons, contrast ≥ 4.5:1.
- Landscape first (§5 "Responsive layout"): check every page at 1100, 1440 and 1920 px wide. It must use the horizontal space well and never become a long vertical column on a wide window.
- Totals are consistent everywhere: Overview total = sum of projects = sum of models = main + subagents = sum of machines (add a test for it).
- `git ls-files` contains no real log data, no personal paths and no secrets (check before each step's commit).
- Tests pass on macOS and Windows in CI, with both path styles.
- No data leaves the machine except the aggregated sync files written to the local Google Drive folder. The app makes no network calls itself.
- Sync tests: merging 2 machines, broken or partial JSON, a conflict copy, the same project on both machines, a machine offline for more than 7 days, subagent rows from another machine.

## 10. Out of scope (for now)

- claude.ai web/desktop/mobile chat usage: there are no local per-message token counts for the chat app. Only Claude Code (CLI, IDE extensions, desktop Code tab) is covered.
- API organisation usage (Anthropic Admin API): possible future module behind an admin key; not now.
- Exact token counts of the user's own typed text (would need Anthropic's token-counting API): not needed, input/output from the logs is enough.
