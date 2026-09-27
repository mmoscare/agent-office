# Your Agent Office workflow

**Make requested app changes on `personal`, the version you run. Keep `main` as a clean copy of the author's code. Merge author updates from `main` into `personal`, preserving your customizations.**

| Name | Plain English |
| --- | --- |
| `personal` | Your live, personalized app. Make and test your requested changes here. |
| `main` | A clean copy of the author's code, used to receive author updates. Keep personal customizations on `personal`. |
| `origin` | Your GitHub fork: `mmoscare/agent-office`. This is where you upload your branch. It is not a branch itself. |
| `upstream` | The author's GitHub repository: `AgentSystemLabs/agent-office`. Their updates come from its `main` branch. |

The update flow is `upstream/main` -> `main` -> `personal`. Push the two branches to your own fork, `origin`. The combined author updates and personal changes run from `personal`.

The app code lives in `C:\Users\Owner\Documents\Development\Agent-Office\agent-office`, on `personal`. The other copy at `C:\Users\Owner\agent-office\mmoscare\agent-office` is on `main`; a chat opened there should use the app code folder for customization requests. A separate `dev` branch is not part of this workflow.

## Everyday use

Open the local Agent Office app and work on your Personal-Portfolio floor as usual. The app runs the built code from this local clone. Your portfolio repositories keep their own Git histories.

To start the office, replace `YOUR-PASSWORD` with your chosen password:

```powershell
agent-office.cmd "C:\Users\Owner\Documents\Development\Personal-Portfolio" --agent "C:/Users/Owner/.local/bin/claude.exe" --password 'YOUR-PASSWORD'
```

Open http://localhost:4600. Keep that PowerShell window open. Ctrl+C stops the office.

For Claude, Codex, Grok, and model/effort controls, see [AGENT-SETUP.md](AGENT-SETUP.md).

## Customize Agent Office

Open this code folder in your editor or coding agent:

```text
C:\Users\Owner\Documents\Development\Agent-Office\agent-office
```

Work on `personal`. The interface is mainly in `src/client`; server behavior is in `src/server`.

Ask your agent to make the change, test it, rebuild the app, and save a commit. A commit is a saved checkpoint on your PC. A push uploads those checkpoints to your fork:

```powershell
git push origin personal
```

You do not merge into `origin`. You push your `personal` branch to it. Restart the app after rebuilding to use code changes.

## Bring in the author's updates

1. Save your existing work in commits and push it to your fork.
2. Stop Agent Office with Ctrl+C.
3. Open PowerShell in the Agent Office code folder above.
4. Run each command separately. Stop if any command reports an error.

```powershell
git switch personal
git status
```

Continue only when Git says the working tree is clean. Then:

```powershell
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch personal
git merge --no-edit main
```

Fetch downloads the author's changes. The fast-forward updates `main` without adding personal commits. Merging `main` into `personal` combines the author's changes with your custom version. If the fast-forward fails, stop and investigate; do not force-reset either branch. Before starting the app again, confirm the code folder is back on `personal`.

If the merge finishes successfully, rebuild and test before uploading:

```powershell
npm ci
npm test
git push origin main
git push origin personal
```

In this project, `npm ci` also triggers the build. Continue only after each command succeeds. Check your customized features in the app too. If checks fail, have your agent investigate before treating the update as ready. Restart the office to run the combined version.

## If there is a conflict

A conflict means both versions changed the same area. Git pauses for a decision.

Tell your coding agent:

> Resolve this update while keeping my custom behavior and the author's improvements. Compare both versions, explain any decision you need from me, and test the result.

Your agent should edit the affected files, stage the resolutions, and commit the completed merge. For the `main`-into-`personal` merge, current/ours means your personal version; incoming/theirs means the author's version on `main`.

To cancel an unfinished merge:

```powershell
git merge --abort
```

Because you started with your work committed, this returns the code to its pre-merge state. This command applies while the merge is still unfinished; it does not undo an already completed merge.

## Local Windows fix

Agent Office's command lookup was updated to find Windows programs, including your existing Claude, Codex, and OpenCode installations. The small `src/server/windows-command.ts` helper handles native `.exe` files and npm `.cmd` launchers, including OpenCode's model list. A Windows command override in `src/server/codex.ts` fixes Codex's activity hooks. Keep these fixes when merging future updates unless the author has supplied equivalent fixes.

The focused regression tests are:

```powershell
node --import tsx --test tests/command-resolution.test.ts tests/windows-command.test.ts tests/agents.test.ts tests/models.test.ts tests/codex.test.ts tests/codex-windows-hooks.test.ts
```
