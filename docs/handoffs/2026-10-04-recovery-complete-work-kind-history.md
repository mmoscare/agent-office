# Recover task-kind inference on later worker prompts

Ports only the missing one-line behavior from saved history: infer a kind when a follow-up prompt clarifies an existing unclassified task. Preserves its name/summary and any existing kind, current helper and provider flow. Adds coverage using the existing fake OpenCode worker; updates three older prompt expectations to account for the already-merged durable handoff suffix while retaining the exact underlying message assertions.

Validation: 28 relevant tests passed; typecheck and production build passed. Tests use fake providers. No authenticated model request, running app restart or personal-branch update was performed.

Commands actually run:
- `node --import tsx --test tests/work-kind.test.ts tests/workers.test.ts`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0.
- `git diff --check`: passed.

Request: finish the saved Windows-to-Mac recovery while preserving both installations and current Mac edits. Windows has no active workers per the owner. Mac Pixel owns this recovery task through publication; do not assign parallel work on the same branch or start overlapping VP/ingest/recorder duties.

Compared with `personal` at [d38cd017ef599c32aa245b89e2614949d37ceb5e](https://github.com/mmoscare/agent-office/commit/d38cd017ef599c32aa245b89e2614949d37ceb5e). Saved source: [9edd13db84f0097ed996d5cbd1ce7c4bf9df30d2](https://github.com/mmoscare/agent-office/commit/9edd13db84f0097ed996d5cbd1ce7c4bf9df30d2). Original source refs and held branches are retained as evidence.

All original Mac checkouts, commits, edits, local state and Windows backup are preserved. Agent Office remains on personal. Native dependencies and test fixtures stayed out of Git. No default branch was pushed, PR merged, live database replaced, historical import rerun or intentional production deployment performed.

Remaining: review/merge and the explicitly stated runtime/private-data checks. Recovery reconciliation for this branch is complete. Read this PR and comments before continuing; claim one machine/worker. Full inventory, ownership and private-transfer needs: [MAC-IMPORT-REPORT.md](https://github.com/mmoscare/agent-office-mac-handoff/blob/main/MAC-IMPORT-REPORT.md).

Branch: `continue/mac-20261004/work-kind-followup-reconciled`. The resulting commit and PR are recorded in the PR description and private report. This handoff is committed with the change.
