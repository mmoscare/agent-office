# Codex input alerts and terminal branch display

## Outcome

Codex workers distinguish visible questions and approval controls from progress messages or automatically handled permission events. Terminal windows show their checkout's current Git branch, refresh while open, and handle older running servers without an endless loading message.

## Changes and decisions

- The Codex-only detector in src/server/codex-input.ts checks active terminal controls. Worker status clears when the prompt disappears; other providers keep their existing behavior.
- src/server/worker-branches.ts reads each checkout's current HEAD rather than its saved creation branch. Reads are bounded and run asynchronously on terminal attach and every five seconds while someone is viewing it.
- The terminal branch row supports normal checkouts, worker worktrees, workspace repository metadata, unborn branches, detached commits, and missing Git data. The shared workspace types support displaying metadata; workspace creation changes are a separate task.
- A newly built browser can connect to an older server process. Missing reports show explicitly labelled last-known branch metadata when available, and a restart notice after eight seconds.
- Unrelated workspace and Changes-window edits in the personal checkout are excluded from this commit and remain local.

## Verification

- Type checks and the production build passed.
- The focused Codex hooks, Windows hooks, usage, input-status, and Git branch tests passed (19 tests on the isolated staged snapshot).
- tests/terminal-branches-ui.mjs verified branch switches, separate worktree branches, detached HEAD, and missing older-server reports in an isolated office with idle Node workers. No authenticated model requests were made.
- git diff --cached --check passed.

## Actions and references

Repository: mmoscare/agent-office. Destination: personal on origin. This record belongs to the commit containing the alert and branch features. The user requested committing and pushing these changes; no PR, issue comment, or live-server restart was requested as part of that upload.

## Remaining work

Restart the running Agent Office server from its tray menu after active workers finish to enable live reporting and the Codex status fix. Browser refresh alone only updates the interface. Other local customization work remains uncommitted. Terminal-control detection depends on Codex's current TUI wording; update its focused tests if that wording changes.
