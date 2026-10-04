# Mac source recovery: work-kind-history — 2026-10-04

Request: reconcile saved Windows work on the existing Mac while keeping both installations usable.

Outcome: saved task restored for reconciliation; NOT integrated with the current target. PR #27 merged a different restored-task backfill (withGuessedKind). The saved 9edd13d also re-guesses a missing kind on later prompts, still absent. Preserve this optional residual; port only that behavior with current helper and tests, not the old merged feature tree.

- Repository: https://github.com/mmoscare/agent-office
- Continuation branch: `continue/mac-20261004/work-kind-followup`.
- Source: [9edd13db84f0097ed996d5cbd1ce7c4bf9df30d2](https://github.com/mmoscare/agent-office/commit/9edd13db84f0097ed996d5cbd1ce7c4bf9df30d2) (`recovery/windows-20260930/history/office-widget-b34f-9edd13db`).
- Current comparison target: `personal` at [d38cd017ef599c32aa245b89e2614949d37ceb5e](https://github.com/mmoscare/agent-office/commit/d38cd017ef599c32aa245b89e2614949d37ceb5e).
- Private master report: https://github.com/mmoscare/agent-office-mac-handoff/blob/main/MAC-IMPORT-REPORT.md

## Decisions and scope

Existing Mac files, commits, stashes, credentials and office state remain unchanged. The running Agent Office checkout remains on personal. The owner confirmed all Windows workers were sent home and no Windows work is active. Mac owns recovery; no recovered feature task or VP sweep was started. Both computers remain available. Never activate Windows machine settings from saved history. No default-branch push, merge, deployment, provider login, notification or real database write was performed.

The complete saved source is retained on its original lineage. This is intentionally a held continuation branch: it still contains older versions of overlapping files. Do not merge the whole tree into the target. Port missing coherent feature clusters while preserving later fixes.

## Checks actually run

- Documented `fetch_windows_work.py` plan and apply: expected source commit verified; repository `git fsck --full --no-reflogs` passed.
- Compared source files/history against current GitHub and mapped existing Mac projects by canonical repository identity.
- `Application suites`: SKIPPED: original unfinished source is held for reconciliation, not integrated or certified. Source-object, history and content comparisons completed.

## Remaining work

Review and complete the held reconciliation before application validation. Content overlap paths are listed below; a clean per-file merge alone is not a semantic verification.

Private data, environment configuration and dependencies stay machine-local. Transfer required data separately from Windows using a checksummed private copy and preserve the Mac originals. No code was newly implemented beyond recovery of existing changes. No recovered feature was continued after this report stage.

### Overlapping paths

- `src/client/ui/hud.ts`
- `src/client/world/character.ts`
- `src/client/world/toon.ts`
- `src/server/tasks.ts`
- `src/server/workers.ts`
- `src/shared/protocol.ts`
- `tests/work-kind.test.ts`
- `tests/workers.test.ts`
