# Recovery integration CI repair — 2026-10-04

Owner request: complete the Windows/Mac recovery and integration without losing either machine's work. Mac Byte owns this continuation; no VP, recorder, ingest or notification automation was started.

Read PRs #98/#99, #97, #96 and the private recovery reports before continuing. A fresh, unmodified `personal` baseline at `d38cd017ef599c32aa245b89e2614949d37ceb5e` failed Ubuntu CI: https://github.com/mmoscare/agent-office/actions/runs/37244877742 (774 pass, 10 fail). The failures are cleanup stdin EPIPE, the Windows-only npm path in the office-update fixture, and the already-corrected prompt expectations in #98. Cleanup failure counts vary with process timing.

Changes:
- `src/server/cleanup.ts`: end stdin without an empty chunk when Git receives no input; handle stream errors as rejected scan promises. A failed real input is still an error, preserving fail-closed cleanup behavior.
- `src/server/office-update.ts` / `tests/office-update.test.ts`: share the existing npm resolution across Windows, Linux and macOS rather than assuming npm lives under Node's bin directory. Preserve captured subprocess stderr for useful failures.
- The office-update fixture now resolves macOS's `/var` alias to its physical path, matching Git's toplevel path. This corrects the fixture's false app-root mismatch.

Checks at this checkpoint: `node --import tsx --test --test-reporter=spec tests/cleanup.test.ts tests/office-update.test.ts tests/workers.test.ts`: 52 passed, no skips. `npm run typecheck` passed. Earlier fixture runs reproduced npm/path failures and are not passes. Build and full-suite/Ubuntu integration results will be recorded in the PR's additive completion comment and description before merge.

Work is isolated in `/private/tmp/mac-integration-20261004/agent-office` on the existing #98 branch. The live checkout remains on personal, and all 41 original Mac checkouts passed the pre-integration preservation audit. CleanBot #96 remains separate with its three review findings; no cleanup operation ran against a real floor. No private data or generated dependencies are committed. Keep the Windows backup.

## Mac full-suite continuation

The broad native Mac run exposed two baseline platform issues beyond the Ubuntu failures. `Workspaces.check()` compared a physical root to an aliased `/var` floor, refusing valid multi-repository workspaces. It now resolves the floor before confinement checks; a portable alias regression also verifies that an escaping worktree link remains refused. Test fixtures use physical paths so their Git interception and launch assertions compare the same directory.

BSD tar can finish at the archive end marker before Git finishes writing padding, producing an asynchronous stdin EPIPE. The verification runner now consumes that error and drains the producer; the child exit status still decides success/failure. Other input errors fail the step. A regression verifies early input closure for both successful and failed commands. No VP duty was activated.

Checks actually run after these changes on macOS:
- `node --import tsx --test --test-reporter=spec tests/workspaces.test.ts tests/vp-verify.test.ts tests/vp.test.ts`: 32 passed.
- `node --import tsx --test --test-reporter=spec tests/*.test.ts`: 786 passed, 0 failed, 6 Windows-only skips (792 total), 44.85 seconds.
- `npm run typecheck`: passed.

Ubuntu CI passed on the first repair commit `4a99b753687c184806404a4d070d6c01ebcffdd7`: run 37246141556. PR #99 also passed Ubuntu and Windows after merging that repair at `b2842f2f25b3364ed42a80e72f022688685f70a7`: runs 37246362067, 37246362056 and 37246358666. New-head CI, final build and integration receipts will be appended to both existing PRs before completion.

## Review follow-up

Addressed https://github.com/mmoscare/agent-office/pull/98#discussion_r4179886647: a prompt received while OpenCode/Grok is already working now emits and persists its changed task immediately. The regression checks both the published update and workers.json before any later status event. `node --import tsx --test --test-reporter=spec tests/workers.test.ts tests/work-kind.test.ts`: 28 passed after correcting the test fixture's data-directory path. Full native build on the preceding platform-fix head passed; this worker fix receives another build and exact-head Ubuntu CI before merge. No authenticated model request was made by these fixture tests.
