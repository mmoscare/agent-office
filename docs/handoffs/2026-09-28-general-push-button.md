# General Push button with recommendations

## Request and outcome

The user accidentally opened a screenshot-only worker PR while the real app changes were already committed on personal. They requested a separate button to push those commits and guidance on when to do so, then clarified that it should be named Push and work on other floors/branches too.

Implemented a general Push action, always available from the menu and automatically shown in the top bar when local tracking information shows outgoing commits. Its badge is a reminder to check, not a claim that every repository is safe to push. The dialog explicitly selects a floor repository/current branch, or the running Agent Office app checkout if that is separate. Multiple repositories require a choice. Nothing is automatically committed, pushed or made into a PR.

The chosen repository is checked against origin before advice is shown: ready to push after testing, ready to publish a new branch, all committed work uploaded, commit first, bring remote changes in first, or resolve diverged histories first. The review shows checkout path, branch, redacted destination and the newest 15 outgoing commit subjects, with the total when longer. Uncommitted edits remain local. Push uploads precisely the reviewed commit to the same branch name on origin; concurrent changes invalidate the review. Newly published branches get tracking when possible, without replacing existing upstream settings.

## Changes and decisions

- `src/shared/push.ts`: target/preview types and plain-language recommendations. No branch name is hardcoded.
- `src/server/push.ts`: bounded per-floor repository discovery, optional separate running-app target, remote preview, ten-minute review tokens, exact-commit pushes, origin/branch/head checks, credential-free errors and redacted remote labels. The preview uses origin/current-branch even if another upstream is configured. Separate/multiple origin push destinations require resolving configuration outside this flow.
- `src/server/git-board.ts`: exports the existing office-root lookup and per-checkout Git action lock for the new adapter. Existing Git-board actions remain available.
- `src/server/git-board-routes.ts`: adds GET push-targets and push-preview, POST push-reviewed under the existing authenticated, same-origin Git API route. Target paths are server-resolved and validated; a client cannot choose an arbitrary external checkout.
- `src/client/ui/push.ts` and `push.css`: menu/top-bar action and review dialog, refresh and error recovery, success state, floor-switch cancellation. The dialog backdrop is placed under body so the existing update bar cannot obscure its header or close control.
- `src/client/ui/menu.ts`: registers the action and its refresh callback without editing the concurrently changing main.ts.
- `tests/push.test.ts`: focused local-bare-remote coverage. `tests/push-ui.mjs`: isolated Edge test office, no workers hired, all test pushes to a temporary local bare remote.

## Verification

- `npm run typecheck`: passed, including after the final client changes.
- `npm run build`: passed. After the last interface refinement, `npm run build:client` passed; after adding new-branch tracking, `npm run build:server` passed. The personal checkout's dist is rebuilt.
- `node --import tsx --test tests/push.test.ts tests/git-board.test.ts`: 11/11 passed. The final tracking change was followed by `node --import tsx --test tests/push.test.ts`: 7/7 passed.
- Covered branch names other than personal, exact reviewed upload, keeping dirty files untouched, new branch tracking, origin versus another configured upstream, concurrent local commits and branch switches, incoming/diverged histories, changed remote destination, explicit app/floor targets, invalid paths and incorrectly scoped tokens, detached/empty checkouts, missing origin, and credential redaction.
- `node tests/push-ui.mjs <temporary screenshot path>`: passed. Covered top-bar reminder, explicit repository choice, one actual local-remote upload, unchanged dirty work, up-to-date advice, rejected stale review and recovery, narrow-screen layout, floor-change closure, authentication/origin rejection, no browser runtime errors and clean server shutdown. A final rerun also checked that the close control was unobstructed by the update banner. Visually inspected the final dialog screenshot.
- Initial validation found missing npm command shims and the Windows esbuild optional dependency in the shared checkout. Ran `npm rebuild --ignore-scripts`, then `npm install --ignore-scripts --include=optional --no-audit --no-fund`; no package.json or package-lock.json changes resulted. Initial test browser-path escaping was corrected. These early failures preceded the passing checks above.
- `git diff --check`: passed. The full repository test suite was not rerun: the focused Git behavior and browser tests cover this change; prior wider-suite failures are documented in the binder handoff and Git-board PR #20.
- No real GitHub push, authenticated model request or live-office restart was performed. Temporary test offices shut down and their own directories were removed.

## Commits, branch and external actions

Working app checkout: `C:/Users/Owner/Documents/Development/Agent-Office/agent-office`, branch personal.

Read existing Git-board PR #20 and update-bar PR #25 descriptions/comments before extending these controls:
- https://github.com/mmoscare/agent-office/pull/20
- https://github.com/mmoscare/agent-office/pull/25

Another session committed its inbox/queue work while this task was in progress and included the initial Push implementation in `fd1910d` (To Do Next for the agents, and an in-tray with a door and a Receptionist). That commit was preserved. This task's completion commit contains the remaining Push refinements, both test files and this handoff; find it with `git log -- docs/handoffs/2026-09-28-general-push-button.md`.

No appropriate new GitHub thread exists for this request. No PR was opened or updated and no GitHub comment or push was made during this task. The earlier accidental screenshot PR #35 belongs to the previous conversation task and is not used to ship this change. Existing app-status polling may fetch origin; the new background reminder itself reads local Git state and checks the remote only on review/push.

## Remaining work

No remaining feature implementation work. Restart Agent Office from the Windows tray after active workers finish, then refresh the browser to load the new API/interface. Use Menu > Push (or the automatic top-bar reminder), select the desired repository; select App: Agent Office app for changes in the running app checkout. Review the recommendation and commits before pressing Push.

Changes were committed locally, not pushed by this worker. The current branch may also have incoming remote changes; the dialog checks and explains whether syncing is required. The button does not automatically pull, merge, rebase, force-push, build, restart or open a PR. It does not certify that tests ran: its recommendation explicitly asks that the changes be tested. Review tokens expire after ten minutes and after successful use; refresh when prompted. The server resolves the app target from its own installed code location, so it reflects the actual running checkout rather than a hardcoded personal path.
