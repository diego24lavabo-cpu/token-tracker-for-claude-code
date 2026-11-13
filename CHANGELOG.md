# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Windows portable `.exe`: "Launch at login" registered the temporary copy the portable app runs from, which is deleted when it quits, so nothing started at the next sign-in (and the installed app's entry was replaced). It now registers the portable `.exe` itself.
- Sync: when the app starts before Google Drive has mounted its folder (launched at login), this computer's numbers are now written as soon as the folder appears, instead of at the next change or the hourly heartbeat.

## [0.1.0] - 2026-11-13

First release. The builds are not code-signed yet: see the README for how to open them the first time on macOS and Windows.

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

[Unreleased]: https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/releases/tag/v0.1.0
