# Mac source recovery: c089 — 2026-10-04

Request: reconcile saved Windows work on the existing Mac while keeping both installations usable.

Outcome: missing source recovered on the current target lineage. Recover only Windows extensionless Node shebang launch support and its regression test, absent from personal after #97. Scratch validation helpers stay in the source archive. Mac cannot certify Windows-only execution.

- Repository: https://github.com/mmoscare/agent-office
- Continuation branch: `continue/mac-20261004/windows-node-shebang`.
- Source: [ea5f17ce9f12c71bc5ab60fcb705503506f2d1df](https://github.com/mmoscare/agent-office/commit/ea5f17ce9f12c71bc5ab60fcb705503506f2d1df) (`recovery/windows-20260930/c089`).
- Current comparison target: `personal` at [d38cd017ef599c32aa245b89e2614949d37ceb5e](https://github.com/mmoscare/agent-office/commit/d38cd017ef599c32aa245b89e2614949d37ceb5e).
- Private master report: https://github.com/mmoscare/agent-office-mac-handoff/blob/main/MAC-IMPORT-REPORT.md

## Decisions and scope

Existing Mac files, commits, stashes, credentials and office state remain unchanged. The running Agent Office checkout remains on personal. The owner confirmed all Windows workers were sent home and no Windows work is active. Mac owns recovery; no recovered feature task or VP sweep was started. Both computers remain available. Never activate Windows machine settings from saved history. No default-branch push, merge, deployment, provider login, notification or real database write was performed.

This branch contains only the missing checkpoint delta on the target; already represented changes and archive-only migration metadata were omitted.

## Checks actually run

- Documented `fetch_windows_work.py` plan and apply: expected source commit verified; repository `git fsck --full --no-reflogs` passed.
- Compared source files/history against current GitHub and mapped existing Mac projects by canonical repository identity.
- `node --import tsx --test tests/windows-command.test.ts tests/command-resolution.test.ts tests/codex-windows-hooks.test.ts`: PASS on Mac: 2 passed, 6 Windows-only tests skipped. Extensionless shebang behavior still needs a Windows run.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.

## Remaining work

Review this recovery branch before merging. Checks establish only the specific behavior listed, not deployment or authenticated runtime readiness.

Private data, environment configuration and dependencies stay machine-local. Transfer required data separately from Windows using a checksummed private copy and preserve the Mac originals. No code was newly implemented beyond recovery of existing changes. No recovered feature was continued after this report stage.

### Recovered files

- `src/server/windows-command.ts`
- `tests/windows-command.test.ts`
### Retained only in the original archive

- `docs/handoffs/2026-09-30-windows-mac-c089.md`
- `tmp-related.mjs`
- `tmp-vp-comment.txt`
