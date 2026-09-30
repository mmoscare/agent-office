# Handoff: CleanBot (continued 2026-09-30, branch office/byte-630b, no PR yet)

## Request
The owner asked to continue CleanBot (the earlier WIP, commit 56666e8 from `office/nibble-c2af`, was
cherry-picked here). Two extra requirements: **it must suggest which rows to delete**, and **it must never
delete anything the PR agent still needs**.

## Done so far (all committed and pushed on office/byte-630b)
- `src/server/prune-floor.ts`: the whole-floor sweep behind `agent-office prune --floor` and CleanBot.
  - New verdict `needed` (not discardable). A row is kept when any of these names its branch, its worktree
    seat or its PR number: a live worker's request or task (the PR agent and the VP included), or a queued
    or running queue task. CleanBot's own request never counts. This is read afresh from every floor's
    workers.json and queue.json, and read again right before each deletion.
  - Open PR branches stay kept. The PR board's unshipped work (commits pushed but in no open or merged
    PR, checked with unshipped.ts `missingCommits`) now counts as holding work.
  - Scratchpad worktrees made in a live worker's Claude session (matched by session id) are that
    worker's.
  - Every row gets a suggestion: `delete` (only safe rows nobody pinned), `look` (holds work and idle 7+
    days, for the person to decide) or `keep`. The report has `suggested.{delete,remote,look}`. The text
    table marks 🗑/👀 and prints the exact `office-cleanbot delete …` (or `agent-office prune --floor
    --only …`) command.
  - Bug fixed in the WIP: its git helper trimmed `git status` output, so a half-deleted (stray) folder
    with an edited file came back "safe". It now reads status untrimmed. PR #68's cleanup.ts doesn't
    trim, so it isn't affected.
- The bot: `src/shared/bots.ts` has the `cleanbot` entry (kiosk at x 9.6, z 7.0, west of the meeting room
  door; nav tests pass). His brief is `src/shared/cleanbot-brief.ts` (`station.cleanbot` in prompts.ts,
  editable in Settings). `stations.ts` refuses him `git branch -D`, `git worktree remove`, `git push`,
  `rm` and similar Bash commands.
- `bin/office-cleanbot.js` (list / delete / keep / forget; there is no `--force`, only a per-row
  `--discard`) talks to `src/server/cleanbot.ts`, which serves `/office/cleanbot` in server.ts (CleanBot
  only; `view=office` is open to any worker). It runs one sweep per floor at a time. The floor's
  folders come from the office's view, plus the ⌨ console terminals' folders.
- Deploying him: the generic `{t:'bot.deploy', kind}` message; a CleanBot section in the floor menu
  (`src/client/ui/cleanbot-panel.ts`); a "🧹 Deploy CleanBot" button on the calendar's monthly cleanup
  chore. `office-cleanbot` is added to the board agents' PATH (workers.ts).

## Checks run
- `tsc -p tsconfig.server.json --noEmit` and `tsc -p tsconfig.client.json --noEmit`: both pass.
- `node --import tsx --test tests/nav.test.ts tests/reception.test.ts tests/staffer.test.ts`: 17/17 pass.
- `tests/office-cleanbot.test.ts`: 5/5 pass (command parsing, requests, endpoint, one sweep at a time,
  pins, brief and blocked commands).
- `tests/prune-floor.test.ts` after the trim fix: 4 of 5 pass. In the first test, every verdict and
  suggestion assertion passes, including the stray-with-edit case, and it fails at line 209 only. That
  line expects the printed `office-cleanbot delete …` command to list the names unquoted. The
  scratchpad row's name is an absolute temp path, and `deleteCommands` quotes it (probably a character
  outside `[\w./@:+-]`). Fix the test so it accepts the quoted form, or check each name, then re-run
  (about 4 minutes under load):
  `node --import tsx --test --test-force-exit --test-timeout=600000 tests/prune-floor.test.ts`

## Left to do
1. Re-run tests/prune-floor.test.ts, plus prompts/stations/cleanup/vp tests, then `npm run build`.
2. Take a screenshot of the floor-menu section and kiosk with a UI check (tests/vp-ui.mjs pattern).
3. Open a PR into `personal` with the full handoff, and mention that `office/nibble-c2af` (the original
   WIP) can be cleaned up once this merges.
4. Never run a real delete against a live floor while testing; use list or `--dry-run` only.
