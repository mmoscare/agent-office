# Floor terminal typing and current-folder shells

## Request

Open a fresh terminal inside the current floor folder. Existing terminal views did not accept typing. Goal: on any floor, open a shell and use it as a normal terminal in that folder.

## Outcome

Typing reaches worker terminals and the standalone PowerShell console. Ctrl+` / ☰ Terminal still opens that console. Reopening on the same floor keeps the shell; switching floors or **New shell here** starts a new one in the current floor folder.

## Changes and why

- `src/client/style.css`: `.modal textarea` was restyling xterm's hidden textarea (width, padding, border). Combined with `.modal { overflow: hidden }` and xterm's `left: -9999em` input, Chromium drops keystrokes. Form styles now skip `.xterm-helper-textarea`, and that input is pinned inside the terminal.
- `src/client/ui/console.ts`: click focuses the shell; replies to terminal queries are sent even before the snapshot (PowerShell cursor-position reports). Focus is delayed 50ms like worker terminals.
- `src/client/ui/terminal.ts`: click in the worker terminal (not on a control) focuses the active tab.
- `src/server/console-shell.ts`: attaching with a different floor directory ends the old shell and starts in the new folder.

## Decisions

- Same-floor reopen still keeps `cd` and session state. Floor change is treated as a new shell. **New shell here** remains for an explicit reset.
- No separate terminal stack: this is the existing standalone console plus input fixes for every `.modal.term`.

## Checks actually run

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run typecheck`: passed
- `npm run build`: passed
- `node --import tsx --test --test-isolation=none --test-force-exit --test-reporter=tap tests/console-shell.test.ts tests/terminal-clipboard.test.ts`: 9 passed, 0 failed
- `node tests/console-ui.mjs`: PASS (headless Edge; click the screen to type; isolated office)
- `node tests/local-floor-ui.mjs`: PASS (Esc reaches a worker terminal after clicking the screen)
- Full `npm test` not run
- Live personalized office was not restarted (active workers)

## Remaining

Rebuild and restart the running Agent Office from the tray when workers can stop. Browser refresh alone is not enough for the server-side floor-change behavior. No further implementation work.
