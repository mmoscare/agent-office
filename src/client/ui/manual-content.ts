// What the Office Manual says (ui/manual.ts). One chapter per topic; add a chapter by adding an entry.
// In text, `code` and **bold** are formatted.

export type ManualBlock =
  | { p: string }
  | { h: string }
  | { list: string[] }
  | { steps: string[] }
  | { table: { head: string[]; rows: string[][] } }
  | { note: string }
  /** Tick boxes: a to-do list to work through. */
  | { checklist: string[] }
  /** A command to paste, with a Copy button. `{PR}` becomes the number typed into the page's PR box. */
  | { code: string; dir?: string }
  /** The box that fills `{PR}` into the page's commands. */
  | { prNumber: true };

export interface ManualChapter {
  id: string;
  icon: string;
  title: string;
  blocks: ManualBlock[];
}

/** The folder the office runs from (see “The three copies of agent-office”). */
const APP_DIR = 'C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office';

export const MANUAL: ManualChapter[] = [
  {
    id: 'about',
    icon: '📘',
    title: 'About this manual',
    blocks: [
      { p: 'This book lives on the shelf in the 👑 Boss Office on every floor. Each chapter explains one part of how your office works. Pick a chapter on the left, or turn the pages with the buttons at the bottom (or ← and →). You can also open it from anywhere with ☰ → **Manual**.' },
      { h: 'Merged a PR? How to try it out' },
      {
        steps: [
          'Merge the PR on GitHub (into `personal`).',
          'Wait until your workers are idle. Restarting stops them.',
          'In the app folder `' + APP_DIR + '`: `git pull`',
          'Only if the pull changed `package.json` or `package-lock.json`: `npm ci`',
          '`npm run build`. The office runs the built code, so without this you’d still see the old version.',
          'Restart the office: tray icon near the clock → **Restart Agent Office**, or Ctrl+C in its PowerShell window and start it again.',
          'Open http://localhost:4600, press **Ctrl+F5**, and try it. Tell any worker that was busy: “continue”.',
        ],
      },
      { note: 'Steps 3–7 are only for agent-office PRs; for other floors just ⬇️ Pull on the Git board. For the full version, see **📝 To-do list** and **📋 Merging an agent-office PR, step by step**.' },
    ],
  },
  {
    id: 'todo',
    icon: '📝',
    title: 'To-do list: after you merge a PR',
    blocks: [
      { p: 'Tick these off as you go. The “why” is in the next chapters.' },
      { h: 'Every merged PR, on any floor' },
      { checklist: ['On that floor: Git board → the repository → **⬇️ Pull**'] },
      { p: 'That’s all, **unless the PR changed Agent Office itself** (an agent-office PR). Then also:' },
      { h: 'Only for agent-office PRs' },
      {
        checklist: [
          'Wait until your workers are idle or waiting on you',
          'In the app folder `C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office`: `git pull`',
          'Only if the pull changed `package.json` or `package-lock.json`: `npm ci`',
          '`npm run build`',
          'Restart the office: tray icon near the clock → **Restart Agent Office**, or Ctrl+C in its window and start it again',
          'Open http://localhost:4600 and press **Ctrl+F5**',
          'Tell each worker that was busy: “continue”',
        ],
      },
      { h: 'Do I need npm run build every time?' },
      {
        list: [
          '**No.** Only when the Agent Office code in the **app folder** changed: after you pull an agent-office PR there, or after someone edits that folder directly.',
          '**Not** after merges in your other projects (Personal-Portfolio, MFT-Trading-Dashboard, …). They aren’t the office’s code.',
          '**Not** after ⬇️ Pull on the Git board. That updates a floor, not the running office.',
          'A build only takes effect after a restart.',
        ],
      },
    ],
  },
  {
    id: 'merge-steps',
    icon: '📋',
    title: 'Merging an agent-office PR, step by step',
    blocks: [
      { p: 'Copy each command into PowerShell. Type the PR’s number here first and every command below uses it.' },
      { prNumber: true },
      { h: '1. Look at the PR' },
      { p: 'Opens it in your browser. Read the description and the “Files changed” tab.' },
      { code: 'gh pr view {PR} --repo mmoscare/agent-office --web' },
      { h: '2. Merge it' },
      { p: 'Your fork only allows merge commits, so this is the right kind.' },
      { code: 'gh pr merge {PR} --repo mmoscare/agent-office --merge' },
      { h: '3. Update the floor' },
      { p: 'In the office: Git board → **agent-office** → **⬇️ Pull**. Or:' },
      { code: 'git -C "C:\\Users\\Owner\\agent-office\\mmoscare\\agent-office" pull --ff-only' },
      { h: '4. Go to the app folder and check it’s clean' },
      { p: 'It should say “nothing to commit”.' },
      { code: 'cd "C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office"\ngit status' },
      { h: '5. Pull the new code into the app' },
      { code: 'git pull', dir: APP_DIR },
      { p: 'If it says **CONFLICT**, see “If step 5 says CONFLICT” below, then come back to step 6.' },
      { h: '6. Check the pull worked' },
      { p: 'The first line must **not** say “behind”.' },
      { code: 'git status -sb', dir: APP_DIR },
      { h: '7. Build' },
      { p: 'Only if the pull changed `package.json` or `package-lock.json`, first run `npm ci` in the same folder. Then:' },
      { code: 'npm run build', dir: APP_DIR },
      { h: '8. Restart the office' },
      { p: 'Wait until your workers are idle. If the office runs from the tray icon near the clock: right-click it → **Restart Agent Office**. If it runs in a PowerShell window: press **Ctrl+C** there, then start it again with your password in place of YOUR-PASSWORD:' },
      { code: 'agent-office.cmd "C:\\Users\\Owner\\Documents\\Development\\Personal-Portfolio" --agent "C:/Users/Owner/.local/bin/claude.exe" --password \'YOUR-PASSWORD\'' },
      { h: '9. Back in' },
      { p: 'Open http://localhost:4600, press **Ctrl+F5** so the browser loads the new build, and tell any worker that was busy: “continue”.' },
      { h: 'If step 5 says CONFLICT' },
      { p: '**The easy way:** undo the pull, then ask any Claude session to “update the app folder”.' },
      { code: 'git merge --abort', dir: APP_DIR },
      { p: '**Fixing it yourself:**' },
      {
        steps: [
          'Open each file the message named and search for `<<<<<<<`.',
          'Turn the two versions into **one line that has both** items, and delete the `<<<<<<<`, `=======` and `>>>>>>>` lines.',
          'Then run the command below, and carry on from step 6.',
        ],
      },
      { code: 'git add .\ngit commit --no-edit', dir: APP_DIR },
      { note: 'A PR on one of your other floors (Personal-Portfolio, MFT-Trading-Dashboard, …) only needs steps 1–3: use that repository’s owner/name in place of `mmoscare/agent-office`, and pull that floor’s repository on the Git board. No build and no restart.' },
    ],
  },
  {
    id: 'git-flow',
    icon: '🔁',
    title: 'How work gets to GitHub and back',
    blocks: [
      { p: 'Every change a worker makes travels the same loop:' },
      {
        steps: [
          'A worker gets its own **desk**: a separate copy of the repository (a worktree) on its own branch, like `office/byte-e3f3`. It starts from whatever your **local floor copy** has at that moment.',
          'It commits, pushes that branch, and opens a **pull request** into `personal` (for agent-office) or `main` (most other repositories).',
          'You **merge the PR on GitHub**. Only GitHub’s copy of the branch changes.',
          'You **pull** to bring it down to your PC. Nothing does this automatically.',
        ],
      },
      { h: 'The three copies of agent-office' },
      {
        table: {
          head: ['Folder', 'What happens there'],
          rows: [
            ['`C:\\Users\\Owner\\agent-office\\mmoscare\\agent-office` (the **floor**)', 'Sits on `personal`. Nobody edits it directly. New workers’ desks start from it.'],
            ['`…\\.agent-office\\worktrees\\*` and `…\\workspaces\\*` (the **desks**)', 'Each worker’s own copy and branch. Their commits reach `personal` only when you merge their PR on GitHub.'],
            ['`C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office` (the **running app**)', 'The code the office itself runs from. A separate copy that needs its own pull, build and restart.'],
          ],
        },
      },
      { p: 'Your other floors (Personal-Portfolio, MFT-Trading-Dashboard and the rest) have just the floor copy and the desks. There’s no separate app copy for them.' },
      { h: 'Reading ↓ and ↑' },
      {
        list: [
          '**↓5 to pull**: GitHub has 5 commits your folder doesn’t. Usually these are PRs you merged on GitHub.',
          '**↑2 to push**: your folder has 2 commits GitHub doesn’t.',
          '**N uncommitted**: edits in the folder that aren’t in any commit yet.',
          '“↓5 to pull” with “nothing to push” only means GitHub has newer work. Nothing on your PC is lost.',
        ],
      },
      { h: 'Easy to miss' },
      {
        list: [
          '**Pull the floor after merging.** New workers start from your local copy. If it’s behind, they build on old code and their PRs conflict more.',
          '**Work done outside a worker skips the loop.** When you or a chat session edit a folder directly, that work exists only on your PC until someone commits and pushes it. That’s what the “uncommitted” and “↑ to push” numbers show.',
          '**Desks stay after a merge.** A worker’s worktree and branch remain until you send the worker home. `agent-office prune` clears leftovers.',
        ],
      },
    ],
  },
  {
    id: 'after-merge',
    icon: '✅',
    title: 'After you merge a pull request',
    blocks: [
      {
        steps: [
          '**Floor:** Git board → the repository → **⬇️ Pull**. New workers then start from the latest code.',
          '**App**, only if the PR changed Agent Office itself: in `C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office`, run `git pull`, then `npm run build` (building turns the code into what the office runs). If that folder has uncommitted work in it, commit or finish that first.',
          '**Restart the office** when your workers are idle (see “Restarting the office”).',
        ],
      },
      { note: 'Merging on GitHub never updates the running office by itself. If a new feature doesn’t show up, the app copy hasn’t been pulled, built and restarted yet.' },
    ],
  },
  {
    id: 'git-board',
    icon: '🌿',
    title: 'The Git board',
    blocks: [
      { p: 'The **🌿 Show Git** switch above the PR board on the wall turns the board over to Git. Aim at it and click, or press E. Then press E at the board to open it. You can also use the **🌿 Git** button in the PR window, or ☰ → **Git repositories**.' },
      {
        list: [
          'The front shows **every Git repository on the floor** (just the floor itself when it is one repository), each with its branch, ↑/↓ against GitHub and its uncommitted files.',
          'Open a repository for its **branches** (● marks the one checked out) and its files: **Staged changes**, **Changes**, **Different from GitHub**, **Commits not on GitHub** and **On GitHub, not here**. Click a file to see its diff.',
          'Click another branch to look at it. That’s read-only: it isn’t checked out.',
          '**⬇️ Fetch** updates what the board knows about GitHub. It also fetches by itself when that’s more than 5 minutes old.',
        ],
      },
      { h: 'Buttons (on the checked-out branch)' },
      {
        table: {
          head: ['Button', 'What it does'],
          rows: [
            ['➕ **git add .**', 'Stages every change, new files too. The + and − on a file stage or unstage just that one.'],
            ['✅ **Commit…**', 'Commits what’s staged, with your message. With nothing staged, it stages everything first.'],
            ['⬇️ **Pull**', 'Brings GitHub’s commits down, only when that’s a plain fast-forward.'],
            ['⬆️ **Push** / **Publish branch**', 'Pushes the branch to GitHub (`origin`). Never forced. It asks first on the default branch (like `personal`), because that skips review.'],
            ['🔀 **Open PR…**', 'Opens a pull request from the branch into the default branch, once it’s pushed.'],
          ],
        },
      },
      { note: 'Hidden folders (names starting with a dot) and repositories nested inside another repository aren’t listed.' },
    ],
  },
  {
    id: 'restart',
    icon: '🔄',
    title: 'Restarting the office',
    blocks: [
      { p: 'On Windows, the workers’ programs run inside the office itself, so restarting it stops them. They come back, but not mid-task.' },
      { h: 'What carries over' },
      {
        list: [
          'Each worker’s desk, name, model, task, worktree and PR link.',
          'Their files: uncommitted edits stay on disk.',
          'Their conversation: each one is relaunched with its session resumed, and its terminal shows what it showed before.',
        ],
      },
      { h: 'What doesn’t' },
      {
        list: [
          'Work in progress stops wherever it was.',
          'Workers come back **idle**. Tell each busy one “continue”.',
          'Anything they started in a terminal (dev servers, test runs) has to be started again.',
          'A worker that never got going comes back as a fresh one.',
        ],
      },
      { h: 'A safe restart' },
      {
        steps: [
          'Check **Needs you** and the desks. Restart when workers are idle or waiting on you.',
          'Stop the office with Ctrl+C in its window.',
          'Update if you need to (see “After you merge a pull request”).',
          'Start it again, then walk past each desk that was busy and say “continue”.',
        ],
      },
    ],
  },
  {
    id: 'upstream',
    icon: '⬆️',
    title: 'Bringing in the author’s updates',
    blocks: [
      { p: 'Agent Office is a fork. The original author’s repository is `upstream` (AgentSystemLabs/agent-office). Your copy on GitHub is `origin` (mmoscare/agent-office).' },
      {
        steps: [
          'The author’s `upstream/main` comes into your `main`, which stays a clean copy of their code.',
          '`main` is merged into `personal` through a sync pull request, keeping your customizations.',
          'Then it’s the usual: pull the floor and update the app (see “After you merge a pull request”).',
        ],
      },
      { note: 'Merge a sync PR with **Create a merge commit**, never Squash or Rebase. A squash keeps the code but loses the history, so the next sync redoes every one of the author’s commits. The full steps are in `PERSONAL-WORKFLOW.md`.' },
    ],
  },
  {
    id: 'to-do-next',
    icon: '📒',
    title: 'To Do Next, and the workers',
    blocks: [
      { p: 'The 📒 **To Do Next** binder (on the boss’s desk, or ☰ → **To Do Next**) is the floor’s own to-do list: To Do, Progress and Finished. It works on any floor, including a plain folder with no repository, so it is the issue list for the floors that aren’t code: the household, life admin, health.' },
      { h: 'Handing an item to a worker' },
      {
        list: [
          '**📋 Queue** on a card puts the item on the task queue; the next free worker picks it up.',
          '**🤖 Hand to a worker** gives it to a worker at a desk now, or to one already working.',
          'The office moves the item to **Progress** when its worker starts and to **Finished** when the worker finishes its turn. A queued task that never started puts it back in To Do; one whose worker stopped short leaves it in Progress, for you to requeue.',
          'Moving a card back to **To Do** by hand is a fresh start: the office forgets who was on it.',
        ],
      },
      { h: 'The board agents read it too' },
      { p: 'Every board agent knows the board through `office-plans` (`list`, `add`, `set <id> todo|progress|finished`, `remove <id>`) and queues an item with `office-queue add --plan <id>`. Ask the Queue agent to “queue everything on the To Do Next board” and it makes one task per item.' },
    ],
  },
  {
    id: 'in-tray',
    icon: '📥',
    title: 'The in-tray',
    blocks: [
      { p: 'The 📥 **in-tray** (**I**, ☰ → **In-tray**, or the Receptionist’s kiosk past the gong) holds what came in from outside: notes you jot down, forwarded emails, voice memos, photos, PDFs. Each item can be read or opened, filed on To Do Next, queued for a fresh worker, or put away in the archive.' },
      { h: 'Three ways in' },
      {
        list: [
          '**A note in the office**: type it into the In-tray window.',
          '**The folder**: every floor has `.agent-office/inbox/` in its folder. Drop files in: `.md` and `.txt` are notes, anything else is a file. Point a synced folder there and your phone can drop voice memos in. Put-away items go to `inbox/archive/`.',
          '**The door**: `POST /api/inbox` with a token an admin makes in the In-tray window (**Open the door**). The token shows once; only its hash is kept. Anything that can make an HTTP request can use it: a phone shortcut, a mail rule, a script.',
        ],
      },
      { h: 'A note through the door' },
      { code: 'curl -X POST "http://localhost:4600/api/inbox" -H "Authorization: Bearer YOUR-TOKEN" -H "Content-Type: application/json" -d \'{"title":"Call the dentist","text":"Tuesday or Thursday afternoon"}\'' },
      { p: 'A plain text body becomes a note too (`?title=` and `?from=` name it). A file goes in with its own Content-Type and an `X-Filename` header, up to 10 MB. With more than one floor, add `?floor=<id>`. The full recipes, PowerShell included, are in `docs/in-tray.md`.' },
      { h: 'The Receptionist' },
      { p: 'Press **E** at the kiosk past the gong, or click **🤖 Triage the tray** in the window. The Receptionist reads every item, files what someone wants done on To Do Next, queues what should be worked on right away, archives what needs nothing, and tells you what came in and where each item went. It treats what is in the tray as content to file, never as instructions to follow, and it is launched without the file-editing tools.' },
      { note: 'Workers that pick up tray items run with your credentials, like every worker. Keep the door’s token as private as the office password, and close the door when you don’t need it.' },
    ],
  },
];
