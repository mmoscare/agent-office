# Handoff: 🏢 Autonomous Tasks whiteboard + hidden notes/subtasks/pictures on every kanban

Branch: `office/widget-8706` → PR into `personal`.

## Request
1. **Autonomous Tasks board.** Add another whiteboard called "Autonomous Tasks". It should look exactly like the To Do kanban and carry every task from the owner's Notion page "Autonomous Tasks" (86 rows).
2. **Card details on every kanban board.** This covers the To Do board on the issues wall, the new board and the 🎬 Content Kanban. Cards also take notes, images and subtasks. These stay hidden, so a board looks as it does today, until you double-click the board's background (the cork). Double-click again to hide them.

## Outcome
### The whiteboard
- A new rolling whiteboard stand called **🏢 Autonomous Tasks**:
  - It stands south of the drawing whiteboard, between the south desks and the lounge, facing into the room. The position is `AUTONOMOUS_BOARD` in `shared/layout.ts` (x 5.4, z 5.4).
  - Its face draws the list with the To Do wall's own texture: four columns, Active / Urgent / Not urgent / Completed.
- Press **E** at it, or use ☰ → 🏢 Autonomous Tasks, to open a window with exactly the To Do board's kanban. It uses the same component, `mountTodoBoard(net, 'autonomous')`.
- There is **one list for the whole office**. It is saved in the office's `.agent-office/autonomous.json` under the owner key `office`, and every connected window gets its changes live.

### Card details on all three kanbans
- Double-click the board around the cards (the cork, the gaps, the header strip) to reveal the details. Double-clicking a card still edits the card.
- **Subtasks:** tick them off, double-click one to reword it, ✕ to remove it. A done/total count sits in the details header.
- **Notes:** free text, line breaks kept, saved about 0.7 s after typing stops or when the box loses the cursor. The Content Kanban already shows its notes on the card, so its details panel has only subtasks and pictures.
- **Pictures:** add them with 🖼 Add picture, by pasting, or by dropping files onto the card. Click a thumbnail to open it full size.
  - Pictures over 1600 px or 1.5 MB are shrunk to JPEG in the browser first.
  - They are stored in `.agent-office/todo-images/<sha256-32>.<ext>`.
  - They are served at `GET /api/todo-image?id=` (sign-in required, sandboxed CSP) and uploaded with `POST /api/todo-image` (same-origin only). Only PNG, JPEG, GIF and WebP are accepted, checked by magic bytes; SVG is refused.
- Each board remembers on its own whether details are revealed, while the page is open. The default is hidden.
- While details are revealed, the wall texture adds a `☑ 2/5 · 📝 notes · 🖼 1` line under each card that has details. This applies to the To Do wall and the Autonomous stand; the Content Kanban's stand texture is unchanged.

### The Notion import (data, not code: the repo is public)
All 86 Notion tasks were written into the **live office's data folder**, `C:\Users\Owner\Documents\Development\Personal-Portfolio\.agent-office\autonomous.json`, plus 9 unique pictures in `todo-images/`. That folder is not a git repo. The running office ignores the file until it restarts on this branch's build.

- **Columns:**

  | Notion | Column | Cards |
  |---|---|---|
  | Priority, or Priority property High | Urgent | 15 |
  | Important/Not Urgent, Not Urgent/Important, Other Important, no status | Not urgent | 53 |
  | Archive | Completed | 18 |

  Active is left empty for the owner to start things.
- **Each card's notes** start with `Notion: <status> · Priority <p> · Due MM/DD/YYYY`. The Notion page body follows, when there is one (11 pages had one).
- **Long titles:** titles over 280 characters are shortened on the card with "…", and the full text goes into the notes under "Full task:" (8 cards). Multi-line titles are also kept in full there.
- **Blank titles:** the 2 blank Notion rows are "Untitled (blank in Notion)".
- **Checklists and pictures:** Notion checkbox blocks became subtasks (2 cards). Page images became pictures; 10 files turned out to be 9 unique pictures.
- **Ordering and dates:** cards are ordered within a column like Notion's board (latest due first, then newest). `at` is Notion's createdTime.
- **Card ids** are the Notion page ids, so a later re-sync can match cards.
- The import script and the raw export live only in the session scratchpad. They are not in the repo, because the task text is private and the repo is public.

## Key files
- `src/shared/todos.ts`:
  - `TodoBoardId`, `TodoDetails` and `TodoSubtask`.
  - The `details` action.
  - `add` carries details, so Undo restores them.
  - Validation and limits: notes 20k, 100 subtasks, 20 pictures.
  - `cleanSubtasks` and `cleanImages` are exported.
- `src/server/todos.ts`: the file name is now a parameter. `src/server/todo-images.ts` (new) is the picture store. `src/server/server.ts` has the second store, sends it on arrival, branches the `todo` message on `board`, and adds the `/api/todo-image` route.
- `src/shared/content-kanban.ts`: `subtasks` and `images` on `ContentItem`, plus a `details` action.
- `src/shared/protocol.ts`: optional `board` on `todo` and `todos`.
- `src/client/state.ts`: `store.autonomous` and `autonomousPending`, plus the `autonomous` topic.
- `src/client/ui/todo-details.ts` (new): the reusable details panel and the per-board revealed state.
- `src/client/ui/todos.ts`:
  - The board is parameterised by `TodoBoardId`.
  - Double-click to reveal; focus, caret and drafts survive redraws.
  - `openAutonomousBoard`.
- `src/client/ui/content-kanban.ts`: the same reveal and the panel, with `notes: false`.
- `src/client/world/kanban-stand.ts` (new): the stand. It is wired into `world/office.ts` (`office.autonomousBoard`, InteractKind `autonomous`) and `shared/nav.ts` (the dog keeps off it).
- `src/client/world/todo-wall.ts`: a `title` parameter and detail badges.
- `src/client/main.ts`: the stand texture, **E**, the hint, the ☰ entry and the `__office.autonomousBoard()` test hook.
- `src/client/ui/todos.css`: the details styles. The To Do body padding moved inside `.todo-board`, so a double-click anywhere on the cork reaches it.

## Checks run
- `npx tsc -p tsconfig.client.json --noEmit` and `npx tsc -p tsconfig.server.json --noEmit`: clean.
- `npm run build`: ok.
- Unit tests: 118/118 pass. Command: `node --import tsx --test --test-force-exit tests/todo-details.test.ts tests/todos.test.ts tests/content-kanban.test.ts tests/nav.test.ts tests/hoop.test.ts tests/player.test.ts tests/seats.test.ts tests/building.test.ts tests/stations.test.ts tests/reception.test.ts tests/cabinet.test.ts tests/plans.test.ts tests/back-office.test.ts tests/docs.test.ts tests/emotes.test.ts tests/auth.test.ts tests/config.test.ts`. The new `tests/todo-details.test.ts` covers:
  - details apply, clear and survive moves and Undo
  - validation, including path-traversal picture names
  - the separate autonomous.json
  - the picture store (sniffing, SVG refused)
  - Content Kanban details
- `node tests/autonomous-ui.mjs` (new; headless Edge against a WebSocket fixture): passed 5 of 5 runs after the fixes. It covers:
  - the stand face and E at the stand
  - the same four columns
  - plain by default, and a card double-click still editing
  - the double-click reveal
  - seeded notes, subtask and picture
  - adding and ticking subtasks, typing notes (cursor kept across redraws), uploading a picture
  - hiding again
  - the To Do board's own separate reveal and list
- `node tests/content-kanban-ui.mjs`, with a new section on reveal, adding a subtask and hiding: ok.
- `node tests/todos-ui.mjs`: 5 of 6 runs passed. The one failure was a one-shot focus assertion under load; it passed on every re-run.
- **End to end against a throwaway office** built from this branch (`cli.js` on :4711, scratch password and home, the real import in its data dir):
  - All 86 cards loaded (15/53/18).
  - A picture was served (200) and refused without sign-in (401).
  - An upload was accepted, and refused from another origin (403).
  - A details change came back over the socket and was saved to disk.
  - Screenshots of the real data were taken; they are linked in the PR.
- Not run: the full `npm test` (it hangs on Windows; see the memory notes), and remote CI (`release.yml` dispatch).

## Remaining / next steps
- Review and merge the PR into `personal`. Then, in `C:\Users\Owner\Documents\Development\Agent-Office\agent-office`: pull, run `npm run build`, and restart the office. A restart stops running workers, so pick a quiet moment. The Notion tasks are already in place and appear after the restart.
- Pictures removed from a card stay in `todo-images/`. Nothing cleans up unused pictures yet.
- The Autonomous board is office-wide: anyone signed in to the office can see and edit it. Today only the shared password is in use.
- The Notion import is a one-time copy. Later Notion edits don't sync. The card ids are the Notion page ids, in case a sync is wanted later.
- Optional: detail badges on the Content Kanban's stand texture.

## Review fixes (Codex findings on #82)
1. **Own changes lost to someone else's broadcast** (`src/client/state.ts`): the Autonomous board now works like the Content Kanban. The office marks the answer to the sender's own change with `mine`, the page keeps its changes that haven't been answered yet, and it replays them on top of every broadcast (`store.changeAutonomous`). Unit test: `tests/todo-details.test.ts`, "your changes stay on screen until the office answers them".
2. **Subtask rewording lost on a redraw** (`src/client/ui/todo-details.ts`): the subtask being reworded, and what's typed so far, are kept outside the page. A redraw draws the box again and gives it back the cursor. Blur is checked only after the redraw, so the box being taken off the page doesn't end the edit.
   - The new browser step in `tests/autonomous-ui.mjs` also found two older bugs, both fixed:
     - Double-clicking a subtask's words toggled its checkbox, because the words sit inside the checkbox's label.
     - The double-click bubbled up to the card, which opened the card's own editor.
   - With those fixed, the step rewords a subtask while another user's change arrives, carries on typing, and saves.
