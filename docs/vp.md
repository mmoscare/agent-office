# The VP

The VP is a bot you deploy on a floor. He sweeps the floor's pull requests, merges the ones that pass, and helps workers who are stuck. He brings the owner only the things that need a decision. There is one VP per floor.

## Deploying him

- **Floor menu** (click the project name in the top-left corner): the **👔 The VP on this floor** section at the bottom has **Deploy the VP**. Or walk up to his kiosk in the lounge, by the meeting room under the boss office, and ask him something.
- He's hired like the board agents: in the floor's main checkout, with no worktree, and without the file-editing tools. His brief (⚙️ Settings → Board agents → 👔 VP's brief) tells him to act only through commands.
- He works with `office-vp`, plus `office-queue`, `office-plans` and `office-inbox`.

## Standing duty

Tick **On duty** in the same section (admins only). The office server then sweeps the floor every 10 minutes by itself. It spends no tokens while nothing changes, and it wakes the VP agent only when there's something to judge or report. The switch is your standing approval for verified merges on that floor. It shows who turned it on and when, and it's kept in `.agent-office/vp.json`. The VP can also run `office-vp duty on|off [--every 10m]` when you ask him to.

## `office-vp`

| Command | What it does |
| --- | --- |
| `office-vp status` | PRs grouped as merged / ready / being worked on / needs a fix / waiting / needs the owner, stuck workers, "N merges waiting for a restart", duty |
| `office-vp sweep [--dry-run]` | One sweep by the rules below (waits up to 8 minutes, then keeps running in the office) |
| `office-vp verify <pr>` / `office-vp merge <pr>` | Verify one PR; merge one whose own verify passed on its current head |
| `office-vp retry <pr>` | Forget a PR's fix, so the next sweep may start one more (after the owner says so) |
| `office-vp workers` | Every worker: status and for how long, task, PR, and the last lines of its terminal |
| `office-vp nudge <worker>` / `office-vp wake <worker> [--say …]` | Type a message into a worker's session / wake one that's asleep ("continue") |
| `office-vp duty on\|off [--every 10m]` | Standing duty |

## The owner's five rules, in code

1. **Skip a PR whose worker is busy** (`workerFor` and `isBusy` in `src/server/vp-sweep.ts`), and skip a PR with a VP fix still under way (`fixOpen`).
2. **Verify, then merge** (`src/server/vp-verify.ts`). `git merge-tree --write-tree` gives the merge result. `git archive` puts it in a short folder under `%TEMP%\aovp`. That folder is not a git worktree and is never linked to the app's `node_modules`. Dependencies come from a cache keyed by `package-lock.json` (`npm ci --ignore-scripts`). For agent-office, the checks are both `tsc --noEmit` runs, the tests related to the changed files, and `npm run build`. Tests use `node --import tsx --test --test-force-exit`, without `tests/console-shell.test.ts`. They run on the base too, so only new failures count. Test output it can't compare test by test (Jest, Vitest, a crash) stays a failure. Other repos use their own `typecheck`/`lint`/`test`/`build` scripts, saved in `.agent-office/vp-recipes.json`. Edit that file and set `"source": "saved"` to change a recipe.
   Right before merging, the VP checks that the PR is still open, that its head is the verified one, and that the base still gives the verified tree (otherwise it verifies again). Then it runs `gh pr merge N --merge --match-head-commit <sha>`, using REST when GraphQL is out, and never `--delete-branch`. Afterwards it posts a record with the head, base and tree SHAs and each check's result and time. The floor checkout is fast-forwarded only when it's clean and on the base branch.
3. **One fix per PR.** Conflicts, unfixed Codex findings, failing CI or a failed verify get one queue task, titled `VP: fix PR #N (…)`, with a complete prompt. If the PR's own worker is idle at its desk, it's asked to fix the PR instead. The fix is recorded in `vp.json` and in a marker comment on the PR, so a restart can't start a second one. The same problem after that fix goes to the owner as a To Do Next item ("VP needs you: …").
4. **Never restart.** Nothing in the VP restarts the office. On the agent-office floor he reports "N merges waiting for a restart": the merges on the base since the running office started.
5. **Easy on the CPU.** Only one verify runs at a time in the whole building. Before each step he waits while the machine is under pressure (CPU at 90% or more over 30 s, or memory at 90% or more). Every step runs at below-normal priority with a timeout, and a step that times out means "not verified", never a merge.

Eligible PRs are open, not drafts, target the repo's base branch (its default branch, `personal` here; never `main` on a fork), and come from an `office/*` branch or from the owner. Anything else is listed and never merged.

**Codex findings** are inline comments from `chatgpt-codex-connector[bot]` with a P0–P3 badge. A finding counts as fixed only when its thread is resolved, or when its lines changed in a later commit and a reply or a later comment on the PR says it was addressed. When unsure, the VP doesn't merge.

## Helping stuck workers

`office-vp workers` classifies each worker (`src/server/vp-workers.ts`):

- **Asleep or stopped by a restart with its task unfinished**: woken and told "continue".
- **Paused**: told "continue". If someone pressed Esc or typed to it recently, it's only reported.
- **GraphQL rate limit, a hung Windows test run, finished with unshipped work**: told the known workaround.
- **A permission or approval prompt**: always the owner's. It becomes a To Do Next item, and the VP never approves it or types into it.
- **A question for 10+ minutes, or 30 minutes of silence**: left for the VP's judgment.

On duty, the office does the safe ones by itself, once per stuck spell, and notes each one on the worker's PR or issue. The VP never kills a worker, sends one home, pushes to a worker's branch, or does a worker's code change himself. Workers are named by seat **and** branch, because names get reused.

## If his merges are blocked

On-duty merges run from the office server's own code, so a Claude Code permission check can't stop them. If the VP agent's own `office-vp merge` is denied, he reports it and never tries another way. To let his commands through, the owner can add this permission rule (only the owner can) in Claude Code's settings for the floor, e.g. `.claude/settings.local.json`:

```json
{ "permissions": { "allow": ["Bash(office-vp:*)"] } }
```

## Reusing this for another bot

`src/shared/bots.ts` is the generic part: name, colour, kiosk, card text, and the first request on deploy. `src/server/stations.ts` briefs bots and launches them without file-editing tools, and `bin/office-<bot>.js` gets written to the board agents' PATH. CleanBot can be added as another entry.
