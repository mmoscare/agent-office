# Handoff: Autonomous Tasks whiteboard + kanban card details (IN PROGRESS)

Branch: `office/widget-8706` (worktree). Not committed, not pushed, no PR yet. Nothing has been typechecked, built or tested.

## Request
1. Add another whiteboard called "Autonomous Tasks". It should look exactly like the To Do kanban and hold every task from the owner's Notion page "Autonomous Tasks" (data source `collection://204dbaf9-875f-83e0-b23f-87b58c018e65`, 86 rows).
2. Every kanban (the To Do on the issues wall and the new board) gets notes, images and subtasks on each card. They stay hidden until you double-click the cork background, and a second double-click hides them again.

## Done so far (uncommitted)
- `src/shared/todos.ts`: `TodoBoardId` ('mine' | 'autonomous'), `TodoDetails` (notes, subtasks, images) and the `details` action. `add` also carries details, so Undo restores them. Validation and limits are in place.
- `src/server/todos.ts`: the constructor takes a file name.
- `src/server/todo-images.ts` (new): stores pictures in `.agent-office/todo-images/<sha>.<ext>`.
- `src/server/server.ts`:
  - A second `Todos` store in `autonomous.json`, owner `'office'`, shared by the whole office.
  - The `todos` message (board `autonomous`) is sent on arrival.
  - The `todo` handler branches on `msg.board`.
  - New route `GET/POST /api/todo-image`.
- `src/shared/protocol.ts`: an optional `board` on the `todo` and `todos` messages.
- `src/client/state.ts`: `autonomous`, `autonomousPending` and the 'autonomous' topic.
- `src/client/ui/todos.ts`:
  - `mountTodoBoard(net, board)` is parameterised by board.
  - Double-click on the board background toggles details.
  - Focus and caret are kept across redraws.
  - New `openAutonomousBoard(net)` and `activeAutonomous()`.
- `src/client/ui/todo-details.ts` (new):
  - Per-card panel with subtasks, notes (debounced saves) and pictures (upload, paste or drop; shrunk to 1600px).
  - Holds the shown/hidden state for each board.
- `src/client/ui/todos.css`: the details styles. The todo body padding moved inside `.todo-board`, so double-clicking the cork reaches the board.

## Still to do
1. **The whiteboard stand in the 3D office.** Plan:
   - A new rolling stand module, `src/client/world/kanban-stand.ts`, modelled on `world/whiteboard.ts`, so the upstream file stays untouched.
   - Face 4 m × 2 m, bottom 0.6 m, at about x 5.4, z 5.4, facing +z. Add an `AUTONOMOUS_BOARD` const in `shared/layout.ts`.
   - Add a collider, and a nav rect in `shared/nav.ts`.
   - New InteractKind `'autonomous'` in `world/office.ts`, plus REACH and hint entries in `main.ts`.
   - Pressing E calls `openAutonomousBoard(net)`.
   - Texture: generalise `TodoWallTexture` in `world/todo-wall.ts` to take a title ("🏢 Autonomous Tasks") and to draw ☑/📝/🖼 badges while details are shown (`todoDetailsShown`).
   - Optionally add a top-bar menu entry next to the 🔥 one (around `main.ts` line 2948).
2. **Import the Notion tasks into the running office's data**, not into the repo, because the repo is PUBLIC.
   - Target: `C:\Users\Owner\Documents\Development\Personal-Portfolio\.agent-office\autonomous.json`, shaped as `{ "office": [items] }`.
   - The source is 86 JSON files plus 10 images, exported to this session's scratchpad `notion/` folder (1.json–86.json, `images/`). They are temporary; re-export with notion-fetch if they're gone.
   - Planned column mapping (to confirm with the owner):

     | Notion status | Column |
     |---|---|
     | Priority | Urgent |
     | High priority | Urgent |
     | Important/Not Urgent | Not urgent |
     | Not Urgent/Important | Not urgent |
     | Other Important | Not urgent |
     | No status | Not urgent |
     | Archive | Completed |

   - Put Notion's status, priority and due date on the first line of the notes.
   - A title over 500 characters, or with line breaks, is shortened; the full text goes into the notes.
   - Blank titles become "Untitled".
   - Copy the images into `todo-images/` with their sha names.
   - Import only while the office is stopped, or before restarting it after the build.
3. Update `tests/todos.test.ts` for the `details` action and add/Undo with details. Run `npm run typecheck` and `npm test` (the full suite hangs locally in pull-links, so run the todos tests only).
4. Build per PERSONAL-WORKFLOW / the memory notes, open a PR to `personal`, and put this handoff in the PR description.

## Risks
- Pictures that are taken off a card stay on disk. Nothing cleans them up yet.
- The Autonomous board is office-wide. Anyone signed into the office can see and edit it.
