# Stopped chat status above workers

## Request and outcome

Show when Claude Code, Codex, or Grok chats are interrupted or paused in the status above the agent's head. Implemented distinct PAUSED and INTERRUPTED labels on task cards and taskless bubbles, with orange status bulbs and matching labels in terminal/UI pills and the queue whiteboard. Normal completion remains DONE; active questions/approvals remain NEEDS YOU. A new prompt or provider busy signal returns the worker to WORKING.

## Changes and decisions

- `src/shared/protocol.ts`, `src/shared/status.ts`: add `paused` and `interrupted` as live, promptable statuses. They are neither sleeping processes nor successful completions.
- `src/server/workers.ts`: Codex Interrupt maps to interrupted; late Stop/PostToolUse and stale approval controls cannot overwrite it. Claude idle progress without a Stop hook maps to paused, while explicit interrupted tool failures map to interrupted. A normal Claude Stop can resolve the provisional paused state to done. Persisted live terminals accept both new statuses when restored.
- `src/server/opencode.ts`: Grok continues through the existing OpenCode provider. MessageAbortedError on root session errors or root assistant message updates reports interruption. Usage still includes aborted replies; child aborts do not change root status. Subsequent idle events do not turn interruption into completion. Other errors retain their existing needs-input behavior.
- `src/server/queue.ts`: a stopped worker retains its queue slot/task until resumed or dismissed. Stopping must not mark a task complete or automatically replace its worker. Meetings likewise wait for the stopped worker to continue rather than treating it as done.
- `src/client/world/character.ts`, `src/client/world/boards.ts`, `src/client/ui/dom.ts`, `src/client/style.css`: render both states, including workers without task cards. Character status maps are now exhaustive against WorkerStatus.
- Tests cover provider lifecycle transitions, late events, stale controls, child scope, normal completion, usage preservation and queue slots. The existing worker action assertion now expects a cancelled worker to stop its typing/testing animation.

Claude's PAUSED label is deliberately conservative: idle progress alone does not establish why the turn stopped. Its documented Stop hook excludes user interrupts: https://code.claude.com/docs/en/hooks#stop. OpenCode's abort/error/idle ordering was checked against https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts. No provider CLI launch arguments or credentials changed.

## Verification actually run

- `npm ci --ignore-scripts --offline`: succeeded; dependency lockfile unchanged.
- `npm run typecheck`: passed.
- `npm run build`: passed, client and server. The first build's session result was unavailable after a conversation continuation, so the build was repeated and its zero exit status recorded.
- `node --import tsx --test tests/worker-stopped.test.ts tests/codex-input.test.ts tests/codex.test.ts tests/opencode.test.ts tests/queue.test.ts tests/attention.test.ts tests/phone.test.ts`: 46/46 passed. Initial sandbox attempt could not spawn Node test processes (EPERM); the approved unsandboxed run passed.
- `node tests/worker-status-ui.mjs`: passed in headless Edge using an isolated Vite fixture. It instantiates the real Worker view, checks the actual overhead texture text for Claude/Codex/Grok, checks taskless bubbles and clearing on resume, and reports no browser errors. Screenshot inspected at `.agent-office/worker-status-smoke.png` (ignored, generated locally).
- `npm test`: 245 passed, 17 failed (262 total). Failures: 14 Windows worker-launch/PTY fixtures in `workers.test.ts`, the shell `-l` expectation in `handoff.test.ts`, a Windows path separator assertion in `meetings.test.ts`, and a 3-second child timeout in `codex-windows-hooks.test.ts`.
- Untouched base `b6a5ab042a09775feeb6fa121e47d2dfd2dd5c62` was exported with `git archive` into an ignored isolated snapshot, with this worktree's installed dependencies linked. Running `node --import tsx --test tests/codex-windows-hooks.test.ts tests/handoff.test.ts tests/meetings.test.ts tests/workers.test.ts` there produced 20 passed, 16 failed: the same 14 worker failures and the same shell/path assertions. The hook test passed on the base.
- `node --import tsx --test tests/codex-windows-hooks.test.ts` rerun alone on the changed branch: 1/1 passed, including every generated lifecycle hook through Windows shells. The full-suite timeout was transient.
- `git diff --check`: passed.
- No authenticated provider model requests or live personal-office restart were performed. The browser check verifies actual card rendering in isolation, not a live provider cancellation.

## Actions and references

Repository: https://github.com/mmoscare/agent-office. Task branch: `office/hopper-f577`; base/PR target: `personal`. Implementation is the commit containing this handoff; the PR description records its exact SHA and publication link.

Followed the user's task-specific instruction to edit and commit in the fresh worktree, overriding the general personal-checkout editing rule. The personal/main checkouts and active workers were not changed. Read `docs/worker-handoffs.md`, the existing Codex alert handoff, and the related open queue-status PR #24 description/comments before editing; did not modify that PR. No related issue was supplied or found in the open issue list. Requested GitHub actions are pushing this task branch and opening its PR; no merge or deployment is requested.

## Remaining work and activation

No remaining implementation work. Review and merge the task PR into personal, rebuild that checkout with `npm run build`, then restart the office through the normal launcher when safe for active workers. Browser refresh alone cannot install the server status changes. OpenCode loads its generated plugin per process: launch/resume a fresh OpenCode process after updating to pick up the abort reporting. This preserves its existing conversation/session flow.

Status reporting depends on the provider events: Claude progress/Stop hooks, Codex Interrupt hooks, and OpenCode MessageAbortedError. Already-stopped chats may need a new turn/event to refresh their old status. A CLI process that actually exits still uses the existing exited/asleep state. Full-suite Windows fixture failures remain outside this task; the new cancellation tests do not require those launch fixtures. No claims of authenticated end-to-end cancellation testing are made.
