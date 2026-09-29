# Handoff: author's updates through 44aecc1 into personal

## Request and outcome

Bring AgentSystemLabs/agent-office `main` into this fork's personalized app, keep personal customizations, and resolve conflicts. The author's `main` (`44aecc1`, README #144) is merged into `personal`. It is tested and pushed. It is **not running**: the office app folder was not changed and was not restarted.

## What landed

- `main` fast-forwarded from `fff492d` to `upstream/main` `44aecc1` (18 commits past `origin/main` `a8fa16f` / #116). No force-reset.
- Isolation branch `sync/upstream-2026-09-29` was cut from `origin/personal` `153d99e` (this floor's `personal` was 5 commits behind that, clean). Merge commit `4eb300b`.
- Author updates kept: hoop, golf, docs bookshelf, onboarding/setup, leave-on-merge, label filters and editing, terminals that survive SIGTERM, carry-on, remove-floor, top-floor-first elevator, push-to-talk, queue limit counting only its own tasks, customizable prompts and Settings default worker.
- Personal behavior kept: multi-repo `repo` on GitHub messages (including new `gh.labels`), Back Office, plans/inbox/mail/content kanban/unshipped, Office Manual shelf (moved to `src/client/world/manual-shelf.ts` so it does not collide with the author's docs `bookshelf.ts`), Grok blank-model hint and desk memory, work-kind stripe, WIP checkpoint rule, phone/in-tray, Q elevator teleport plus basketball drop.

## Decisions

- Docs bookshelf stays `src/client/world/bookshelf.ts`. Office Manual shelf is `src/client/world/manual-shelf.ts`.
- Hire dialog uses the author's Settings default plus Edit. Edit and drop-on-desk still use per-desk remembered Claude model/effort. Workspace picker stays; the author's simple worktree checkbox does not replace it.
- `office.namer` default text includes `kind`. Receptionist (`station.inbox`) was added to the author's prompt table. Uncustomized board briefs still come from `stations.ts` (plans, mail, inbox, folder floors).
- `gh.labels` / `gh.labeled` include optional `repo` for folder floors.
- Windows shell launch stays without `-l` when `SHELL` is unset. Meeting reminder test accepts `\` paths. Queue worktree-note test expects the personal checkpoint rule after the author's note. Codex Windows hook spawn timeout raised from 3s to 20s so the suite does not fail under parallel load.

## Checks

Run in `C:\Users\Owner\AppData\Local\Temp\opencode\sync-upstream-2026-09-29` on the combined tree:

- `npm ci`: failed first on `tsc` (`prompts.ts` missing `inbox`). Fixed, then `npm run build` passed (client vite + server tsc).
- `npm run typecheck`: passed after the inbox prompt fix.
- `npm test`: full `tests/*.test.ts` run in 12-file batches. Three failures, then fixed and re-run: `handoff.test.ts`, `meetings.test.ts`, `prompts.test.ts`, `codex-windows-hooks.test.ts` — 35 passed, 0 failed. One earlier full-suite failure of the Windows hook test was the 3s spawn timeout under load, not a logic break; it passed alone and after the timeout change.
- `npm run build`: passed after the fixes.
- Not run: live office restart, authenticated model request. Open upstream PRs (#146, #147, #148, #130, #118) were not merged; only `upstream/main`.

## Commits and links

- Author mirror: `44aecc1` on `main`.
- Merge: `4eb300b` on `sync/upstream-2026-09-29`.
- Follow-up on that branch: Receptionist prompt, Windows/checkpoint test fixes, this handoff.
- Upstream: https://github.com/AgentSystemLabs/agent-office
- Fork: https://github.com/mmoscare/agent-office
- Branch: https://github.com/mmoscare/agent-office/tree/sync/upstream-2026-09-29

## Remaining

The running app is `C:\Users\Owner\Documents\Development\Agent-Office\agent-office` on `personal`, still at `9d18e19`, clean, behind `origin/personal`. It was not modified. After workers finish, in that folder only:

```powershell
git status
git fetch origin
git merge --ff-only origin/personal
npm ci
```

Confirm the folder is on `personal`, then restart the office. Do not restart while workers are active. `npm ci` runs the build via `prepare`.
