# CleanBot #96 — Mac integration continuation, 2026-10-05

Michael confirmed Mac owns recovery and Windows automation is stopped. Read all #96 description/comments/reviews and repository handoffs. Preserved Windows fix 79c9a24, and merged the latest #98/#99 recovery changes (including Windows EOF handling and targeted prompt-kind persistence). The running personal checkout remains untouched at this checkpoint.

Added conservative protection when a console current directory cannot be verified. Windows command submission invalidates the previous prompt directory until a new OSC prompt arrives; failed Mac/Linux probes likewise block worktree deletion, including explicit discard. Windows' exact repository selectors, every changed/untracked stray path, and live cwd probes remain intact. Fixed the same empty-stdin EPIPE/EOF race in CleanBot's own Git helper. Nonempty input errors still fail closed. No real cleanup was executed.

Checks: focused native `node --import tsx --test tests/prune-floor.test.ts tests/office-cleanbot.test.ts tests/console-shell.test.ts` 18 passed. `npm run typecheck` passed. Combined full native Mac suite: 809 total, 802 passed, 7 platform/fixture skips, 0 failed (46.3 seconds), recorded by /private/tmp/mac_integration_checks.py office-cleanbot. An initial sandboxed broad run exposed CleanBot's pipe bug and a sandboxed PTY restore failure; the pipe bug was fixed, and the native run passed including worker restore. Build validation and exact CI/merge receipts are appended to #96; source refs are retained.

The alternative Mac-only safety implementation is retained locally at 86d8b12 on integration/cleanbot-review, with its checkpoint handoff, rather than discarded or applied over the newer Windows work. This final branch combines the more precise Windows tracking with the missing fail-closed guard.

Existing thread: https://github.com/mmoscare/agent-office/pull/96 . No private data or dependencies committed. No Windows backup touched. Remaining at this commit: exact-head CI/review/merge and controlled Mac update; no overlapping VP/recorder/ingest/notification duty.

PR #100 review follow-up: SideShells now exposes an optional observer for all PTY output, separate from attached-viewer broadcasting. Console cwd parsing uses it, and reattachment retains any partial OSC tail. A native detached-shell regression checks delayed OSC delivery without browser broadcast. This resolves the review's Windows detached-view availability issue while retaining conservative unknown-location protection.

Late Windows worker 78c9d4f was discovered before the final push. Its equivalent raw-output observer implementation and Windows tests are retained, alongside the Mac delayed-OSC native regression. Both histories are merged without force push. The earlier 36124b1 receipt referred to the local tested commit; this merged commit is the published continuation.
