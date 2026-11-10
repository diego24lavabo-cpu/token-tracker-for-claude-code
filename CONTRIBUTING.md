# Contributing

Thanks for your interest in Token Tracker for Claude Code. Bug reports, ideas and pull requests are welcome.

## Getting started

```sh
npm install
npm run dev        # start the app with hot reload
npm run dev:demo   # start it with generated sample data
```

Before you open a pull request, run the same checks as CI:

```sh
npm run lint
npm run typecheck
npm test
```

CI runs them on macOS and Windows, so keep both path styles in mind (`/Users/alex/dev/demo-app` and `C:\Users\alex\dev\demo-app`).

## Project layout

| Path           | Contents                                                     |
| -------------- | ------------------------------------------------------------ |
| `electron/`    | main process: window, IPC, log scanning, database, sync      |
| `shared/`      | types and constants used by both the main process and the UI |
| `src/`         | React UI: pages, components, theme, strings                  |
| `tests/`       | vitest tests and synthetic fixtures                          |
| `docs/SPEC.md` | the full build specification                                 |

## Rules that matter here

**Privacy first.** This repository is public and the app handles personal usage data.

- Never commit real Claude Code logs, databases, CSV exports or anything copied from `~/.claude`.
- Test fixtures are 100% synthetic: invented project names, fake paths, fake ids, and no real prompt or response text.
- Screenshots are taken in demo mode only.
- No secrets, tokens or personal email addresses in code, config or commit history.
- No hardcoded usernames, paths, machine names, project names or time zones.

**No network.** The app makes no network calls. Please do not add dependencies or features that phone home, load remote fonts or scripts, or collect telemetry.

**Design.** Colors, fonts and spacing come from the CSS variables in `src/theme.css`. Every UI string lives in `src/i18n/en.ts`. Numbers shown in the UI come from the main process through the typed IPC API; components do not compute business logic.

**Parsing.** The Claude Code log format is undocumented and changes between versions. Parsing code must skip what it does not understand and never crash. When you fix a parsing bug, add a synthetic fixture that reproduces it.

## Commits and pull requests

- Keep pull requests focused on one change.
- Write commit messages in English, in the imperative mood ("Add session drawer").
- Add an entry under "Unreleased" in `CHANGELOG.md` for user-visible changes.
- New behavior needs a test where a test is practical.

## Reporting bugs

Use the bug report template. Include your OS, the app version and your Claude Code version. If the bug is about wrong numbers, describe the shape of the log lines involved **without** pasting their content: field names and structure are enough.

Security issues: see [SECURITY.md](SECURITY.md).
