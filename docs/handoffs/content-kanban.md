# Handoff: 🎬 Content Kanban on the Autonomous-Dev-Projects floor

## Request
On the Autonomous-Dev-Projects floor only, put a second kanban in place of the whiteboard: a "Content Kanban". It takes a dump of content ideas. Toggles pick what each idea becomes (YouTube, Short, TikTok, X post, thread, article…). On submit, the picked formats become a checklist on the card.

## Outcome
- On floor id `autonomous-dev-projects`, the rolling whiteboard stand shows the Content Kanban. Its face and plaque change, and E opens the board. Every other floor keeps the normal whiteboard.
- The Excalidraw whiteboard is still reachable on that floor from ☰ → Whiteboard, so existing drawings stay available.
- ☰ → 🎬 Content Kanban appears only on that floor.
- **Dump box:** one idea per line. Bullets and numbering are stripped, and up to 50 ideas go in per submit. Ctrl+Enter or the button adds them to the top of 💡 Ideas.
- **Format toggles:** YouTube video, YouTube Short, TikTok, Instagram Reel, X post, X thread, Article, LinkedIn post, Newsletter, Podcast. Each toggled format becomes a checklist box on every idea in that dump. The toggles reset after each submit.
- **Stages:** 💡 Ideas → ✍️ Scripting → 🎥 Creating → ✂️ Editing → 📅 Scheduled → 🚀 Published.
- **Cards:**
  - A checklist, with a progress bar showing X/Y made.
  - Next and back buttons.
  - Drag and drop, plus keyboard control (←/→, Alt+↑/↓, Enter to edit, Delete).
  - Edit: title, notes, formats (ticks are kept), and a day to go out, flagged when it's soon or late.
  - Remove with Undo.
  - Once everything is ticked, a "🚀 All made — mark it published" button appears.
- A "Show:" row filters cards by format. A summary bar shows counts, pieces made, and anything past its day.
- The board is shared live by everyone on the floor. It's saved in the floor's `.agent-office/content-kanban.json`.

## Key files
- `src/shared/content-kanban.ts`: stages, formats, actions, validation, `applyContent`, and `CONTENT_KANBAN_FLOORS` (add a floor id there to give another floor one).
- `src/server/content-kanban.ts`: per-floor store. Wired in `src/server/floor.ts` (`floor.content`) and `src/server/server.ts` (`content` in FloorView, plus the `content` message handler).
- `src/shared/protocol.ts`: `{t:'content', change}` goes from client to server. `{t:'content', floor, items, mine}` comes back from the server. `mine` acknowledges your own change.
- `src/client/state.ts`: `store.content`. It applies changes optimistically and replays unanswered changes on top of the office's copy.
- `src/client/ui/content-kanban.ts` and `.css`: the window.
- `src/client/world/content-kanban.ts`: the stand's face texture. `src/client/world/whiteboard.ts` gains `cover()` and `size`.
- `src/client/main.ts`: face swap, E key, hint, ☰ item, `__office.contentKanban()` test hook.

## Checks run
- `npx tsc -p tsconfig.client.json --noEmit` and the server tsconfig: clean.
- `npm run build`: ok.
- `node --import tsx --test --test-force-exit tests/content-kanban.test.ts tests/todos.test.ts tests/plans.test.ts tests/nav.test.ts tests/back-office.test.ts tests/local-floors.test.ts tests/cabinet.test.ts`: 61/61 pass.
- `node tests/content-kanban-ui.mjs` (new; headless Edge against a WebSocket fixture): ok. It covers:
  - the dump, toggles and checklist
  - ticking, moving, editing, publishing, dragging, undo and the filter
  - a second window seeing changes live
  - reload persistence
  - other floors keeping the whiteboard
  - narrow layouts
- `node tests/todos-ui.mjs`: ok (regression).
- Not run: the full `npm test` (it hangs on Windows; see memory) and remote CI.

## Remaining / next steps
- Review and merge this PR into `personal`.
- Then, in `C:\Users\Owner\Documents\Development\Agent-Office\agent-office`: pull, run `npm run build`, and restart the office. A restart stops running workers, so pick a quiet moment.
- Not verified in the live office yet: that the real floor id is `autonomous-dev-projects`. It is, per the office's `floors.json` on 2026-09-28.

## Follow-up (2026-09-29): don't lose edits while the office is out of reach
PR #70 merged. Its Codex review (P1) found that while the socket was reconnecting, changes still showed on screen. `Net.send` dropped them, and the board the office sent on reconnect wiped them, so a dump of ideas could vanish.

**Fix:** `changeContent` in `src/client/ui/content-kanban.ts` refuses changes while `net.up` is false. It shows a "Not connected" toast and redraws, which un-ticks a box that was just clicked. It now returns whether the change went through. After a refusal:
- the dump box keeps its ideas and format toggles;
- Remove shows no false "Undo", and Undo keeps its card;
- the card editor stays open with what's typed in it.

**Checks:**
- `npm run build` and the client typecheck: clean.
- `node tests/content-kanban-ui.mjs`: ok. It has a new offline step, which sets `__office.net.up = false` and checks that nothing is sent and nothing is lost.
- `tests/content-kanban.test.ts`: 12/12 pass.

**Remaining:** merge the follow-up PR. Then pull, build and restart the app folder, as above.
