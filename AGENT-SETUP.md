# Your agents in Agent Office

## Open the app

Double-click **Agent Office** on your Desktop, or search for it in Start. Right-click its Start entry and choose **Pin to Start** if you want it pinned.

The shortcut opens your personal version and the building containing Personal-Portfolio and MFT-Trading-Dashboard. If the old PowerShell copy is running, let its workers finish and press Ctrl+C once before using the shortcut. The launcher may ask for your usual office password once, then remembers it encrypted for your Windows account.

The icon near the Windows clock has **Open**, **Restart**, and **Stop** options. Closing the browser leaves the office running. More details: [Windows launcher](personal/windows/README.md).

## Start using the Windows fix

The fix is already built in your local personal version. You do not need to reinstall Claude or Codex.

1. Let any active workers finish.
2. In the PowerShell window running Agent Office, press Ctrl+C once.
3. Run your usual Agent Office command again:

```powershell
agent-office.cmd "C:\Users\Owner\Documents\Development\Personal-Portfolio" --password 'YOUR-PASSWORD'
```

Use your chosen password in place of `YOUR-PASSWORD`. Open http://localhost:4600, then hire a Codex worker to try it. A browser refresh alone does not restart the server.

The old Windows launcher could report "file not found" or "exited with code 193" even with the agent installed. The fix finds Windows commands and starts the real program behind npm's launcher.

## Your floors

Your building now contains **Personal-Portfolio** and **MFT-Trading-Dashboard**, using their existing folders under `C:\Users\Owner\Documents\Development`.

Keep starting Agent Office with the Personal-Portfolio command above: that folder holds this building's settings and floor list. After restarting, click the project name at the top left and select the floor you want. You can also walk into the elevator and press **E**.

To add another folder:

1. Click the project name at the top left, then **Add a project**.
2. Leave **Local folder** selected.
3. Paste the full folder path, or click **Browse folders**.
4. Click **Open folder**.

It opens in place immediately and stays in your floor list. A parent folder containing both frontend and backend repositories can be one floor. Opening the same folder again takes you to its existing floor.

The **Clone from GitHub** tab still lets you clone a repository when you want to.

## One worker across frontend and backend

Keep **Personal-Portfolio** as one floor. You can give a worker separate working copies of both repositories:

1. Go to an **empty desk** and press **E** to hire.
2. Click **Choose starting branch…**, or check **Work in separate git worktrees & branches**.
3. Select **investments-frontend** and **investments-backend**.
4. Use **Start from** beside each repository to choose its starting branch, such as `main` or `personal`. Leave **Current checkout** selected to use the branch already open in that folder.
5. Optionally enter a **new branch name**, such as `feature/login`. This names the worker's task branch. Leave it blank for an automatic name.
6. Give the worker its task and click **Hire & start**.

One worker now starts in a workspace containing both repositories. Each has its own worktree and branch. The worker gets instructions to edit those copies and test them together. Your original folders keep their current branches and unfinished edits.

Worktrees start from the selected branch's committed code. **Start from** lists local branches and remote branches already fetched to this computer; it does not download updates. Uncommitted edits and ignored files such as `.env` and `node_modules` are not copied. The worker may need to install dependencies or configure the app in its copies. The new task branch name must be new in every selected repository.

The quick branch button turns on separate worktrees so it can use your chosen starting branches while keeping other agents' original folders unchanged. Leaving worktrees off works directly in each original folder on its current branch. **Add repositories** offers the same starting-branch choice for each extra repository.

At that worker's desk, press **C** or **O**, or click **Changes** in its terminal. Its workspace window lists every repository:

- **Changes & commits** shows and commits changes in that repository only.
- **Push & open PR** opens a separate pull request for that repository. Commit its changes first.
- **Review PR** opens GitHub, where you review and merge when ready. Matching PR numbers in different repos are separate PRs.
- **Add repositories** creates another worktree for the same worker. Wait for its current task to finish first. It keeps its existing worktrees and receives updated instructions.

For a conflict, tell the worker which repository and PR to fix. Ask it to merge the latest base branch into that repository's worktree, resolve the conflict, and test both apps together. Review the result before merging the PR. Conflicts are not silently resolved or merged.

When sending the worker home, the app checks **all** its repositories. **Keep everything** preserves unfinished work. The other choices remove its worktrees, or both its worktrees and branches; the dialog shows uncommitted changes and unpushed commits before you choose. Small workspace instructions and any notes beside the repositories remain in `.agent-office/workspaces/`.

Existing workers keep their current folders. Hire a new worker to use this setup. The task queue and board agents keep their existing behavior; use the empty-desk hire form for this workflow. After merging on GitHub, update your original local repositories when their ongoing work is saved.

The workspace selection, instructions, repository branches and PR links survive an office restart. Restart **Agent Office** from its tray menu after current workers finish to load this feature, then refresh the browser.

## Terminal keys

**Test changes** is available in the agent terminal, workspace window, and Changes window. Click it after the agent finishes a task. It asks that same agent to test all repositories and worktrees involved, including how they work together, fix failures caused by its changes, and report what passed, failed, or could not be checked. Results appear in the terminal. It does not commit, push, or merge. The button waits while the agent is busy or needs an answer from you.

**Esc goes to the agent**, so you can cancel a response or leave its menus. Click **X** at the top right to leave the terminal view. Closing that view does not stop the agent.

## Usage and cost

Click **Usage & cost** under the worker list or inside an agent terminal. It shows saved usage across all floors, including workers that have left. Click a record for input, output, reasoning, and cache tokens. You can filter by provider and download a CSV.

- Claude: token counts and the app's USD cost estimates.
- Codex: root-session tokens; subagent usage and dollar costs are not supplied.
- OpenCode, including Grok: tokens and costs when the provider reports them.

Dollar figures are **API-value estimates**: roughly what those tokens would cost at API prices. On a subscription, they are not extra charges and do not measure your remaining plan allowance. Use the provider's plan usage and reset times for that. Agent Office does not read your billing invoice. Unknown cost is shown as unavailable. Totals cover a worker/session; if you switch models in its terminal, those tokens stay in the same total. An OpenCode model selected when hiring is labelled as the initial model.

History starts with sessions the office can still track; it cannot recover workers already removed before this feature. History is saved in the building's `.agent-office/model-usage.json`. The existing daily budget feature still covers Claude only.

## API balances

The **API balances** panel on the right shows your pay-as-you-go API accounts: Anthropic, OpenAI and xAI (Grok). It is about API credit, not a subscription plan; the Claude plan's 5-hour and weekly limits stay in their own panel. Click ⚙ in the panel heading to paste keys. Only an admin can change them; they are saved on the office server in the building's `.agent-office/api-balances.json` and are never sent to the browser.

- **xAI** reports the team's remaining prepaid credit itself. Paste a Management API key (xAI Console → Settings → Management keys) and the team id, the UUID in the console URL after `/team/`. The panel shows `balance $12.34`.
- **Anthropic** and **OpenAI** have no balance endpoint. Their admin APIs report spend per day, so the panel shows `spent this month` from an Admin key (Anthropic: `sk-ant-admin…` from Claude Console → Settings → Admin keys, which needs an organization; OpenAI: `sk-admin-…` from Organization settings → Admin keys). Ordinary API keys are refused. Type the balance the console shows in ⚙ and the panel shows `≈ balance est.`: that figure minus what the provider has reported since. Reports lag about five minutes, and the console is the truth.

Keys can also come from the environment when the office starts: `AGENT_OFFICE_ANTHROPIC_ADMIN_KEY`, `AGENT_OFFICE_OPENAI_ADMIN_KEY`, `AGENT_OFFICE_XAI_MANAGEMENT_KEY` and `AGENT_OFFICE_XAI_TEAM_ID`. An environment key wins and can't be changed from the office. Providers are asked every five minutes; clicking the panel asks again (at most once a minute). Hide or show the panel from the ☰ menu.

## Your two Codex accounts

The normal Codex login is shared across directories and floors. To change it, finish active work, run `codex.cmd logout` then `codex.cmd login`, choose the other account in the browser, and restart your Codex workers.

Two accounts can run side by side when each process has a different `CODEX_HOME` with its own saved login. Agent Office currently does not have a per-worker account selector. Changing floors alone does not switch accounts.

## Add Grok once

OpenCode is already installed. It runs Grok inside the existing OpenCode worker option.

In a separate PowerShell window, run:

```powershell
opencode.cmd auth login --provider xai
```

Choose the API key login method and enter your xAI API key there. Get a key from https://console.x.ai if needed. Keep the key out of chat and repository files.

`opencode.cmd auth list` should then list **xAI**.

Then hire an **OpenCode** worker in Agent Office, or queue a task for OpenCode, and leave its model field blank: it runs Grok's top model. The field's placeholder names it (`Default: xai/grok-4.7`), and the badge over the worker's head, its task card and its queue row show the model it launched with.

**How the default is chosen.** Grok 4.7 (`xai/grok-4.7`) is xAI's flagship as of September 28, 2026; xAI's model list (https://docs.x.ai/docs/models) calls it "the most capable model we've built" and recommends it for code. The office doesn't hard-wire that: each time it reads the OpenCode model catalogue (at start-up, when a model field loads its suggestions, and at most hourly on a launch), it takes the plain `xai/grok-<version>` ID with the highest version. Fast, mini, reasoning/non-reasoning, multi-agent, `grok-build`, imagine, `-latest` and dated snapshot IDs are never picked, and versions compare as decimals because xAI released 4.20 before 4.3. A new plain Grok release is picked up without a code change. When the catalogue can't be read, the fixed `xai/grok-4.7` is used. The rule and that fallback live in `src/server/grok-default.ts`.

**How to override it.** Type or pick any `provider/model` in the model field for that task or hire. If the office itself runs OpenCode (`--agent opencode`), a `--model` in `--agent-args` replaces the Grok default office-wide. `/models` inside an OpenCode worker's terminal switches that session. A resumed worker carries on its OpenCode session and model; only a fresh start picks the default again. Tasks the queue agent adds with `office-queue add` have no model of their own, so they get the default when they run on OpenCode. Your global OpenCode config (`opencode.jsonc`) is never changed.

You can list the available IDs with:

```powershell
opencode.cmd models xai
```

If the model suggestions have not refreshed yet, paste the model ID from that list into the model field. xAI API usage is billed through your xAI account.

## Change model or effort while working

Yes: click inside that worker's terminal, then type the command and press Enter.

| Worker | What to type |
| --- | --- |
| Claude Code | `/model` to choose a model. `/effort` to choose effort. |
| Codex | `/model` to choose a model and its available reasoning effort. `/status` to check the current setup. |
| Grok through OpenCode | Starts on the top Grok model (`xai/grok-4.7` today) unless the task or hire named another. `/models` to choose the model. Reasoning controls depend on the model and OpenCode's supported variants. |

These controls belong to the agent program. Some choices also save defaults for future sessions. In Claude's model picker, press `s` instead of Enter if you only want to change this session.

For Codex's activity tracking in the game, review the Office hooks using `/hooks` in Codex.

Hooks are the small callbacks that tell the game whether a worker is working, waiting, or finished. A Windows fix now supplies a correctly formatted command for them. After rebuilding, restart Agent Office to replace the commands held by running workers. If Codex asks you to review the updated hook definitions, use `/hooks`; old error messages may remain in the terminal history.

## What was checked

On September 27, 2026, the server build and 17 focused tests passed. Claude, Codex, and OpenCode each returned their version and exit code 0 through Agent Office's terminal host. All seven Codex hook events reached a local test receiver through Windows shell commands, and installed Codex recognized all seven Windows overrides without configuration errors. These are startup and callback checks, not a completed AI task. OpenCode had no saved provider credentials, so a Grok request has not been tested.

On September 28, 2026, with xAI logged in, a temporary office built from the Grok-default change queued an OpenCode task with a blank model. The worker launched as `opencode --model xai/grok-4.7`, its screen showed "Build · Grok 4.7 xAI", and a completed xAI reply came back (OpenCode recorded provider `xai`, model `grok-4.7`, finish `stop`). That run bypassed the `opencode.cmd` start-up bug by putting OpenCode's platform binary first on PATH; the start-up fix itself is separate work.

The folder picker and usage history also passed type checking, a full app build, and 13 focused tests. A temporary-office browser check covered folder browsing, adding and reusing a floor, switching to GitHub mode, saved usage and CSV export, Esc reaching the terminal, clicking X to close the view, and the Windows host starting and stopping. Desktop and Start shortcuts were verified to target the personal checkout. No real AI tasks were started for those checks.

The Windows launcher fix lives mainly in `src/server/windows-command.ts`; Codex's Windows hook command is in `src/server/codex.ts`. Keep these when merging author updates unless upstream supplies equivalent fixes. Your general fork/update instructions are in [PERSONAL-WORKFLOW.md](PERSONAL-WORKFLOW.md).

Local folder handling lives in `local-folders.ts` and `ui/local-floor.ts`. Saved usage is a separate `model-usage.ts` feature; it leaves the author's daily budget ledger unchanged. The OpenCode Grok default is `grok-default.ts`, hooked in by one line in `workers.ts` `launch()` and the model endpoint in `server.ts`. The launcher source stays in `personal/windows`. Keep these small additions when merging updates.

Multi-repository workspaces live mainly in `src/server/workspaces.ts`, `workspace-changes.ts`, and the client workspace dialogs. The author's ordinary single-repository worktree helper remains in place. Focused Git tests cover separate branches/PRs, rollback, adding repositories, resume, changes/commits and cleanup. A temporary-office browser test covers the complete flow with a fake Codex CLI; it makes no real AI requests or GitHub writes.

Official references: [Claude model and effort](https://code.claude.com/docs/en/model-config), [Codex terminal commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [OpenCode providers](https://opencode.ai/docs/providers/), [OpenCode CLI](https://opencode.ai/docs/cli/).
