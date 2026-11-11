# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Container folders: a folder flagged as holding several projects is split by the directory directly under it.
- The period comparison shows "New activity" when the period before had less than 5% of the usage.
- Repository files: license, contribution guide, security policy, issue and pull request templates, CI workflow.
