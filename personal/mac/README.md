# Agent Office on a second machine (the Mac)

The building is not in git. Its floors are listed in the office folder's `.agent-office/floors.json`
with absolute paths, and each floor's checkout keeps its own `.agent-office/` (workers, queue, plans,
whiteboard, worktrees), which git ignores. So cloning the repositories on another machine gives you
the code, but an empty building. `floors-mirror.mjs` carries the building over.

It needs only node (20 or newer) and git, on both machines. It never deletes, overwrites or resets
anything: what is already there is kept and reported.

## 1. On the machine that has the floors: export

```sh
node personal/mac/floors-mirror.mjs export <officeDir> --state
```

`<officeDir>` is the folder the office is started in (the one with `.agent-office/floors.json`).
This writes `<officeDir>/.agent-office/mac-mirror/`:

- `manifest.json`: every floor (id, name, colour, order, Back Office flag) and every git checkout in
  it — the floor itself, or the repositories nested in a workspace floor — with its relative path,
  origin, branch, and how much uncommitted or unpushed work it has.
- `state/<floorId>/…` (with `--state`): the per-floor office files that mean the same thing on
  another machine — the task queue, To Do Next plans, meetings and their notes, jukebox, pictures,
  the dog, the whiteboard, a floor's Content Kanban and the VP's check recipes, and the building's
  todos (with their card pictures), Autonomous Tasks, stickies, notes, chat, arcade scores, the
  ⚙️ Settings prompts and default worker, and the holiday theme.

Not in the bundle, on purpose: workers and their terminal sessions, scrollback, hooks, worker
worktrees and workspaces, the VP's standing duty to merge (`vp.json`: two machines on duty would
both act on the same PRs), the password, spend and timecards. Those belong to the machine.
Origins are recorded without any `user:token@` they carry (clones use the other machine's own git
credentials), and "unpushed" counts the commits no remote-tracking branch has, so a branch with
no upstream or a detached HEAD is counted too. Every `--state` export rebuilds the `state/` folder,
so a file a floor no longer has does not come back on import.

The bundle names your private repositories, so it lives in the git-ignored `.agent-office/` folder.
Keep it out of this public fork. Add `--quick` to skip the slow uncommitted/unpushed counts.

## 2. On the Mac: the app itself

Run this fork's `personal` branch, not the author's installer: local-folder floors and multi-repo
desks are customisations of this fork.

```sh
git clone -b personal https://github.com/mmoscare/agent-office.git ~/Documents/Development/Agent-Office/agent-office
cd ~/Documents/Development/Agent-Office/agent-office
npm ci        # builds too
```

Also install and log in to what the office drives: `gh auth login` (the boards and cloning),
`claude` (Claude Code), and OpenCode or Codex if you use them.

## 3. On the Mac: import

Copy the `mac-mirror` folder to the Mac (AirDrop, a USB stick, rsync over SSH), then:

```sh
node personal/mac/floors-mirror.mjs import ~/mac-mirror --dev-root ~/Documents/Development --state --dry-run
```

- `--dev-root` is the Mac folder that plays the part of `Documents\Development`. Floors that lived
  under it there go under it here, at the same relative paths (spaces and capitals kept).
- Floors the office cloned into `~/agent-office/<owner>/<repo>` go to `--projects` (default
  `~/agent-office`), so the result is an exact mirror. To put one of them somewhere else, say a
  clone that already exists under Development, add `--map <floorId>=<dir>`, for example
  `--map paper-cloud=$HOME/Documents/Development/Paper-Cloud`.
- `--skip <floor>/<path>` leaves a nested checkout out, for scratch release clones you don't want
  again (see the manifest for the paths).
- `--dry-run` prints the plan and changes nothing. Read it, then run the same command without it.

What import does: makes the workspace folders, clones every checkout that has an origin and is not
there yet (on the recorded branch), keeps anything already in place (and complains if it is a
checkout of a different repository), copies the `--state` files where none exist yet (picture and
notes folders file by file, keeping what the Mac already has), backs up any
existing `floors.json`, and writes a new one with the same floors at their Mac paths. Floors that
only exist on the Mac are kept, after the mirrored ones. The report at the end lists what it could
not carry:

- repositories with no remote: copy the whole folder from the other machine, or give them a GitHub
  repository first and export again;
- linked worktrees (`git worktree add`): not recreated;
- uncommitted or unpushed work: it stayed on the other machine until it is committed and pushed.

## 4. Start the office on the Mac

```sh
node bin/agent-office.js ~/Documents/Development/Personal-Portfolio --port 4600 --password 'YOUR-PASSWORD'
```

Give it the same office folder the floors were exported from (mapped to its Mac path). The password
is per machine; nothing about it is carried over. The first start writes hooks and helper scripts
into every floor's `.agent-office/`, and the elevator shows the floors in the same order and colours.
Carried-over queue tasks that were running show as stopped by a restart: requeue them there, but
only once the other machine has stopped working on them. Tasks still waiting in a queue start on
the Mac by themselves, so the two offices would each run them; both work on the same GitHub repos.

The Windows launcher in `personal/windows` does not apply on the Mac; start the office from a
terminal, or wrap the command above in a launch agent if you want it always on.

## Tests

```sh
node --test tests/floors-mirror.test.ts
```

The tests build a small building in a temporary folder (a workspace floor with nested repositories,
a repository with no remote and a linked worktree, plus a single-checkout floor), export it, and
import it elsewhere with local bare repositories standing in for GitHub.
