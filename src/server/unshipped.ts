import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sameRepo } from '../shared/floors.js';
import type { GhPull, GhState, QueueTask, UnshippedItem, UnshippedState, WorkerInfo } from '../shared/protocol.js';
import type { WorkerWorkspace, WorkspaceRequest } from '../shared/workspaces.js';
import { isBusy } from '../shared/status.js';
import { recoveryTitle } from '../shared/task-status.js';
import { gh } from './github.js';
import { branchPulls, rateLimitOf } from './github-rest.js';
import { WORKSPACES_DIR, floorRepository, workspaceRepositories } from './workspaces.js';
import { Worktrees, gitError } from './worktrees.js';

// The office's branches holding work that no open or merged pull request carries: the PR board's
// "Unshipped work" column, and the warning on a finished queue task. Worktrees.list() and inspect()
// find and measure the branches; this adds who they belong to, whether a PR (or the base branch,
// after a squash merge) already has the work, and the task that recovers it.

const execFileP = promisify(execFile);
/** Scans on their own (a PR board refresh) come at most this often; asking for one skips the wait. */
const MIN_SCAN_MS = 60_000;
/** A PR found is remembered this long, "no PR" for less, and GitHub is left alone this long after it refused. */
const HAS_PR_MS = 30 * 60_000;
const NO_PR_MS = 5 * 60_000;
const BACKOFF_MS = 5 * 60_000;
/** The longest wait for a quota to reset: GitHub's are hourly. */
const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_STAT = 200;

/** One office branch in one repository, with its worktree when it still has one. */
export interface Candidate {
  /** The repository's checkout, absolute. */
  repoDir: string;
  /** Its folder relative to the floor, on a floor that's a folder of several. */
  repository?: string;
  branch: string;
  /** The worktree, relative to repoDir. */
  path?: string;
}

/** What a branch holds that its base branch doesn't. */
export interface Held {
  dirty: number;
  commits: number;
  unpushed: number;
  added: number;
  deleted: number;
  modifiedAt?: number;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

async function tryGit(args: string[], cwd: string): Promise<string | undefined> {
  return git(args, cwd).catch(() => undefined);
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Where a branch's work should land: the branch the repository's checkout is on (its pull requests' base). */
export async function baseBranch(repoDir: string): Promise<string | undefined> {
  const b = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  return b && b !== 'HEAD' ? b : undefined;
}

/**
 * Whether every commit `branch` has over `base` is already there, even rewritten: patch-equivalent
 * ones (`git cherry`, after a rebase or cherry-pick) or all together (a squash merge, when merging
 * the branch into the base would change nothing). Returns how many commits are still missing.
 */
export async function missingCommits(repoDir: string, base: string, branch: string): Promise<number> {
  const cherry = await git(['cherry', base, branch], repoDir);
  const missing = cherry.split('\n').filter((l) => l.startsWith('+')).length;
  if (!missing) return 0;
  // A squash merge: one commit on the base holding the whole branch. merge-tree needs git 2.38+; without it, say what cherry said.
  const merged = await tryGit(['merge-tree', '--write-tree', base, branch], repoDir);
  const tree = merged?.split('\n')[0];
  if (tree && tree === (await tryGit(['rev-parse', `${base}^{tree}`], repoDir))) return 0;
  return missing;
}

/** What `c` holds that `base` doesn't, or undefined when nothing: Worktrees.inspect() measures it, then this checks for rewritten copies. */
export async function held(c: Candidate, base: string | undefined): Promise<Held | undefined> {
  const trees = new Worktrees(c.repoDir);
  const state = await trees.inspect({ path: c.path, branch: c.branch, base: base ?? 'HEAD' });
  if (state.error) throw new Error(state.error);
  let commits = state.ahead;
  if (commits && base) {
    commits = await missingCommits(c.repoDir, base, c.branch);
    // The local base may be behind GitHub's: a PR merged there shipped it too.
    const remote = `refs/remotes/origin/${base}`;
    if (commits && (await tryGit(['rev-parse', '--verify', '--quiet', remote], c.repoDir))) commits = Math.min(commits, await missingCommits(c.repoDir, remote, c.branch).catch(() => commits));
  }
  if (!state.dirty && !commits) return undefined;
  const out: Held = { dirty: state.dirty, commits, unpushed: state.unpushed, added: 0, deleted: 0 };
  const count = (numstat: string | undefined) => {
    for (const line of (numstat ?? '').split('\n')) {
      const [a, d] = line.split('\t');
      if (/^\d+$/.test(a ?? '')) out.added += Number(a);
      if (/^\d+$/.test(d ?? '')) out.deleted += Number(d);
    }
  };
  if (commits && base) count(await tryGit(['diff', '--numstat', `${base}...${c.branch}`], c.repoDir));
  const times: number[] = [];
  const last = Number(await tryGit(['log', '-1', '--format=%ct', c.branch], c.repoDir));
  if (last) times.push(last * 1000);
  const wt = c.path ? path.join(c.repoDir, c.path) : undefined;
  if (state.dirty && wt && existsSync(wt)) {
    count(await tryGit(['diff', '--numstat', 'HEAD'], wt));
    const files = ((await tryGit(['ls-files', '-z', '--modified', '--others', '--exclude-standard'], wt)) ?? '').split('\0').filter(Boolean);
    for (const f of files.slice(0, MAX_STAT)) {
      try {
        times.push(statSync(path.join(wt, f)).mtimeMs);
      } catch {
        // deleted files have no time
      }
    }
  }
  if (times.length) out.modifiedAt = Math.round(Math.max(...times));
  return out;
}

/**
 * Whether a branch has an open or merged pull request: the PR board's list first (already fetched),
 * then GitHub's REST API for the branch itself (github-rest.ts: its quota outlasts the board's GraphQL
 * one), remembered for a while. Undefined when GitHub can't say (rate-limited, offline, no gh): then
 * it stays alone for a few minutes, or until its quota resets, and the board says the status is unknown.
 */
export class BranchPulls {
  /** Why GitHub couldn't be asked, while it's being left alone. */
  error?: string;
  /** Set when that was its rate limit: whether a secondary one, and when it lifts (ms), when GitHub said. */
  limit?: { secondary: boolean; resetAt?: number };
  private cache = new Map<string, { at: number; has: boolean; revision: string }>();
  private backoffUntil = 0;

  constructor(
    private board: () => GhState<GhPull>,
    private query: typeof gh = gh,
    private now: () => number = Date.now,
  ) {}

  async has(branch: string, repoDir: string, repo?: string): Promise<boolean | undefined> {
    const board = this.board();
    const tip = await tryGit(['rev-parse', '--verify', `refs/heads/${branch}`], repoDir);
    const matches = board.items.filter((p) => p.headRefName === branch && (!repo || !p.repo || sameRepo(p.repo, repo)));
    const carries = (p: { state: string; headRefOid?: string }) => p.state === 'OPEN' || (p.state === 'MERGED' && !!tip && p.headRefOid === tip);
    if (matches.some(carries)) return true;
    // A new local tip or a refreshed CLOSED PR invalidates an earlier positive answer.
    const revision = JSON.stringify([tip, matches.map((p) => [p.number, p.state, p.headRefOid])]);
    const key = `${real(repoDir)}\0${branch}`;
    const hit = this.cache.get(key);
    if (hit && hit.revision === revision && this.now() - hit.at < (hit.has ? HAS_PR_MS : NO_PR_MS)) return hit.has;
    if (this.now() < this.backoffUntil) return undefined;
    try {
      const has = (await branchPulls(branch, repoDir, this.query, repo)).some((p) => p.headRefName === branch && carries(p));
      this.cache.set(key, { at: this.now(), has, revision });
      this.error = undefined;
      this.limit = undefined;
      return has;
    } catch (err) {
      const now = this.now();
      this.limit = rateLimitOf(err, now);
      const resetAt = this.limit?.resetAt;
      // Past a known reset nothing is gained by waiting; before one, asking sooner only fails again.
      this.backoffUntil = resetAt && resetAt > now ? Math.min(resetAt + 1000, now + MAX_BACKOFF_MS) : now + BACKOFF_MS;
      this.error = (err as Error).message || 'GitHub could not be asked';
      return undefined;
    }
  }
}

/** The repositories to look in: the floor itself when it's a checkout, else each one inside it (workspaces.ts finds them). */
export async function floorRepositories(floorDir: string): Promise<{ dir: string; repository?: string }[]> {
  const top = await tryGit(['rev-parse', '--show-toplevel'], floorDir);
  if (top) return [{ dir: real(top) }];
  const found = await workspaceRepositories(floorDir);
  return found.repositories.filter((r) => !r.error).map((r) => ({ dir: floorRepository(floorDir, r.path), repository: r.path }));
}

/** The desks' multi-repository workspaces, as their manifests describe them, the ones whose workers went home too. */
function savedWorkspaces(floorDir: string): WorkerWorkspace[] {
  const home = path.join(floorDir, WORKSPACES_DIR);
  if (!existsSync(home)) return [];
  const out: WorkerWorkspace[] = [];
  for (const name of readdirSync(home)) {
    try {
      const ws = JSON.parse(readFileSync(path.join(home, name, 'workspace.json'), 'utf8')) as WorkerWorkspace;
      if (Array.isArray(ws?.repositories)) out.push(ws);
    } catch {
      // not a workspace
    }
  }
  return out;
}

/** Every office branch on the floor, with its worktree: Worktrees.list() in each repository, plus the desks' workspace worktrees. */
export async function candidates(floorDir: string, workers: WorkerInfo[]): Promise<Candidate[]> {
  const repos = await floorRepositories(floorDir);
  const byRepo = new Map(repos.map((r) => [real(r.dir), r]));
  const multi = !!repos[0]?.repository;
  const found = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const key = `${real(c.repoDir)}\0${c.branch}`;
    const had = found.get(key);
    if (!had) found.set(key, c);
    else if (!had.path && c.path) had.path = c.path;
  };
  for (const r of repos) {
    const listed = await new Worktrees(r.dir).list().catch(() => undefined);
    if (!listed) continue;
    for (const wt of listed.worktrees) if (wt.branch) add({ repoDir: r.dir, repository: r.repository, branch: wt.branch, path: wt.path });
    for (const branch of listed.branches) add({ repoDir: r.dir, repository: r.repository, branch });
  }
  // A subfolder floor creates its worktrees under that folder, not under the Git root.
  const enclosing = repos.find((r) => !r.repository && real(r.dir) !== real(floorDir));
  if (enclosing) {
    const listed = await new Worktrees(floorDir).list();
    for (const wt of listed.worktrees) if (wt.branch) add({ repoDir: enclosing.dir, branch: wt.branch, path: path.relative(enclosing.dir, path.resolve(floorDir, wt.path)) });
  }
  const workspaces = [...savedWorkspaces(floorDir), ...workers.flatMap((w) => (w.workspace ? [w.workspace] : []))];
  for (const ws of workspaces) {
    for (const ref of ws.repositories) {
      let dir: string;
      try {
        dir = floorRepository(floorDir, ref.repository);
      } catch {
        continue;
      }
      const repo = byRepo.get(real(dir));
      if (!repo || !(await tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${ref.branch}`], dir))) continue;
      const wt = path.join(floorDir, ref.path);
      add({ repoDir: dir, repository: multi ? repo.repository : undefined, branch: ref.branch, path: existsSync(wt) ? path.relative(dir, wt) : undefined });
    }
  }
  return [...found.values()];
}

/** What the scan knows about an item that the browser doesn't get to name: where it is on disk. */
export interface Found {
  item: UnshippedItem;
  candidate: Candidate;
}

export interface ScanInput {
  floorDir: string;
  workers: WorkerInfo[];
  tasks: QueueTask[];
  pulls: BranchPulls;
  /** owner/name for a repository's checkout, when known, to match the PR board's items. */
  repoName?(repoDir: string): string | undefined;
}

/** Looks through every office branch on the floor for work no PR has; newest first. */
export async function scanUnshipped(input: ScanInput): Promise<Found[]> {
  const { floorDir, workers, tasks, pulls } = input;
  const repoOf = (repository: string) => {
    try {
      return real(floorRepository(floorDir, repository));
    } catch {
      return undefined;
    }
  };
  const owner = (c: Candidate) => {
    const repo = real(c.repoDir);
    return workers.find(
      (w) => (w.worktree?.branch === c.branch && !!c.path && real(path.resolve(floorDir, w.worktree.path)) === real(path.resolve(c.repoDir, c.path))) || w.workspace?.repositories.some((r) => r.branch === c.branch && repoOf(r.repository) === repo),
    );
  };
  const bases = new Map<string, string | undefined>();
  const out: Found[] = [];
  for (const c of await candidates(floorDir, workers)) {
    const key = real(c.repoDir);
    if (!bases.has(key)) bases.set(key, await baseBranch(c.repoDir));
    const base = bases.get(key);
    if (c.branch === base) continue;
    let h: Held | undefined;
    try {
      h = await held(c, base);
    } catch {
      continue; // a branch git can't read (just deleted): nothing to show
    }
    if (!h) continue;
    const has = await pulls.has(c.branch, c.repoDir, input.repoName?.(c.repoDir));
    if (has && !h.dirty) continue;
    const w = owner(c);
    const task = [...tasks].reverse().find((t) => t.branch === c.branch && (!w || !t.workerId || t.workerId === w.id));
    const floorPath = c.path ? path.relative(floorDir, path.join(c.repoDir, c.path)).split(path.sep).join('/') : undefined;
    out.push({
      candidate: c,
      item: {
        key: `${c.repository ?? '.'}\0${c.branch}`,
        branch: c.branch,
        repository: c.repository,
        path: floorPath,
        base,
        workerId: w?.id,
        workerName: w?.name ?? task?.workerName,
        worker: !w ? 'gone' : isBusy(w.status) ? 'active' : 'idle',
        taskId: task?.id,
        taskTitle: task?.title,
        dirty: h.dirty,
        commits: h.commits,
        unpushed: h.unpushed,
        added: h.added,
        deleted: h.deleted,
        modifiedAt: h.modifiedAt,
        pr: has === undefined ? 'unknown' : 'none',
      },
    });
  }
  return out.sort((a, b) => (b.item.modifiedAt ?? 0) - (a.item.modifiedAt ?? 0));
}

/**
 * The task that gets a fresh worker to carry a branch's work into a pull request, leaving the original
 * worktree as it is. `ownWorktree`: the queue seats the worker in a worktree of its own (a one-repo floor).
 */
export async function recoveryTask(found: Found, ownWorktree: boolean): Promise<{ title: string; prompt: string; workspace?: WorkspaceRequest }> {
  const { item, candidate: c } = found;
  const base = item.base ?? 'the base branch';
  const shas = item.commits && item.base
    ? ((await tryGit(['rev-list', '--reverse', '--cherry-pick', '--right-only', '--no-merges', `${item.base}...${c.branch}`], c.repoDir)) ?? '').split('\n').filter(Boolean)
    : [];
  const wt = c.path ? path.join(c.repoDir, c.path) : undefined;
  const repoNote = item.repository ? ` in the repository checked out at \`${c.repoDir}\`` : '';
  const who = item.workerName ? `${item.workerName}${item.taskTitle ? ` (working on “${item.taskTitle}”)` : ''}` : item.taskTitle ? `the worker on “${item.taskTitle}”` : 'an earlier worker';
  const workspace = item.repository ? { repositories: [item.repository] } : undefined;
  const lines = [
    `Recover work that ${who} left without a pull request, and ship it as a new PR against \`${base}\`.`,
    '',
    `Source, read-only: branch \`${c.branch}\`${repoNote}${wt ? `, worktree folder \`${wt}\`` : ' (its worktree folder is gone; only the branch is left)'}.`,
    `It holds ${[item.dirty ? `${item.dirty} uncommitted file(s)` : '', item.commits ? `${item.commits} commit(s) not on \`${base}\`` : ''].filter(Boolean).join(' and ')}.`,
    'Do NOT modify the source: no commits, checkouts, resets, stashes, cleans or deletes in that folder or on that branch. Only read from it.',
    '',
    'Steps:',
    ownWorktree || workspace
      ? `1. ${workspace ? `Use the managed workspace worktree for repository ${JSON.stringify(item.repository)} listed in your workspace instructions.` : 'You are in your own fresh worktree.'} Make sure it starts from the latest \`${base}\`: \`git fetch origin\`, then \`git rebase origin/${base}\` if that remote branch exists and is ahead of yours.`
      : '1. No managed worktree is available. Stop and ask for a repository to be selected before changing any files.',
    shas.length
      ? `2. Carry over the commits, oldest first: \`git cherry-pick ${shas.join(' ')}\`. (To recompute the list: \`git rev-list --reverse --cherry-pick --right-only --no-merges ${base}...${c.branch}\`.)`
      : '2. There are no commits to carry over.',
    item.dirty && wt
      ? `3. Carry over the uncommitted changes: \`git -C "${wt}" diff HEAD --binary > recovered.patch\`, then \`git apply --3way recovered.patch\` here and delete the patch file. Copy the untracked files listed by \`git -C "${wt}" ls-files --others --exclude-standard\` to the same paths here.`
      : '3. There are no uncommitted changes to carry over.',
    '4. Resolve any conflicts so the recovered work fits the latest code. Look at the original task and the source branch for intent.',
    "5. Run the project's type check, build and tests, and fix what they find.",
    `6. Commit, push your branch, and open a pull request against \`${base}\`${item.repository ? ' in that repository' : ''} (\`gh pr create --base ${base}\`). Say in its description which branch and worktree the work came from, what you carried over, and the checks you ran.`,
  ];
  return { title: recoveryTitle(c.branch, item.repository), prompt: lines.join('\n'), workspace };
}

/**
 * The floor's watch on unshipped work: scans now and then (and when asked), keeps the last result for
 * the PR board, and tells the queue which finished tasks left work behind.
 */
export class UnshippedWatch {
  state: UnshippedState = { items: [], scannedAt: 0, scanning: false };
  private found = new Map<string, Found>();
  private running?: Promise<void>;
  private again = false;
  private soonTimer?: NodeJS.Timeout;
  private stopped = false;
  readonly pulls: BranchPulls;

  constructor(
    private floorDir: string,
    private deps: {
      workers(): WorkerInfo[];
      tasks(): QueueTask[];
      board(): GhState<GhPull>;
      repoName?(repoDir: string): string | undefined;
      update(state: UnshippedState): void;
      /** Finished tasks' branches, and what each still holds. */
      branches(byBranch: Map<string, { dirty: number; commits: number }>): void;
    },
    query: typeof gh = gh,
  ) {
    this.pulls = new BranchPulls(deps.board, query);
  }

  /** Looks again, unless it looked less than a minute ago (`force` looks anyway). */
  scan(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      if (force) this.again = true;
      return this.running;
    }
    if (!force && Date.now() - this.state.scannedAt < MIN_SCAN_MS) return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.scan(true);
      }
    });
    return this.running;
  }

  /** A task just finished: look in a few seconds, once its worker has had its last word. */
  soon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => void this.scan(true), 5000);
  }

  /** The item's recovery task, or why there can't be one. */
  async recover(key: string, ownWorktree: boolean): Promise<{ title: string; prompt: string; workspace?: WorkspaceRequest } | string> {
    const f = this.found.get(key);
    if (!f) return 'That branch is no longer on the unshipped list — refresh the board';
    const w = f.item.workerId ? this.deps.workers().find((x) => x.id === f.item.workerId) : undefined;
    if (w && isBusy(w.status)) return `${w.name} is still working on ${f.item.branch}`;
    return recoveryTask(f, ownWorktree);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.soonTimer);
  }

  private async run() {
    this.state = { ...this.state, scanning: true };
    this.deps.update(this.state);
    try {
      const found = await scanUnshipped({ floorDir: this.floorDir, workers: this.deps.workers(), tasks: this.deps.tasks(), pulls: this.pulls, repoName: this.deps.repoName });
      this.found = new Map(found.map((f) => [f.item.key, f]));
      // Only the branch lookups' own failures leave a status unknown: the board's list failing too
      // (its GraphQL quota gone) says nothing about a branch REST answered for.
      const unknown = found.some((f) => f.item.pr === 'unknown');
      const limit = unknown ? this.pulls.limit : undefined;
      this.state = {
        items: found.map((f) => f.item),
        scannedAt: Date.now(),
        scanning: false,
        prNote: unknown ? (limit ? "GitHub's API rate limit" : this.pulls.error ?? 'GitHub could not be asked') : undefined,
        prLimit: limit,
      };
      // Queue tasks have no repository of their own: only one-repo floors give them branches.
      this.deps.branches(new Map(found.filter((f) => !f.item.repository).map((f) => [f.item.branch, { dirty: f.item.dirty, commits: f.item.commits }])));
    } catch (err) {
      this.state = { ...this.state, scanning: false, scannedAt: Date.now(), error: gitError(err) };
    }
    if (!this.stopped) this.deps.update(this.state);
  }
}
