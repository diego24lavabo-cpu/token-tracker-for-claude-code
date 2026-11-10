# Token Tracker for Claude Code

A desktop app for macOS and Windows that reads your local Claude Code session logs and shows a dark dashboard of your token usage: per day, project, model, session, subagent and machine.

Everything runs locally. No account, no API key, no telemetry, no network calls.

> **Status: early development.** The app is being built step by step (see [docs/SPEC.md](docs/SPEC.md)). The window, the navigation and the log reader with its local database exist; the data pages are next. Screenshots will be added with the first release, and they will always be taken in demo mode with generated sample data.

> Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Features

Planned for `0.1.0`:

- **Overview** with the essentials: total, input and output tokens, estimated cost, tokens per day.
- **Projects**: usage per project, with a detailed analysis panel.
- **Models**: share, cache hit rate and estimated cost per model.
- **Calendar**: 12-month heatmap, streaks, usage by weekday, hour and month.
- **Sessions**: size and duration histograms, a sortable table and a detail drawer.
- **Agents**: what subagents cost you, by agent type, including their startup cost.
- **Machines**: combined usage of several computers, synced through your own Google Drive folder.
- **Permanent history**: the app keeps its own local database, so your history survives Claude Code's transcript cleanup.
- **CSV export** and an editable price table for the cost estimate.

## Install

Installers will be published on the [Releases](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/releases) page: a `.dmg` for macOS (Apple Silicon and Intel) and an `.exe` installer plus a portable `.exe` for Windows.

The builds are **not code-signed** yet, so your system will warn you the first time:

- **macOS**: right-click (or Control-click) the app, choose **Open**, then confirm with **Open**. On recent macOS versions you may need **System Settings → Privacy & Security → Open Anyway** instead.
- **Windows**: on the SmartScreen dialog, click **More info**, then **Run anyway**. The labels can appear in your system language.

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
- **History is permanent.** Claude Code deletes old transcripts (after 30 days by default). The app copies the usage numbers into its own database and never removes them when a source file disappears.

## How sync works

Sync is **off by default**. When you turn it on in Settings, the app writes small JSON files into a `ClaudeTokenTracker` folder inside your local **Google Drive for desktop** folder, and reads the files written by your other machines. There is no Google API, no OAuth and no server: the Drive client on your computer does the transfer.

What is written to Drive:

- aggregated token counts per day and hour, project name (folder name only), model, agent type
- one summary line per session and per subagent run (ids, timestamps, token counts)
- your machine's name and platform

What is **never** written: prompts, responses, code, file paths, subagent task descriptions.

## Privacy

- The app makes no network calls.
- Your usage database stays in the app's user data folder on your computer.
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

| Command             | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `npm run dev`       | start the app with hot reload                                 |
| `npm run dev:demo`  | start the app in demo mode (sample data)                      |
| `npm run build`     | typecheck and build the app into `dist/` and `dist-electron/` |
| `npm test`          | run the unit tests                                            |
| `npm run lint`      | run ESLint and the Prettier check                             |
| `npm run typecheck` | run the TypeScript compiler without emitting                  |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and the rules for contributions.

## License

[MIT](LICENSE)

## Disclaimer

Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic. The Claude Code log format is not officially documented and can change between versions; if numbers look wrong after an update, please [open an issue](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/issues).
