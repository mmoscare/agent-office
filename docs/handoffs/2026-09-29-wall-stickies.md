# Reminder stickies on the wall

## Request

Attach sticky-note reminders on the wall, near the kanban / To Do wall, on every floor. Four notes should already be up:

1. POST 4-5 TIMES A DAY (remember camillla arajuo)
2. DAILY RECAP VID (see paper cluluoud)
3. Make the viral short
4. Show futures traders desk. Sierra chart.

The third sentence in the request named two jobs ("make the viral short" and "show futures traders desk. sierra chart") and asked for four notes, so those are notes 3 and 4. Unusual name spellings were kept as written. Notes must be editable, addable, resizable, recolorable, and hidable without deleting them.

## Outcome

Four reminder stickies hang in a row on the north wall, just above the issues / To Do board, on every floor (the office scene is shared; the roof hides it because there is no wall there). Point at a note and press E to edit it. A + to the right of the row adds a note and lists any that are hidden. Each person's list follows them onto every floor, the same way the To Do board does.

## Changes and why

- `src/shared/stickies.ts`: note model, colors, the strip above the To Do board, presets, validation, and apply (edit, color, resize, move, hide, remove). Sizes and positions are clamped so a note stays in that strip.
- `src/server/stickies.ts`: one list per account (or the shared password), saved in `.agent-office/stickies.json`. A person with no saved list gets the four presets. An emptied list stays empty.
- `src/shared/protocol.ts`, `src/server/server.ts`: `sticky` client message and `stickies` server message, sent on welcome and after each change, to every window of that person.
- `src/client/state.ts`: `stickies` topic, optimistic pending count, same as todos.
- `src/client/world/stickies.ts`: canvas notes and the + , parented to the office group so every floor shows them.
- `src/client/ui/stickies.ts`, `src/client/ui/stickies.css`: editor (text, color, width, height, nudge, hide, take down) and the add / show-hidden window.
- `src/client/world/office.ts`: `sticky` and `stickyAdd` interact kinds.
- `src/client/main.ts`: mount, E, hint, reach, and third-person pointing.
- `src/client/ui/hud.ts`, `README.md`: how to use them.

## Decisions

- Personal lists, not one shared office list, matching the To Do board. The shared password still shares one list.
- Notes stay in the strip above the To Do board so they stay near the kanban and do not cover cards, the board name, or the issues switch. Nudge moves them inside that strip.
- Hide keeps the note. Show it again from the +.
- Pointing is required (radius 0) so standing at the board still opens the kanban.

## Checks actually run

- `npm install --ignore-scripts --include=optional --no-audit --no-fund` in this worktree (no `node_modules` here; lockfile matches the personal checkout and was not changed).
- `node --import tsx --test tests/stickies.test.ts`: 8 passed, 0 failed.
- `npm run typecheck`: passed (client and server).
- Full `npm test` not run.
- No browser / 3D check. The running office was not restarted.

## Commits, branch, PR

- Branch `office/sprocket-c2fd`.
- No related GitHub issue was found for this request.
- PR targets `personal` (see the PR for this commit).

## Remaining

- Merge, rebuild the personal app, and restart the office when workers can stop. A browser refresh is not enough for the new server message and `stickies.json` seeding.
- First sign-in after that seeds the four notes. Editing them later is remembered.
- Optional later: drag notes anywhere on the wall, not only the strip above the board.
