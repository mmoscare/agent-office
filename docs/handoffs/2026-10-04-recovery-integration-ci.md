# Recovery integration CI repair — 2026-10-04

Owner request: complete the Windows/Mac recovery and integration without losing either machine's work. Mac Byte owns this continuation; no VP, recorder, ingest or notification automation was started.

Read PRs #98/#99, #97, #96 and the private recovery reports before continuing. A fresh, unmodified `personal` baseline at `d38cd017ef599c32aa245b89e2614949d37ceb5e` failed Ubuntu CI: https://github.com/mmoscare/agent-office/actions/runs/37244877742 (774 pass, 10 fail). The failures are cleanup stdin EPIPE, the Windows-only npm path in the office-update fixture, and the already-corrected prompt expectations in #98. Cleanup failure counts vary with process timing.

Changes:
- `src/server/cleanup.ts`: end stdin without an empty chunk when Git receives no input; handle stream errors as rejected scan promises. A failed real input is still an error, preserving fail-closed cleanup behavior.
- `src/server/office-update.ts` / `tests/office-update.test.ts`: share the existing npm resolution across Windows, Linux and macOS rather than assuming npm lives under Node's bin directory. Preserve captured subprocess stderr for useful failures.
- The office-update fixture now resolves macOS's `/var` alias to its physical path, matching Git's toplevel path. This corrects the fixture's false app-root mismatch.

Checks at this checkpoint: `node --import tsx --test --test-reporter=spec tests/cleanup.test.ts tests/office-update.test.ts tests/workers.test.ts`: 52 passed, no skips. `npm run typecheck` passed. Earlier fixture runs reproduced npm/path failures and are not passes. Build and full-suite/Ubuntu integration results will be recorded in the PR's additive completion comment and description before merge.

Work is isolated in `/private/tmp/mac-integration-20261004/agent-office` on the existing #98 branch. The live checkout remains on personal, and all 41 original Mac checkouts passed the pre-integration preservation audit. CleanBot #96 remains separate with its three review findings; no cleanup operation ran against a real floor. No private data or generated dependencies are committed. Keep the Windows backup.
