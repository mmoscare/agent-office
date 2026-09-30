// The floor's workers as the board agents see them, and clocking one out for them (the office-workers
// command, bin/office-workers.js). A board agent sends a worker home the way X at its desk does, but
// only once the office has made sure nothing is left behind: never a board agent, a worker mid-turn,
// one still on its queue task, or one whose checkout holds work no remote has. Its worktree and branch
// are kept unless the agent asks for them to go, and they only go once its branch has merged.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DESK_BY_ID } from '../shared/layout.js';
import { pullForBranch } from '../shared/pulls.js';
import type { AgentProvider, GhPull, QueueTask, WorkerInfo, WorkerKind, WorkerStatus, WorktreeCleanup } from '../shared/protocol.js';
import type { Floor } from './floor.js';
import { gh } from './github.js';
import { branchPulls, type BranchPull } from './github-rest.js';
import { missingCommits } from './unshipped.js';
import { gitError } from './worktrees.js';

const execFileP = promisify(execFile);

/** What listing and clocking out workers needs from their floor (see Floor). */
export interface WorkersFloor {
  dir: string;
  /** The branch the floor's checkout is on: where a worker's branch lands when it doesn't say. */
  branch?: string;
  workers: {
    list(): WorkerInfo[];
    get(id: string): WorkerInfo | undefined;
    kill(id: string, cleanup?: WorktreeCleanup): Promise<{ note?: string; error?: string }>;
  };
  tasks(): QueueTask[];
  pulls(): GhPull[];
  /** GitHub's own word on a branch's pull requests: fresher than the board after a merge a moment ago. */
  branchPulls(branch: string, repoDir: string): Promise<BranchPull[]>;
}

export function workersFloor(floor: Floor): WorkersFloor {
  return {
    dir: floor.dir,
    branch: floor.project.branch,
    workers: floor.workers,
    tasks: () => floor.queue.state().tasks,
    pulls: () => floor.github.pulls.items,
    branchPulls: (branch, repoDir) => branchPulls(branch, repoDir, gh),
  };
}

/** One worker, for office-workers list. */
export interface WorkerRow {
  id: string;
  name: string;
  /** Its desk or seat. */
  desk: string;
  /** It stands by one of the boards. */
  board?: boolean;
  kind: WorkerKind;
  provider?: AgentProvider;
  model?: string;
  status: string;
  /** Since when it's been done, or waiting on an answer (ms). */
  since?: number;
  /** What it's on, as the card above its head says. */
  task?: string;
  branch?: string;
  pr?: { number: number; state: string; url: string };
  /** The queue task it was seated for, latest first. */
  queued?: { id: string; title: string; status: string };
  /** What its checkout holds: its own worktree (every repository's, for a workspace), or the floor's checkout. */
  work?: CheckoutWork & { path: string };
  /** Why the office wouldn't clock it out now; unset when it would. */
  blocked?: string;
}

const STATUS: Record<WorkerStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  needs_input: 'needs input',
  paused: 'paused',
  interrupted: 'interrupted',
  done: 'done',
  exited: 'exited',
  offline: 'asleep',
};

/** Why the office won't clock `w` out now, before looking at its checkout; undefined when nothing stops it. */
export function clockOutBlock(w: WorkerInfo, tasks: QueueTask[]): string | undefined {
  if (DESK_BY_ID.get(w.deskId)?.station) return `${w.name} is a board agent: only a person clocks those out`;
  if (w.meeting) return `${w.name} is at the meeting table: the meeting sends its workers home`;
  if (w.kind !== 'agent') return `${w.name} is a shell someone opened: only a person clocks those out`;
  if (w.prOpening) return `${w.name}'s pull request is being opened: wait for that to finish`;
  if (w.status === 'starting' || w.status === 'working') return `${w.name} is working`;
  if (w.status === 'needs_input') return `${w.name} needs input: a person has to answer it first`;
  if (w.status === 'paused' || w.status === 'interrupted') return `${w.name} stopped partway through a turn (${STATUS[w.status]}): a person should look at it first`;
  const task = tasks.find((t) => t.status === 'running' && t.workerId === w.id);
  if (task) return `${w.name}'s queue task “${task.title}” (${task.id}) is still running: the queue says when it's done`;
  const viewers = [...new Set(w.viewers)];
  if (viewers.length) return `${viewers.join(' and ')} ${viewers.length === 1 ? 'has' : 'have'} ${w.name}'s terminal open`;
  return undefined;
}

/** A git checkout a worker works in: its own worktree, one of its workspace's, or the floor's own. */
export interface WorkerCheckout {
  /** The repository it's in (absolute). */
  repo: string;
  /** The checkout's folder (absolute). */
  dir: string;
  /** Its folder relative to the floor, to say where. */
  rel: string;
  /** Its own branch; unset for the floor's checkout, which isn't the worker's. */
  branch?: string;
  /** The commit it was cut from. */
  start?: string;
  /** The branch its work lands on: its pull request's base. */
  base?: string;
}

export function workerCheckouts(floorDir: string, w: WorkerInfo, floorBranch?: string): WorkerCheckout[] {
  // Only read here, so no need for Workspaces.check's (blocking) look at each one: sending home does that.
  if (w.workspace) return w.workspace.repositories.map((r) => ({ repo: path.resolve(floorDir, r.repository), dir: path.join(floorDir, r.path), rel: r.path, branch: r.branch, start: r.base, base: r.from }));
  const wt = w.worktree;
  if (wt) return [{ repo: floorDir, dir: path.join(floorDir, wt.path), rel: wt.path, branch: wt.branch, start: wt.base, base: wt.from ?? floorBranch }];
  return [{ repo: floorDir, dir: floorDir, rel: '.' }];
}

/** What a checkout holds that clocking its worker out would leave behind. */
export interface CheckoutWork {
  /** Files with uncommitted changes, new ones included. */
  dirty: number;
  /** Commits no remote has (git rev-list HEAD --not --remotes), less what its merged pull request delivered. */
  unpushed: number;
  /** Commits of its own since it was cut, when that's known. */
  commits?: number;
  error?: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
const branchRef = (branch: string) => `refs/heads/${branch}`;
/** The merged heads git has here: a commit GitHub made (it updated the branch itself) can't be named. */
async function knownHeads(heads: string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const h of new Set(heads)) if (/^[0-9a-f]{40,64}$/.test(h) && (await ok(git(['cat-file', '-e', `${h}^{commit}`], cwd)))) out.push(h);
  return out;
}

/**
 * What `c` holds: uncommitted files, and commits no remote has, on whatever its folder has checked out
 * and on its own branch. `landed` are merged pull requests' heads: what they delivered doesn't count,
 * even once GitHub has deleted the branch. `own` also counts its commits since it was cut.
 */
export async function checkoutWork(c: WorkerCheckout, landed: string[] = [], own = false): Promise<CheckoutWork> {
  const work: CheckoutWork = { dirty: 0, unpushed: 0 };
  try {
    const here = existsSync(c.dir);
    const cwd = here ? c.dir : c.repo;
    const [branch, status, delivered] = await Promise.all([
      c.branch ? ok(git(['rev-parse', '--verify', '--quiet', branchRef(c.branch)], cwd)) : false,
      here ? git(['status', '--porcelain'], cwd) : '',
      knownHeads(landed, cwd),
    ]);
    const tips = [...(here ? ['HEAD'] : []), ...(branch ? [branchRef(c.branch!)] : [])];
    // Folder and branch both gone: nothing left to lose.
    if (!tips.length) return work;
    work.dirty = status.split('\n').filter(Boolean).length;
    const [unpushed, commits] = await Promise.all([
      git(['rev-list', '--count', ...tips, '--not', '--remotes', ...delivered], cwd),
      own && c.start ? git(['rev-list', '--count', ...tips, '--not', c.start], cwd).catch(() => undefined) : undefined,
    ]);
    work.unpushed = Number(unpushed);
    if (commits !== undefined) work.commits = Number(commits);
  } catch (err) {
    work.error = gitError(err);
  }
  return work;
}

/** The heads of the merged pull requests from these checkouts' branches, as the board has them. */
function mergedHeads(pulls: GhPull[], checkouts: WorkerCheckout[]): string[] {
  const branches = new Set(checkouts.map((c) => c.branch).filter(Boolean));
  return pulls.filter((p) => p.state === 'MERGED' && p.headRefOid && branches.has(p.headRefName)).map((p) => p.headRefOid!);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const where = (c: WorkerCheckout) => (c.rel === '.' ? "the floor's checkout, which it works in" : c.rel);

/** What clocking `w` out would leave behind, said plainly; undefined when nothing. */
export function strandedWork(w: WorkerInfo, checkouts: WorkerCheckout[], works: CheckoutWork[]): string | undefined {
  const parts: string[] = [];
  for (const [i, c] of checkouts.entries()) {
    const s = works[i];
    if (s.error) return `The office couldn't check what's in ${w.name}'s ${where(c)} (${s.error}), so it stays`;
    const what = [s.dirty ? plural(s.dirty, 'uncommitted change') : '', s.unpushed ? plural(s.unpushed, 'commit') + ' no remote has' : ''].filter(Boolean).join(' and ');
    if (what) parts.push(`${what} in ${where(c)}`);
  }
  if (!parts.length) return undefined;
  return `${w.name} has ${parts.join('; ')}: clocking it out would leave that work unshipped with nobody on it. Name it for the owner instead`;
}

/** Why `c`'s branch can't go yet (its work isn't all on its base), or undefined when it has all landed. */
async function unmerged(c: WorkerCheckout, heads: string[]): Promise<string | undefined> {
  if (!c.branch) return 'it has no branch of its own';
  const cwd = existsSync(c.repo) ? c.repo : c.dir;
  const ref = branchRef(c.branch);
  const bases = c.base ? [branchRef(c.base), `refs/remotes/origin/${c.base}`] : [];
  const [exists, delivered, ...known] = await Promise.all([ok(git(['rev-parse', '--verify', '--quiet', ref], cwd)), knownHeads(heads, cwd), ...bases.map((b) => ok(git(['rev-parse', '--verify', '--quiet', b], cwd)))]);
  if (!exists) return undefined;
  // Its pull request merged, and the branch has nothing past what it delivered (a squash merge included).
  for (const head of delivered) if (Number(await git(['rev-list', '--count', ref, '--not', head], cwd)) === 0) return undefined;
  if (!c.base) return `the office can't tell which branch ${c.branch} merges into`;
  let missing: number | undefined;
  // The local base may be behind GitHub's: a merge there counts too, as far as this checkout last fetched.
  for (const [i, base] of bases.entries()) {
    if (!known[i]) continue;
    const n = await missingCommits(cwd, base, ref).catch(() => undefined);
    if (n === 0) return undefined;
    if (n !== undefined) missing = Math.min(missing ?? n, n);
  }
  return missing === undefined ? `the office couldn't compare ${c.branch} with ${c.base}` : `${c.branch} has ${plural(missing, 'commit')} not merged into ${c.base}`;
}

/**
 * The heads of these checkouts' merged pull requests as GitHub has them now: the board may not have
 * caught up with a merge a moment ago. Asked once, however often it's called.
 */
function freshHeads(floor: WorkersFloor, checkouts: WorkerCheckout[]): () => Promise<string[]> {
  let asked: Promise<string[]> | undefined;
  return () =>
    (asked ??= Promise.all(
      checkouts.map(async (c) => {
        if (!c.branch) return [];
        const pulls = await floor.branchPulls(c.branch, c.repo).catch(() => [] as BranchPull[]);
        return pulls.filter((p) => p.state === 'MERGED' && p.headRefName === c.branch && p.headRefOid).map((p) => p.headRefOid!);
      }),
    ).then((heads) => heads.flat()));
}

/** Why `w`'s worktree and branch should stay, or undefined when every branch has merged and they can go. */
async function keepReason(w: WorkerInfo, checkouts: WorkerCheckout[], heads: string[], fresh: () => Promise<string[]>): Promise<string | undefined> {
  if (!w.worktree && !w.workspace) return `${w.name} works in the floor's own checkout, so there's no worktree to remove`;
  for (const c of checkouts) {
    let why = await unmerged(c, heads);
    if (why && c.branch) {
      const merged = await fresh();
      if (merged.length) why = await unmerged(c, [...heads, ...merged]);
    }
    if (why) return why;
  }
  return undefined;
}

export type ClockOut =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      worker: WorkerInfo;
      cleanup: 'keep' | 'all';
      /** Asked to remove the worktree, but it's kept: why. */
      kept?: string;
      /** Settles once the worker has gone and its worktree is dealt with, with a line for the team. */
      done: Promise<{ note?: string; error?: string }>;
    };

/**
 * Clocks worker `id` out, the same as X at its desk (WorkerManager.kill), once the office has checked
 * nothing would be left behind. Its worktree and branch are kept; `removeWorktree` deletes them too,
 * once its branch has merged, and otherwise keeps them and says why.
 */
export async function clockOut(floor: WorkersFloor, id: string, removeWorktree: boolean): Promise<ClockOut> {
  const w = floor.workers.get(id);
  if (!w) {
    const named = floor.workers.list().filter((x) => x.name.toLowerCase() === id.trim().toLowerCase());
    if (named.length) return { ok: false, status: 400, error: `Give the worker's id, not its name, since names are reused: ${named.map((x) => `${x.name} is ${x.id}`).join(', ')}` };
    return { ok: false, status: 404, error: `There's no worker ${id} on this floor (see office-workers list)` };
  }
  const blocked = clockOutBlock(w, floor.tasks());
  if (blocked) return { ok: false, status: 409, error: blocked };
  const checkouts = workerCheckouts(floor.dir, w, floor.branch);
  const fresh = freshHeads(floor, checkouts);
  let heads = mergedHeads(floor.pulls(), checkouts);
  const look = () => Promise.all(checkouts.map((c) => checkoutWork(c, heads)));
  let works = await look();
  // Commits no remote has may be a pull request merged a moment ago with its branch deleted
  // (gh pr merge --delete-branch), before the board has heard: ask GitHub, then count again.
  if (strandedWork(w, checkouts, works) && works.some((s) => s.unpushed && !s.dirty && !s.error)) {
    const merged = await fresh();
    if (merged.length) {
      heads = [...heads, ...merged];
      works = await look();
    }
  }
  const stranded = strandedWork(w, checkouts, works);
  if (stranded) return { ok: false, status: 409, error: stranded };
  const kept = removeWorktree ? await keepReason(w, checkouts, heads, fresh) : undefined;
  // Files may have changed while GitHub was being asked (an editor, a process of its own): look again,
  // last thing, since sending it home with 'all' deletes the worktree.
  const changed = strandedWork(w, checkouts, await look());
  if (changed) return { ok: false, status: 409, error: changed };
  // Someone may have prompted it, or opened its terminal, meanwhile: checked with nothing to wait on before it goes.
  const now = floor.workers.get(id);
  const late = now ? clockOutBlock(now, floor.tasks()) : `${w.name} has already gone home`;
  if (late) return { ok: false, status: 409, error: late };
  const cleanup = removeWorktree && !kept ? 'all' : 'keep';
  return { ok: true, worker: w, cleanup, ...(kept ? { kept } : {}), done: floor.workers.kill(id, cleanup) };
}

/** The pull request a worker's work went up as: from its branch, its desk, or its queue task. */
function prOf(w: WorkerInfo, pulls: GhPull[], task: QueueTask | undefined): WorkerRow['pr'] {
  const branch = w.worktree?.branch;
  const board = branch ? pullForBranch(pulls, branch) : undefined;
  const found = board ?? w.pr ?? w.workspace?.repositories.find((r) => r.pr)?.pr ?? task?.pr;
  if (!found) return undefined;
  const draft = board && pulls.find((p) => p.number === board.number && p.headRefName === branch)?.isDraft;
  const state = draft ? 'draft' : String(('state' in found && found.state) || 'open').toLowerCase();
  return { number: found.number, state, url: found.url };
}

/** Every worker on the floor, with where its work stands and whether the office would clock it out. */
export async function listWorkers(floor: WorkersFloor): Promise<WorkerRow[]> {
  const tasks = floor.tasks();
  const pulls = floor.pulls();
  return Promise.all(
    floor.workers.list().map(async (w): Promise<WorkerRow> => {
      const board = !!DESK_BY_ID.get(w.deskId)?.station;
      const task = tasks.filter((t) => t.workerId === w.id).at(-1);
      const branches = [...new Set(w.workspace ? w.workspace.repositories.map((r) => r.branch) : w.worktree ? [w.worktree.branch] : [])];
      let blocked = clockOutBlock(w, tasks);
      let work: WorkerRow['work'];
      // Board agents, shells and the meeting table never go this way: their checkouts are nobody's to weigh up.
      if (!board && w.kind === 'agent' && !w.meeting) {
        const checkouts = workerCheckouts(floor.dir, w, floor.branch);
        const works = await Promise.all(checkouts.map((c) => checkoutWork(c, mergedHeads(pulls, checkouts), true)));
        const sum = (k: 'dirty' | 'unpushed' | 'commits') => works.reduce((n, s) => n + (s[k] ?? 0), 0);
        const errors = works.map((s, i) => (s.error ? `${checkouts[i].rel}: ${s.error}` : '')).filter(Boolean);
        work = {
          path: w.workspace?.path ?? checkouts[0].rel,
          dirty: sum('dirty'),
          unpushed: sum('unpushed'),
          ...(works.some((s) => s.commits !== undefined) ? { commits: sum('commits') } : {}),
          ...(errors.length ? { error: errors.join('; ') } : {}),
        };
        blocked ??= strandedWork(w, checkouts, works);
      }
      return {
        id: w.id,
        name: w.name,
        desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
        ...(board ? { board } : {}),
        kind: w.kind,
        provider: w.provider,
        model: w.runningModel ?? w.model,
        status: STATUS[w.status] ?? w.status,
        since: w.status === 'done' || w.status === 'needs_input' ? w.waitingSince : undefined,
        task: w.task?.name,
        branch: branches.join(', ') || undefined,
        pr: prOf(w, pulls, task),
        queued: task && { id: task.id, title: task.title, status: task.status },
        work,
        blocked,
      };
    }),
  );
}
