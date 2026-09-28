# Finish Kilo: stop typing when a worker is paused or interrupted

## Request and outcome

The user asked to finish the interrupted task on `office/kilo-919f`: ?if the workers arent working/paused in their chat/interrupted then please dont make their arms move like theyre working?. Implemented and rebuilt in the required personal app checkout, `C:/Users/Owner/Documents/Development/Agent-Office/agent-office`, on `personal`.

Workers now rest their arms when paused or interrupted, display that state, resume typing when work resumes, and keep their queue slot until they actually finish or are dismissed. Normal completion and live permission/question behavior remain intact.

## Recovery and decisions

- Original Kilo worker `919f4d60f30e`, task `bba1001118b3`, had no implementation changes. The earlier recovery handoff is `docs/handoffs/2026-09-28-kilo-919f-task-recovery.md` on the Kilo branch.
- Hopper (`office/hopper-f577`, task `90fb32365167`) left the original partial fix. Sprocket (`office/sprocket-9b05`, task `e2f86938b215`) recovered it but left staged changes and an untracked test without a commit or PR. Read its saved assignment, source diff and tests; copied the diff and test out without modifying either predecessor worktree.
- The personal checkout was already in a conflicted merge of `origin/personal` at `b634c75`, with two local receptionist commits. Backed up staged and unstaged diffs plus the conflicted file under `%TEMP%/agent-office-kilo-recovery-20260928`. Resolved the single `src/server/server.ts` conflict by keeping both the receptionist mail callbacks and the Shell tab's separate data/buffering path. Saved merge checkpoint `178ca2adc4bcf9303483109a210d657aab2a7ed1`. Read PR #29 and #35 descriptions/comments before doing so.
- Applied Sprocket's patch with `git apply --3way`; all files merged cleanly, retaining newer imports. Pre-existing changes in `personal/windows/Launcher.cs` and `personal/windows/README.md` were preserved and excluded from this task's commit.
- `paused` means a reported end of terminal progress without confirmed completion; it is not inferred merely from elapsed silence. `interrupted` means an explicit provider cancellation. Both use the existing rest pose, remain promptable, and do not trigger false completion alerts. Permission questions retain the existing waiting pose.

## Code changes

- `src/shared/protocol.ts`, `src/shared/status.ts`: define stopped states and `isStopped`; they are neither busy nor asleep.
- `src/server/workers.ts`: handle Claude root tool cancellation, Claude OSC idle progress, Codex Interrupt, and OpenCode aborts; clear stale actions/input state; prevent late completion or Codex post-tool reports from undoing cancellation. New prompts/progress resume work. Persisted/adopted live terminals retain stopped states.
- `src/server/opencode.ts`: forward root `MessageAbortedError` from session and assistant-message events, retain aborted reply usage, and ignore permission/question replies whose pending requests were already cleared by cancellation.
- `src/server/queue.ts`: stopped workers retain their slots and do not complete tasks prematurely.
- `src/client/world/character.ts`, `src/client/world/boards.ts`, `src/client/ui/dom.ts`, `src/client/style.css`: paused/interrupted labels, bubbles and colors. Existing pose selection already restricts typing/tool acts to `working`; the new statuses fall through to rest.
- `src/client/main.ts`: retain the completion celebration if an idle progress report preceded the final Stop hook (`working -> paused -> done`).
- Tests: provider lifecycle, late events, queue capacity, real OSC parsing, restore/adoption, and a browser check of the actual character's arm motion. Reviewed working-state consumers: stopped workers do not produce typing sounds, busy counts or completion notifications; meetings wait for genuine completion.

## Checks actually run

- Initial `npm run typecheck` could not start because the checkout lacked the TypeScript launcher. `npm ci --ignore-scripts --no-audit --no-fund` failed when active terminals held `conpty.node` open. An incremental install repaired the missing files; a subsequent `npm install --ignore-scripts --no-audit --no-fund` restored the exact lockfile versions. Compared every present installed package version with the lockfile: zero mismatches. `package.json` and `package-lock.json` are unchanged. A locked obsolete native-package cleanup directory was left alone.
- Final `npm run typecheck`: PASS, both client and server, with locked dependencies.
- Final `node --import tsx --test tests/worker-stopped.test.ts tests/codex-input.test.ts tests/opencode.test.ts tests/queue.test.ts tests/worker-attention.test.ts tests/sideshell.test.ts`: PASS, 43/43, with locked dependencies. Includes a real local side-shell lifecycle test; no authenticated model request.
- Final `node tests/worker-animation-ui.mjs`: PASS in headless Edge. Instantiates the real character in a browser via Vite. All seven inactive states stop typing and settle at rest within one second despite a stale tool-action hint. Work resumes typing, live questions retain their waiting pose, and completion retains its bounce. Paused/interrupted labels and bubbles are checked. No live office or provider is used.
- Final `npm run build`: PASS for Vite and server TypeScript, with locked dependencies. The personalized app's `dist` is rebuilt; generated files are not committed.
- `npm test`: 349 tests, 331 passed, 18 failed. This broader run occurred during dependency repair, before the final exact-lock restoration. The whole suite was not repeated after restoration; the feature suite, typecheck, browser check and build above were repeated.
- Full-suite failures: 14 in `tests/workers.test.ts` (13 fake-agent startup timeouts and an `office-queue` ENOENT); Windows hook subprocess exit in `codex-windows-hooks.test.ts`; Windows shell argument expectation in `handoff.test.ts`; Windows path separator and meeting-commit assertions in `meetings.test.ts`. The worker fixture failures were already documented in PR #29/#35. On the unchanged current PR base, reran `node --import tsx --test --test-name-pattern='shell launch and input|without writing the file|output is committed|generated Windows Codex hook' tests/handoff.test.ts tests/meetings.test.ts tests/codex-windows-hooks.test.ts`: all four failures reproduced. These are not a green full-suite claim.
- `git diff --check` and `git diff --cached --check`: PASS before final staging.

## References and external actions

Repository: https://github.com/mmoscare/agent-office. App branch: `personal`. Publication branch: `office/kilo-919f`, PR base `personal`; the feature commit is transferred separately so unrelated local receptionist commits and launcher edits are not published with it. Exact publication commits and PR link are recorded in the PR description.

Read prior handoffs at https://github.com/mmoscare/agent-office/pull/29 and https://github.com/mmoscare/agent-office/pull/35. No original feature PR or issue was found for Kilo/Sprocket. No upstream update, main-branch mutation, force push, live queue edit, model request or worker termination was performed.

## Remaining work and limits

Implementation is complete. PR review/merge and activation of the rebuilt server remain. The Windows launcher documents that restarting stops its worker processes, so no live-office restart was performed during active work. Once workers can be interrupted safely, use the tray menu's **Restart Agent Office**, refresh the browser, and smoke-test cancellation/resumption with the actual logged-in provider. Existing OpenCode sessions may need to be restarted to load the updated plugin. This task tested provider hooks and terminal progress using fixtures, not authenticated model responses.

Existing broader-suite failures remain outside this feature's scope. Do not erase the other workers' worktrees or the two pre-existing launcher edits during cleanup. The personal checkout may also receive newer remote changes from other workers; integrate those separately while preserving this feature and local customizations.

## Follow-up: get PR #44 ready and merge

Request: check out `office/kilo-919f`, address open review comments, merge `personal` if needed, verify, push, wait for checks, merge https://github.com/mmoscare/agent-office/pull/44.

### Outcome

- Merged `origin/personal` (`2e99ba7`, through PR #39) into `office/kilo-919f`. The only conflict was `src/server/workers.ts` imports; kept both `withoutCheckpoint` (ledger/checkpoint) and `isStopped`.
- Open Codex review (P1 on Codex `Stop`): delayed `Stop` after `UserPromptSubmit` could complete the new turn. Workers now keep cancelled turn ids and ignore completion/tool-end events for those turns.
  - Codex: `turn_id` from hooks.
  - Claude/custom: optional `turn_id` plus a local epoch.
  - OpenCode: plugin stamps `turnId` on prompt, abort, and idle/done.
- Untagged Claude Stop after a new prompt still cannot be attributed (Claude Code hooks do not include a turn id today). Status-while-interrupted still holds.

### Checks

- `npm ci --ignore-scripts --no-audit --no-fund`: installed lockfile deps in this worktree.
- `npm run typecheck`: PASS.
- `node --import tsx --test tests/worker-stopped.test.ts tests/codex-input.test.ts tests/opencode.test.ts tests/queue.test.ts tests/worker-attention.test.ts tests/sideshell.test.ts tests/roster.test.ts tests/task-status.test.ts tests/codex.test.ts`: 60 passed, 0 failed.
- `npm run build`: PASS.
- `git diff --check`: PASS.

Live-office restart and authenticated provider smoke tests were not run. No credentials were used.
