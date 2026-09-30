# Handoff: is there a CleanBot? (status check, 2026-09-30)

## Request and outcome
The owner asked whether the repo has a "CleanBot", what it does and where it is. This was a question
only: **no app code was changed.** This note records the answer for whoever picks CleanBot up again.

## Answer
CleanBot is **not shipped**. It exists only as unfinished work that nobody is working on.

- **What it's meant to be:** a bot the owner deploys on a floor with a preloaded brief. It removes the
  leftover `office/*` branches and worktrees the office created, and lets the owner choose which ones
  to keep. Plan item: "CleanBot: a bot with a preloaded prompt I can deploy on any floor…"
  (`.agent-office/plans.json`, still marked `progress`, task `bd46b2f157de`).
- **Where it is:** branch `office/nibble-c2af` (pushed to origin, no PR). Its worktree is
  `.agent-office/worktrees/nibble-c2af`, clean with nothing unpushed. The branch has one WIP commit,
  `56666e8`, plus a merge of `office/sprocket-c213` (PR #68, already in `personal`).
- **What the WIP contains:**
  - `src/server/prune-floor.ts` (about 1,250 lines): `agent-office prune --floor`. It covers every
    repo on a floor: `office/*` branches, worktrees under `.agent-office/worktrees` (including strays),
    multi-repo desk worktrees under `.agent-office/workspaces`, and Claude scratchpad worktrees.
    Each row gets a verdict: safe, holds work, open PR, live worker's, recently active, just made,
    protected, or couldn't check. Nothing is deleted unless it's named with `--only`, and each named
    row is checked again right before it goes. It uses the same `cleanup-keep.json` pins as the
    cleanup screen and writes a `cleanup-log.jsonl`. Flags: `--json`, `--repo`, `--only`, `--keep`,
    `--discard`, `--remote`, `--always-keep`, `--forget-keep`, `--recent`, `--no-fetch`, `--dry-run`.
  - `src/server/prune.ts`: a small hook that sends those flags to `prune-floor.ts`. Upstream's plain
    `agent-office prune` stays unchanged.
- **Missing pieces:** the bot itself. The code refers to a `cleanbot.ts` that doesn't exist: there's no
  brief, deploy button, `office-cleanbot` command or tests for `prune-floor.ts`, and no PR.
- **Queue:** task `bd46b2f157de` is no longer in `.agent-office/queue.json`. No live worker in
  `workers.json` is on `office/nibble-c2af`.

## What exists today instead
- `agent-office prune [dir] --dry-run`: upstream's safe cleanup for one repo.
- The 🧹 cleanup screen (PR #68, `src/server/cleanup.ts`, `src/client/ui/cleanup.ts`), opened from
  the Git board and the calendar's monthly cleanup chore.

## Next steps (if the owner wants CleanBot finished)
1. Merge the latest `origin/personal` into `office/nibble-c2af`. `personal` has moved a long way since
   2026-09-28.
2. Build the bot on the VP's generic mechanism from PR #86. `src/shared/bots.ts` holds each bot's name,
   colour, spot, card text and first deploy request. Bots are hired like the board agents and don't get
   Edit/Write. `bin/office-<bot>.js` goes on their PATH. Add a CleanBot entry, a brief, and an
   `office-cleanbot` command (or `agent-office prune --floor --json`).
3. Add tests for `prune-floor.ts` using fixture repos (see `tests/cleanup.test.ts`). Cover the known
   gaps in prune's safety checks: gitignored files, terminals missing from workers.json, the gap at hire
   time, stale fetches, and desk worktrees.
4. Open a PR against `personal`.

## Checks run
Read-only only: `git branch -a --contains 56666e8`, `git log origin/personal..origin/office/nibble-c2af`,
`git -C <nibble-c2af worktree> status`, `gh pr list --search "cleanbot OR prune"` (no CleanBot PR),
`gh pr view 86`, and reads of `.agent-office/{queue,plans,workers}.json`. No tests were run, since
nothing changed.

## Branch / links
- This note: branch `office/byte-630b`, no PR.
- CleanBot WIP: `office/nibble-c2af` @ `39e4b31` (WIP commit `56666e8`).
- Related: PR #68 (cleanup screen), PR #86 (the VP and `bots.ts`).
