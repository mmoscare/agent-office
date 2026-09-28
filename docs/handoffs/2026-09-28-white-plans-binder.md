# White To Do Next binder on each floor

## Request and outcome

Add a white binder lying flat on the boss office desk. Each floor keeps its own simple board of the user's plans for that directory or repository, with To Do, Progress, and Finished columns.

Implemented and verified. Click the binder, approach it and press E, or use Menu > To Do Next. Add multiline plans, edit them, change their column with a dropdown, and remove them with an explicit confirmation. Each successful mutation reports Saved. There is no automatic worker launch in this task's implementation.

## Changes and decisions

- `src/client/world/plans-binder.ts` builds a closed white binder with page edges, spine details and a To Do Next cover. `world/office.ts` lays it on the left of the boss desk at desktop height and registers the normal interaction. `client/main.ts` adds its interaction, hint, reach and menu entry.
- `src/client/ui/plans.ts` implements the three-column board. It is pinned to the floor opened, closes when changing floors, preserves input after failed saves, and has a Refresh action for conflicting edits from another window. The final body uses the standard padded, scrollable modal layout. `client/style.css` supplies simple column/card styling and a stacked narrow-screen layout.
- `src/shared/plans.ts` defines plan text, statuses, limits and actions. `src/server/plans.ts` stores each floor's board at `<floor directory>/.agent-office/plans.json`. Synchronous revision checks reject stale writes. Writes replace the file through a unique temporary file; failed writes are not acknowledged as saved. Corrupt existing data is left intact rather than replaced with an empty board.
- `server/floor.ts` owns the per-floor store; `server/server.ts` provides authenticated GET/POST `/api/plans?floor=...`, validates floor selection, limits request bodies, and checks the request origin for mutations. No GitHub issue or task queue is created by saving a plan.
- `tests/plans.test.ts` covers persistence, column changes, folder isolation, validation, stale writes, corruption and write failures. `tests/plans-ui.mjs` exercises the real desk click and browser workflow in a temporary office without hiring agents. Test corrections keep its camera below the loft ceiling, freeze the test player's updates rather than all browser animation, match the menu icon's accessible name, and send only one shutdown signal to the test host.

## Verification actually run

- Before the session pause, `npm run typecheck` and `npm run build` passed in the personal checkout with the binder implementation.
- After resuming, `node --import tsx --test tests/plans.test.ts` passed all 4 tests. The initial sandboxed invocation could not spawn Node (EPERM); the authorized unsandboxed invocation passed.
- The resumed personal checkout had active, unrelated inbox/queue integration edits. A typecheck during those edits reported TS2739: FloorView was missing plans and inbox in server/server.ts. Those edits were preserved and are outside this task's commit.
- Exported committed personal HEAD `c1f1580494794d31ef5e7ae8b52e045e91eb2bff` into a local validation snapshot, applied only this task's final UI/test changes, and ran `npm run typecheck` and `npm run build`: both passed.
- `node tests/plans-ui.mjs <screenshot.png>` against that rebuilt snapshot passed: physical binder raycast click; add/edit/move/remove; close/reopen and page reload persistence; failed-save draft retention and retry; stale-write rejection and refresh; separate local-folder floor; floor-change dialog closure; narrow viewport width; unauthenticated and cross-origin rejection; no browser runtime errors; disk contents after clean host shutdown. Visually inspected both the binder lying on the desk and the final board screenshot. Earlier test-camera/menu-locator and duplicate-shutdown-signal failures were fixed in the test before this passing run.
- Ran `npm test` on the committed snapshot as a broader check. It was not clean: failures were reported for "generated Windows Codex hook commands deliver every event through the shell", "shell launch and input do not receive agent instructions", and "a worker that ends its part without writing the file is reminded once, then the meeting stops". The run stopped making progress after project-logo tests and was interrupted; there is no successful full-suite result. These areas were not changed by this task. Binder tests in that run passed.
- Final `npm run build:client` in the real personal checkout passed, updating the launcher-served interface. The existing built server already contains the basic binder API; the unfinished concurrent server integration was not rebuilt or replaced by this task.
- No authenticated model request was attempted; no active office or worker was restarted.

## Branch, commits and external actions

Repository: mmoscare/agent-office. App checkout: `C:/Users/Owner/Documents/Development/Agent-Office/agent-office`, branch `personal`.

While this session was paused, another session saved the original implementation and tests in `d048836` (WIP plans checkpoint before merging #19/#20). On resumption that commit was already in personal history. This completion commit contains the final scrolling-body change, corrected browser test, and this handoff. Identify it with `git log -- docs/handoffs/2026-09-28-white-plans-binder.md`.

Read recent GitHub PR metadata to check for an appropriate existing binder thread; none was identified. No issue, PR, comment or push was created by this task. The local handoff is the durable record. All other workers' uncommitted inbox/queue/worker/protocol changes were left in place and excluded from this completion commit.

## Remaining work and risks

No remaining implementation work for the requested basic binder. Refresh the browser for the final interface. If connecting to a server that predates the binder API, use Restart Agent Office from the Windows tray after active workers finish. The live office was deliberately not restarted during concurrent work.

The separate inbox/queue integration was in progress at completion and must be finished and revalidated by its owner before rebuilding that server source. Its later behavior may expand the original manual-only binder described here. Broad-suite failures noted above remain uninvestigated outside this feature's scope. The binder is shared by people who can access the floor, following the office's existing per-floor model; it is not a separate per-account private notebook. Concurrent independent server processes writing the same floor's metadata are not supported.
