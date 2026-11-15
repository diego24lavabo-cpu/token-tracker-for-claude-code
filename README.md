# Token Tracker for Claude Code

A desktop app for macOS and Windows that reads your local Claude Code session logs and shows a dark dashboard of your token usage: per day, project, model, session, subagent and machine.

Everything runs locally. No account, no API key, no telemetry, no network calls.

![Overview: total, input and output tokens, estimated cost, tokens per day and shortcuts to every section](docs/screenshots/overview.png)

<sub>All screenshots are taken in demo mode, with generated sample data from two fake computers.</sub>

> Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Features

- **Overview** with the essentials: total, input and output tokens, estimated cost, tokens per day.
- **Live**: where you stand in Claude's 5-hour usage window right now, with the reset time, your speed, an estimated % and when the limit would be reached at this speed.
- **Projects**: usage per project, with a detailed analysis panel.
- **Models**: share, cache hit rate and estimated cost per model.
- **Calendar**: 12-month heatmap, streaks, usage by weekday, hour and month.
- **Sessions**: size and duration histograms, a sortable table and a detail drawer.
- **Agents**: what subagents cost you, by agent type, including their startup cost.
- **Machines**: combined usage of several computers, synced through your own Google Drive folder.
- **Permanent history**: the app keeps its own local database, so your history survives Claude Code's transcript cleanup.
- **CSV export** and an editable price table for the cost estimate.
- **English or French**, switched in Settings without a restart (by default, the system language).

![Live page: the 5-hour window of two computers together, tokens per minute by project, and the estimate reference](docs/screenshots/live.png)

| Projects                                                                     | Calendar                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Projects table with the analysis panel](docs/screenshots/projects.png)     | ![12-month heatmap, streaks, weekday, hour and month charts](docs/screenshots/calendar.png) |
| **Agents**                                                                   | **Machines**                                                                                |
| ![Subagent share, kinds and cost by agent type](docs/screenshots/agents.png) | ![Two computers synced through Google Drive](docs/screenshots/machines.png)                 |
| **Models**                                                                   |                                                                                             |
| ![Model cards, weekly share and token types](docs/screenshots/models.png)    |                                                                                             |

## Install

Download the latest version from the [Releases](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/releases) page:

| System               | File                                           |
| -------------------- | ---------------------------------------------- |
| macOS, Apple silicon | `Token-Tracker-<version>-mac-arm64.dmg`        |
| macOS, Intel         | `Token-Tracker-<version>-mac-x64.dmg`          |
| Windows, installer   | `Token-Tracker-<version>-win-x64-setup.exe`    |
| Windows, no install  | `Token-Tracker-<version>-win-x64-portable.exe` |

On macOS, open the `.dmg` and drag the app into **Applications**. On Windows, run the setup, or start the portable `.exe` from any folder.

The builds are **not code-signed** yet (that needs a paid Apple Developer ID and a Windows code-signing certificate), so your system warns you the first time you open the app:

- **macOS 15 (Sequoia) and later**: open the app once; macOS says it could not verify it, click **Done**. Then open **System Settings → Privacy & Security**, scroll down to the message about Token Tracker for Claude Code and click **Open Anyway**, then **Open Anyway** again and confirm with your password or Touch ID. You only do this once.
- **macOS 14 (Sonoma) and earlier**: right-click (or Control-click) the app in Applications, choose **Open**, then confirm with **Open**.
- **Windows**: on the blue "Windows protected your PC" (SmartScreen) dialog, click **More info**, then **Run anyway**. The labels can appear in your system language.

To check a download, compare it with `SHA256SUMS.txt` on the release page (`shasum -a 256 <file>` on macOS, `Get-FileHash <file>` in PowerShell).

## Where the data comes from

Claude Code writes JSONL transcripts on your computer. The app scans every one of these folders that exists:

| Location                          | Notes                                |
| --------------------------------- | ------------------------------------ |
| `~/.claude/projects/`             | default on macOS and Linux           |
| `~/.config/claude/projects/`      | newer installs                       |
| `$CLAUDE_CONFIG_DIR/projects/`    | when the environment variable is set |
| `%USERPROFILE%\.claude\projects\` | Windows                              |

Only the usage numbers of each response are read (token counts, model, timestamps, project folder name). Only Claude Code is covered (CLI, IDE extensions, desktop Code tab); the claude.ai chat apps do not store per-message token counts locally.

## How usage is counted

- **Each response counts once.** Claude Code writes a streamed response as several lines and copies earlier lines when a session is resumed. Responses are deduplicated across all files by message id and request id.
- **Four token types stay separate**: input, output, cache write and cache read. Total input is the sum of input, cache write and cache read, which is everything sent to Claude.
- **Subagents are counted from their own transcripts** (`subagents/agent-*.jsonl`, workflow agents, `/btw` side questions, and the older inline format). The summary a parent session stores after a subagent run is ignored, so nothing is counted twice.
- **A project is the folder where the session was started.** If the shell moves into a subfolder during a session, the usage stays with the project.
- **Days and hours follow your system time zone.** Timestamps are stored in UTC.
- **Durations are active time.** The time between consecutive responses is added up, leaving out any pause longer than 30 minutes, so a session resumed the next day does not count as a day of work.
- **Cost is an estimate at standard API prices.** Each model's tokens are multiplied by the prices in an editable `pricing.json` in the app's data folder; writes to the 1-hour cache are priced at their own, higher rate. Not included: fast mode, US-only inference, web searches and Haiku long-prompt pricing. On a subscription this is only what the same usage would cost if billed per token. A model without a price shows no cost.
- **History is permanent.** Claude Code deletes old transcripts (after 30 days by default). The app copies the usage numbers into its own database and never removes them when a source file disappears.

## The Live page

Claude's usage limit resets 5 hours after the window starts. The Live page rebuilds that window from the times of your Claude Code responses: a window starts with the first response after the previous one ended and lasts 5 hours.

- **Top row**: the window's tokens since it started, the reset time with a countdown, your speed over the last 15 minutes, the estimated usage and the time you would reach the limit at this speed ("Limit reached at ~14:05", or "Resets first").
- **Chart**: tokens per minute by project over the last 1, 3 or 6 hours, with marks for the window start and now. Next to it, the projects in use right now and, with several computers, each one's window.
- It refreshes a few seconds after Claude Code writes a transcript (unless file watching is off in Settings) and every minute.

Anthropic does not publish the limits, so the % is an **estimate**, in API-price units (each response weighs what it would cost at API prices, so cheap cache reads count less). What counts as 100%:

1. **Claude's own %**, while it is current. Claude Code saves the 5-hour % and reset time in `~/.claude.json` when it shows your usage (`/usage`, or the usage panel in the IDE). The app reads only those numbers, never writes the file, and you can turn this off in Settings → Application → Claude's usage %. The page then adds the usage since that moment.
2. Otherwise your choice on the Live page: your **largest finished window**, or a **calibration**. To calibrate, run `/usage` in Claude Code and enter its "Current session" % on the Live page; the limit becomes the window's usage so far divided by that %, and it carries over to later windows.

With several computers and sync on, the limit is per account, so under **All** the top of the page is every computer together: one window that starts with the first response on any of them. Another computer's usage stays in that window until the window resets, even after its app is closed: when its live data is more than 15 minutes old the page says since when ("MacBook (last data at 10:00)"). Usage on claude.ai, or on a computer that does not share live data, is not in these logs and is not counted.

## How sync works

Sync is **off by default**. When you turn it on in Settings, the app writes small JSON files into a `ClaudeTokenTracker` folder inside your local **Google Drive for desktop** folder ("My Drive", in any language), and reads the files written by your other machines. There is no Google API, no OAuth and no server: the Drive client on your computer does the transfer. With several Google accounts, or none found, you choose the folder.

Each machine writes only its own folder, `ClaudeTokenTracker/machines/<random id>/`: `machine.json` (name, platform, last sync), one file per year (`2026.json`, a few MB at most) and `live.json` for the Live page. What is written:

- aggregated token counts per day and hour, project name (folder name only), model, agent type and kind
- one summary per session and per subagent run: random ids, start and end times, active time, token counts per model, the projects it worked in and the days it was active
- in `live.json`, the last 6 hours minute by minute (response times, project, model, token counts), when the machine was in use over the last 24 hours, and its current and previous 5-hour windows
- your machine's name and platform

`live.json` is rewritten at most once a minute while you use Claude Code, and every 5 minutes while the app runs, so the other computers can tell an idle machine from one whose app is closed. Claude's 5-hour limit is per account, so the Live page adds up every computer's live data in the running window. Live data more than 15 minutes old still counts until its window resets, and the page shows when it was written. A computer needs version 0.1.2 or later to share live data.

What is **never** written: prompts, responses, code, file paths, subagent task descriptions.

Projects with the same name on several machines are merged, with a split per machine. After renaming a project folder, map the old name to the new one in Settings → Project aliases.

To get rid of an old computer, use Settings → Sync → Machines, which shows each machine's last sync date. **Hide** leaves it out on this computer only and can be undone. **Delete** removes its data from this computer's database; a second confirmation also deletes its Drive folder, and the other computers then delete it too (the deleting computer lists it in its own `deleted.json`). This computer can't be deleted. A deleted machine that syncs again later comes back.

## Privacy

- The app makes no network calls.
- Your usage database stays in the app's user data folder on your computer.
- For the Live page, the app reads the 5-hour % and reset time that Claude Code saves in `~/.claude.json`, and nothing else from that file (turn it off in Settings → Application). It never writes the file, and these numbers are not synced.
- The only data that leaves the machine is the aggregated sync files described above, and only if you enable sync.
- Cost figures are an estimate "at API prices" from an editable price table. For subscription users it is only an equivalent.

## Build from source

Requirements: [Node.js](https://nodejs.org) 22.12 or newer and git. No C++ toolchain is needed: the SQLite module ships prebuilt binaries.

```sh
git clone https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code.git
cd token-tracker-for-claude-code
npm install
npm run dev
```

| Command             | What it does                                                                   |
| ------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`       | start the app with hot reload                                                  |
| `npm run dev:demo`  | start the app in demo mode (sample data)                                       |
| `npm run build`     | typecheck and build the app into `dist/` and `dist-electron/`                  |
| `npm test`          | run the unit tests                                                             |
| `npm run lint`      | run ESLint and the Prettier check                                              |
| `npm run typecheck` | run the TypeScript compiler without emitting                                   |
| `npm run dist:mac`  | build the two `.dmg` files into `release/` (on a Mac)                          |
| `npm run dist:win`  | build the setup and portable `.exe` into `release/` (on Windows)               |
| `npm run icons`     | render `build/icon.png` and `build/icon.icns` from `build/icon.svg` (on a Mac) |

Releases are built by GitHub Actions: pushing a `v*` tag (for example `v0.1.0`) runs [release.yml](.github/workflows/release.yml), which builds both platforms and creates a **draft** release with the notes of that version from [CHANGELOG.md](CHANGELOG.md).

### Demo mode

Demo mode shows generated sample data instead of your own: a year of fake sessions and subagents on "this computer", plus a second fake computer synced through a temporary folder. It never reads or writes your history, your Claude Code logs or settings, or Google Drive, and nothing can be changed in Settings. The sample data lives in a temporary folder that is emptied when the app quits.

- From source: `npm run dev:demo`.
- Installed app: start it with `--demo` (or the environment variable `TOKEN_TRACKER_DEMO=1`):
  - macOS: `open -n -a "Token Tracker for Claude Code" --args --demo`
  - Windows: `& "$env:LOCALAPPDATA\Programs\Token Tracker for Claude Code\Token Tracker for Claude Code.exe" --demo`

A demo window can stay open next to the normal one. `node scripts/gen-demo-data.mjs <folder>` writes the same kind of sample logs into a folder of your choice.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and the rules for contributions.

## License

[MIT](LICENSE)

## Disclaimer

Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic. The Claude Code log format is not officially documented and can change between versions; if numbers look wrong after an update, please [open an issue](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/issues).
