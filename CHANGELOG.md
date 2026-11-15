# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **Live** page (second item of the sidebar; Ctrl/Cmd+2, Settings is now 9): the 5-hour usage window rebuilt from the times of Claude Code's responses, with its tokens and start time, the reset time and a countdown, the speed over the last 15 minutes, an estimated usage and the time the limit would be reached at this speed ("Limit reached at ~14:05", or "Resets first"). The estimates are in API prices and are labeled as such: usage on other computers or on claude.ai is not in these logs. Below, a chart of tokens per minute by project over the last 1, 3 or 6 hours (marks: window start and now), the projects active right now with their models, and one line per machine. It refreshes when the logs change and every minute; a notice says so when file watching is off. Live data from other computers is not shared yet.
- Live page, what counts as 100%: Claude's own 5-hour % while it is current, else your choice between your largest finished window and a **calibration**. To calibrate, run `/usage` in Claude Code and enter its "Current session" % on the Live page: the limit becomes the window's usage so far divided by that %, and it carries over to later windows. While Claude's own % is current, the Live page also uses Claude's reset time.
- Settings → Application → **Claude's usage %** (on by default): reads the 5-hour % and reset time that Claude Code saves in `~/.claude.json` when it shows your usage (`/usage`). Only those numbers are kept; nothing else from that file is used, stored, logged or synced, and the file is never written. Turn it off to stop reading it.
- French. Settings → Application → Language: System default, English or Français. The default is the system language when the app has it, else English. The switch applies at once, without a restart, to every page, the numbers and dates (`12,4 M`, `7,90 $`, `10 nov.`), the window menu and the dialogs. CSV exports keep English headers and plain numbers.
- Default prices for Opus 4.5 and Sonnet 4.5, which can still appear in Claude Code transcripts.
- A tooltip on the Overview's estimated cost, and a line in the README, saying what the estimate leaves out: fast mode, US-only inference, web searches and Haiku long-prompt pricing.
- Settings → Sync: delete an old machine permanently. Its data leaves this computer's database. After a second confirmation, its folder is also deleted from Google Drive, and your other computers delete it too. This computer can't be deleted. A deleted machine that syncs again later comes back, as the confirmation says.
- Settings → Sync lists each machine's last sync date and time (for example `last sync Nov 3, 2026, 14:05 · 11 days ago`).

### Changed

- The `README.txt` in the Google Drive sync folder is rewritten when the app's text for it changes (it now carries a version line), so folders created by an older version get the current explanation. A README written by a newer version on another computer is left alone.
- The default prices were checked against Anthropic's price list on 2026-11-13 (unchanged).
- Settings → Sync: "Remove" is now **Hide** (this computer only, can be undone). Its "Remove and delete its files from Drive" choice is gone: use Delete. A folder deleted that way left the machine on the other computers, flagged "not in the sync folder any more".

## [0.1.1] - 2026-11-13

First published release: everything listed under 0.1.0 in the [changelog](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/blob/main/CHANGELOG.md), plus these fixes. The builds are not code-signed yet: see the README for how to open them the first time on macOS and Windows.

### Fixed

- Windows portable `.exe`: "Launch at login" registered the temporary copy the portable app runs from, which is deleted when it quits, so nothing started at the next sign-in (and the installed app's entry was replaced). It now registers the portable `.exe` itself.
- Sync: when the app starts before Google Drive has mounted its folder (launched at login), this computer's numbers are now written as soon as the folder appears, instead of at the next change or the hourly heartbeat.

## [0.1.0] - 2026-11-13

Built and tested, but never published (replaced by 0.1.1). The builds are not code-signed yet: see the README for how to open them the first time on macOS and Windows.

### Added

- Installers: a `.dmg` for macOS on Apple silicon and on Intel, and a setup `.exe` plus a portable `.exe` for Windows (x64).
- Demo mode (`--demo`, `TOKEN_TRACKER_DEMO=1` or `npm run dev:demo`): a year of generated sample data on two fake computers, without touching your own history, logs, settings or Google Drive.
- Project scaffold: Electron, Vite, React and TypeScript.
- Dark application window with a custom title bar on macOS and Windows.
- Sidebar navigation with the eight sections and keyboard shortcuts.
- Shared page header with machine and period selectors.
- Detection of the Claude Code log folders.
- Reading of Claude Code transcripts: recursive scan, deduplication of streamed and resumed responses, model names, project names.
- Subagent detection: task, workflow and `/btw` transcripts, warm-up agents, agent types from meta files, and the legacy inline format.
- Permanent local history in SQLite, with incremental reads and hourly, per-session and per-subagent aggregates in the local time zone.
- Overview page: total, input and output tokens, estimated cost, tokens per day, and shortcut cards to every section, filtered by machine and period.
- Cost estimate at API prices from an editable `pricing.json`, with 1-hour cache writes priced separately.
- Active time for sessions and subagent runs: pauses longer than 30 minutes are left out.
- Container folders: a folder flagged as holding several projects is split by the directory directly under it, shown as `VS Code › Astrophotography_TM`. On the Projects page its subfolders are grouped under an expandable row for the whole folder; one folder is open at a time, except while a search shows the matching subfolders of several.
- The period comparison shows "New activity" when the period before had less than 5% of the usage.
- Projects, Models, Calendar, Sessions and Agents pages.
- Settings page: data sources with an "Add folder" picker, scan statistics and a "lines skipped" badge, the container folder switches, the price editor, launch at login, "Rebuild database" and About.
- File watching: the dashboard refreshes a few seconds after Claude Code writes a transcript. It can be turned off in Settings.
- CSV export of the daily, project, model and agent type tables for the selected period and machines.
- "Keep Claude Code history longer": raises `cleanupPeriodDays` in Claude Code's settings file to 90, 180 or 365 days, only after a confirmation.
- Sync between computers through Google Drive for desktop, off by default. Each computer writes its aggregated numbers (never prompts, responses, code, descriptions or paths) to `My Drive/ClaudeTokenTracker` and reads the others'. The Drive folder is found for any account and in any language, with a folder picker when there are several accounts or none. Broken or half-downloaded files keep the last good copy, Drive conflict copies are ignored, and other computers' numbers are as exact as this one's on every page.
- Machines page: one card per computer with its sync status (a warning after 7 days without sync), tokens per week by computer, and the largest projects split by computer. The machine selector lists every synced computer, and the title bar shows the sync status.
- Settings → Sync: on/off with what is written to Drive, the folder, this computer's name, the known computers (remove or show again), "Sync now".
- Project aliases: map an old project name to the new one, for example after renaming a folder, so both count as one project on every computer. Subfolders of a renamed container folder follow, and its container flag is kept.
- "No logs found" state with a folder picker.
- Repository files: license, contribution guide, security policy, issue and pull request templates, CI workflow.

[Unreleased]: https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/releases/tag/v0.1.1
