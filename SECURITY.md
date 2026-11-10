# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/diego24lavabo-cpu/token-tracker-for-claude-code/security/advisories/new)).

Include what you found, how to reproduce it and the app version and operating system. You can expect a first answer within a week.

## Scope

Token Tracker for Claude Code is a local desktop app. It reads Claude Code session logs from your disk, stores aggregated usage in a local database and, if you enable sync, writes aggregated numbers to a folder you choose. It makes no network calls.

Things that are especially relevant:

- any way for log content (prompts, responses, code, file paths) to end up in the sync files, CSV exports or anywhere outside the local database
- any network request made by the app
- code execution or file writes triggered by a crafted log file or sync file
- weaknesses in the renderer isolation (context isolation, content security policy, IPC surface)
