# Mirror the building to a Mac: floors-mirror

## Outcome

The owner asked how to make the Agent Office floors on a MacBook Pro look exactly like the ones on
the Windows machine, and how to force the Mac's folder structure into the same floor structure.
The Mac has the same GitHub login and most repositories cloned already.

Findings that shaped the answer: the building is not in git. The floor list is
`<office>/.agent-office/floors.json` with absolute Windows paths, and each floor's checkout keeps its
own git-ignored `.agent-office/` (workers, queue, plans, whiteboard, worktrees). Of the nine floors,
only three are single checkouts; six are workspace folders with 24 nested repositories that the
office discovers by walking the folder. Three repositories have no remote at all, two have unpushed
commits, and 19 have uncommitted changes, so GitHub alone cannot reproduce the building.

Delivered: `personal/mac/floors-mirror.mjs`, a dependency-free node tool with `export` (run here)
and `import` (run on the Mac), its tests, a README, a private bundle of this machine's building,
and a handoff document written for the Claude Code agent on the Mac. The tool is done and tested;
the Mac side has not been run, because this session has no access to the Mac.

## Changes and decisions

- `personal/mac/floors-mirror.mjs`: `export [officeDir] [--out] [--dev-root] [--state] [--quick]`
  walks every floor in floors.json (depth 4, skipping hidden folders, node_modules and the like,
  never following links), records each checkout's relative path, origin, branch, head, dirty and
  unpushed counts, marks linked worktrees, classifies each floor's folder relative to
  Documents/Development, the projects folder or the home folder, and writes
  `<office>/.agent-office/mac-mirror/manifest.json`. With `--state` it copies the portable per-floor
  files (queue, plans, meetings, jukebox, decor, dog, todos, chat, whiteboard). Workers, scrollback,
  hooks, worktrees, config.json (password secret and salt) and the spend files are deliberately
  left out: they are machine-local, and copying the Claude budget ledger would carry spend to a
  machine that has not spent it.
  `import <bundle> --dev-root <dir> [--projects] [--office] [--map floorId=dir]... [--skip floor/path]...
  [--no-clone] [--state] [--dry-run]` recreates the folders, clones missing checkouts with plain
  `git clone` on the recorded branch, keeps what is there (and reports a checkout of a different
  repository as a problem instead of touching it), refuses to invent repositories with no remote,
  skips linked worktrees, backs up and rewrites floors.json with the same ids, names, palettes,
  order and Back Office flags at the Mac paths, appends floors that exist only on the Mac, and
  copies state files only where none exist. It never deletes, overwrites or resets anything.
- `--map` exists because the agent-office and paper-cloud floors live in `~/agent-office/mmoscare/`
  here while the owner's Mac alignment guide puts those clones under Development; `--skip` exists
  because that guide says scratch release clones should not be recreated.
- `personal/mac/README.md`: how to export, install the fork's `personal` branch on the Mac, import,
  and start the office. Placed next to the Windows launcher, as the personal-fork convention.
- `tests/floors-mirror.test.ts`: five tests that build a small building in a temporary folder with
  local bare repositories standing in for GitHub.
- The bundle lives at `C:\Users\Owner\Documents\Development\Personal-Portfolio\.agent-office\mac-mirror\`
  and is not committed: the fork is public and the manifest names private repositories.
- The Mac agent's handoff, `MAC-AGENT-OFFICE-HANDOFF.md`, is saved in that bundle folder and next to
  the owner's existing `MAC-DEVELOPMENT-ALIGNMENT.md` in `Documents\Development`. It is also not
  committed, for the same reason.
- Dock: the owner decided it becomes a GitHub-repository floor like paper-cloud and agent-office.
  During this task the owner pushed it to a private repository of its own (branch `main`, clean,
  no unpushed commits); this session created nothing on GitHub. The bundle was exported again
  afterwards, so the manifest records Dock's origin and import clones it like the other
  single-checkout floors.

## Verification

- `node --test --test-reporter=spec tests/floors-mirror.test.ts`: 5 tests, 5 passed (about 25 s).
  Run with Node 24's built-in type stripping; this worktree has no node_modules and the app
  checkout's esbuild binary is missing, so the repo's usual `--import tsx` runner was not used.
- `node personal/mac/floors-mirror.mjs export "C:/Users/Owner/Documents/Development/Personal-Portfolio" --state`
  against the real building, twice (the second time after the owner pushed Dock): exit 0 both times;
  9 floors, 41 checkouts (29 repositories, 12 linked worktrees), 22 state files; the final run lists
  19 repositories with uncommitted work, 2 with unpushed commits and 2 with no remote (both nested
  in the same workspace floor; the private Mac handoff names them).
- `import … --dry-run` of that bundle into a scratch folder with the two `--map` overrides: exit 0,
  26 clones and 6 workspace folders planned, 9 floors in the floors.json to be written, no problems,
  and the scratch folder was not created.
- Not run: a real import on a Mac, `npm run typecheck` (the tool is plain JavaScript and is not part
  of the server or client build), the full test suite, and any live office restart. The app build is
  unaffected: nothing under `src/` changed.

## Actions and references

- Repository: mmoscare/agent-office. Branch: `office/byte-e762`, based on personal at 9d18e19 and
  merged with the current `origin/personal` before pushing. Pull request to `personal`: see the PR
  opened from this branch; its description carries this handoff.
- No GitHub actions other than the pull request. No repositories were created, pushed or changed.
- Files read on this machine but not modified: floors.json, workers.json, queue.json and other office
  state, to establish what is portable.

## Remaining work

- Owner: commit and push the work listed under "stayed behind" if it should reach the Mac (19
  repositories with uncommitted changes, two with unpushed commits). The two no-remote folders need
  copying by hand, or a repository and a push followed by another export.
- Owner: copy the `mac-mirror` folder to the Mac and hand `MAC-AGENT-OFFICE-HANDOFF.md` to the
  Claude Code agent there. The agent runs the import (dry-run first), starts the office and checks
  the elevator.
- Merge the PR into `personal` so the tool is in the fork the Mac clones. Until then the Mac can
  fetch the branch, or copy the two files from the bundle folder's sibling `tool/` copy.
