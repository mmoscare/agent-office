# Validate recovered Windows Node shebang launching on Windows

Recovers extensionless Node shebang launch support and its regression case missing after #97. Adds a Windows-latest / Node 22 CI job with read-only contents permission, using the repository existing action versions. Native dependencies are installed on the runner without running app preparation, then the Windows command suite is executed. It does not access provider logins or either live installation.

Validation: All 6 Windows tests passed with zero skips in https://github.com/mmoscare/agent-office/actions/runs/37240499669 at d5b49980be4d267376599ce29d7fe714a59f9a3f. The final follow-up only records that result; tested launcher and test source are unchanged. Initial recovery Mac typecheck/build also passed. Actual Windows desktop/provider startup is a separate runtime check.

Commands actually run:
- Windows: `node --import tsx --test tests/windows-command.test.ts`: 6 passed.
- `git diff --check`: passed.

Request: finish the saved Windows-to-Mac recovery while preserving both installations and current Mac edits. Windows has no active workers per the owner. Mac Pixel owns this recovery task through publication; do not assign parallel work on the same branch or start overlapping VP/ingest/recorder duties.

Compared with `personal` at [d38cd017ef599c32aa245b89e2614949d37ceb5e](https://github.com/mmoscare/agent-office/commit/d38cd017ef599c32aa245b89e2614949d37ceb5e). Saved source: [ea5f17ce9f12c71bc5ab60fcb705503506f2d1df](https://github.com/mmoscare/agent-office/commit/ea5f17ce9f12c71bc5ab60fcb705503506f2d1df). Original source refs and held branches are retained as evidence.

All original Mac checkouts, commits, edits, local state and Windows backup are preserved. Agent Office remains on personal. Native dependencies and test fixtures stayed out of Git. No default branch was pushed, PR merged, live database replaced, historical import rerun or intentional production deployment performed.

Remaining: review/merge and the explicitly stated runtime/private-data checks. Recovery reconciliation for this branch is complete. Read this PR and comments before continuing; claim one machine/worker. Full inventory, ownership and private-transfer needs: [MAC-IMPORT-REPORT.md](https://github.com/mmoscare/agent-office-mac-handoff/blob/main/MAC-IMPORT-REPORT.md).

Branch: `continue/mac-20261004/windows-node-shebang`. The resulting commit and PR are recorded in the PR description and private report. This handoff is committed with the change.
