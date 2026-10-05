import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { lstat, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepo } from '../shared/floors.js';
import { pullForBranch } from '../shared/pulls.js';
import type { PullRequestRef } from '../shared/protocol.js';
import { officeRoot } from './git-board.js';
import { gh } from './github.js';
import { missingCommits } from './unshipped.js';
import { WORKSPACES_DIR, workspaceRepositories } from './workspaces.js';
import { BRANCH_PREFIX, WORKTREES_DIR, gitError } from './worktrees.js';

// `agent-office prune` for a whole floor, the way CleanBot (cleanbot.ts) drives it: every repository on
// the floor, and in each only the office's own leftovers: office/* branches, worktrees under
// .agent-office/worktrees (registered, or "stray" folders git no longer lists), multi-repository desks'
// worktrees under .agent-office/workspaces, and worktrees registered from a Claude scratchpad in the
// temp folder. Each gets a verdict on whether deleting it could lose anything, or take something an
// agent still needs (the PR agent's and the VP's PRs, queued tasks, the PR board's unshipped work), and
// a suggestion: delete it, look at it, or keep it. Nothing is deleted unless it's named with --only, and
// each named row is looked at again, workers and all, right before it goes.
// Upstream's plain `agent-office prune` (prune.ts) is left exactly as it was.

/** A worktree or branch changed this recently counts as in use. */
export const RECENT_MS = 24 * 60 * 60_000;
/** Younger than this, a worktree or branch may be a worker being hired: never deleted, not even by --discard. */
export const NEW_MS = 10 * 60_000;
/** Pins ("always keep") per repository, in the floor's .agent-office: the same file the cleanup screen uses. */
export const KEEP_FILE = 'cleanup-keep.json';
/** One JSON line per run that deleted something, in the floor's .agent-office. */
export const LOG_FILE = 'cleanup-log.jsonl';
/** Never deleted, whatever else is true of them. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'personal']);
/** Branches that host PR screenshots (a PR's images point at them). */
const PR_ASSETS = 'pr-assets/';
/** Ignored folders that are build output or dependencies: rebuilt, not work. */
const BUILD_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', '.turbo', '.vite', 'coverage', '.nyc_output', 'target', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.gradle', '.tox']);
const JUNK_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(tsbuildinfo|pyc|pyo)$/i;
/** How many entries a recency walk looks at before giving up (and saying so). */
const WALK_MAX = 60_000;
const IGNORED_LISTED = 5;
/** Holding work but untouched this long: suggested for a look (the person decides), never for deleting. */
export const LOOK_MS = 7 * 24 * 60 * 60_000;

export type Verdict = 'safe' | 'work' | 'open-pr' | 'needed' | 'worker' | 'recent' | 'new' | 'protected' | 'not-office' | 'unknown';

/** What each verdict is called in the table. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  safe: 'safe to delete',
  work: 'holds work',
  'open-pr': 'open PR',
  needed: 'still needed',
  worker: "live worker's",
  recent: 'recently active',
  new: 'just made',
  protected: 'protected',
  'not-office': "not the office's, left alone",
  unknown: "couldn't check",
};

/** Verdicts --discard can override for a named row, once the person has seen what would be lost. */
const DISCARDABLE = new Set<Verdict>(['work', 'recent', 'unknown']);

export interface PullRef {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** The PR's head branch. */
  head: string;
  url: string;
}

/** The pull requests of a GitHub repository (owner/name), any state. */
export type PullLister = (repo: string, cwd: string) => Promise<PullRef[]>;

/** What the running office says (GET /office/cleanbot?view=office, or CleanBot's own sweep in the office). */
export interface OfficeView {
  /** At least one live console has no verifiable current directory. */
  unlocatedTerminals?: boolean;
  floors: { name: string; dir: string }[];
  /** Folders a terminal of the office is working in right now. */
  busy: { path: string; what: string }[];
}

/**
 * Something an agent still needs, found in what it's been asked: a live worker's request and task (the
 * PR agent's and the VP's included), or a task waiting or running on the queue. A row whose branch,
 * worktree folder or PR number it names is kept.
 */
export interface Need {
  what: string;
  text: string;
  /** owner/name, when the task says which repository (a floor that's a folder of them). */
  repo?: string;
}

/** What CleanBot suggests for a row: delete it (safe), look at it with the person (holds work, idle a while), or keep it. */
export type Suggestion = 'delete' | 'look' | 'keep';

export interface SuggestedRow {
  n: number;
  repo: string;
  name: string;
  why: string;
}

export interface PruneRow {
  /** Row number in the table, across every repository of the floor. */
  n: number;
  /** The repository, relative to the floor ('.' when the floor is the repository). */
  repo: string;
  /** What --only, --keep and --discard take: the branch, or the worktree's path when it has none. */
  name: string;
  branch?: string;
  /** The branch exists here, and on origin (as of this run's fetch). */
  local: boolean;
  origin: boolean;
  worktree?: {
    /** Relative to the floor with forward slashes when inside it, absolute otherwise. */
    path: string;
    kind: 'office' | 'desk' | 'scratchpad' | 'other';
    exists: boolean;
    /** A folder git no longer lists as a worktree: a half-deleted one. */
    stray?: boolean;
    detached?: boolean;
    locked?: boolean;
    /** The desk (its folder under .agent-office/workspaces) a desk worktree belongs to. */
    desk?: string;
  };
  pr?: PullRequestRef;
  /** The last commit's date, ISO 8601. */
  lastCommit?: string;
  /** When anything in the worktree's folder last changed, ISO 8601. */
  changed?: string;
  verdict: Verdict;
  /** Why, said for a person. */
  why: string;
  /** `unshipped`: commits on GitHub that no open or merged PR carries (the PR board's unshipped work). */
  holds?: { uncommitted: number; unpushed: number; ignored: string[]; edits: number; unshipped?: number };
  /** What deleting the row takes: the worktree (git's), a stray folder, the local branch, origin's copy. */
  removes: ('worktree' | 'folder' | 'branch' | 'origin')[];
  /** Why origin's copy stays even with --remote, when it has one. */
  originStays?: string;
  /** --discard can delete it anyway. */
  discardable: boolean;
  kept?: 'always' | 'this run';
  suggest: Suggestion;
}

export interface RepoReport {
  path: string;
  name: string;
  /** owner/name of origin, when it's on GitHub. */
  github?: string;
  current?: string;
  defaultBranch?: string;
  fetch: 'ok' | 'failed' | 'no-origin' | 'skipped';
  fetchError?: string;
  prs: 'ok' | 'none' | 'unknown';
  prError?: string;
  alwaysKeep: string[];
  error?: string;
}

export interface RunStep {
  repo: string;
  name: string;
  what: 'worktree' | 'folder' | 'branch' | 'origin';
  ok: boolean;
  error?: string;
}

export interface PruneRun {
  dryRun: boolean;
  remote: boolean;
  /** Parts removed (or that would be, on a dry run). */
  removed: RunStep[];
  failed: RunStep[];
  /** Named rows that weren't touched, and why. */
  refused: { repo?: string; name: string; why: string }[];
}

export interface FloorPruneReport {
  floor: string;
  at: string;
  recentHours: number;
  /** Whether the running office was asked which terminals are open. */
  office: 'asked' | 'not reachable';
  notes: string[];
  repos: RepoReport[];
  rows: PruneRow[];
  /**
   * CleanBot's suggestion. `delete`: the safe rows, nothing kept (deletes the local worktree and branch;
   * origin's copy only with --remote). `remote`: safe rows only on GitHub, which need --remote. `look`:
   * rows that hold work but have been idle LOOK_MS or more: for the person to decide, never suggested
   * for deleting.
   */
  suggested: { delete: SuggestedRow[]; remote: SuggestedRow[]; look: SuggestedRow[] };
  run?: PruneRun;
}

export interface FloorPruneOptions {
  floor: string;
  /** Only this repository of the floor (its path, or its folder's name). */
  repo?: string;
  /** Delete these rows. Without it nothing is deleted. */
  only?: string[];
  /** Keep these rows this run, even when named in --only. */
  keep?: string[];
  /** Named rows to delete even though they hold work or were recently active. */
  discard?: string[];
  /** Delete origin's copy too, only for branches whose PR is merged or closed. */
  remote?: boolean;
  dryRun?: boolean;
  /** Add to (or take off) the always-keep list before anything else. */
  alwaysKeep?: string[];
  forgetKeep?: string[];
  recentMs?: number;
  /** `git fetch --prune origin` first (default true). */
  fetch?: boolean;
  now?: () => number;
  pulls?: PullLister;
  /** Asks the running office; resolves undefined when it can't be reached. */
  office?: () => Promise<OfficeView | undefined>;
  /** The temp folder Claude scratchpads live under (default os.tmpdir()). */
  tmp?: string;
  /** Claude Code's session transcripts (default ~/.claude/projects). */
  claudeProjects?: string;
  /** Who ran it, for the log. */
  by?: string;
}

// ---- git -----------------------------------------------------------------------------------------

interface Out {
  out: string;
  err: string;
  code: number;
}

/** Runs git; a non-zero exit is a result. Never prompts, never takes optional locks on live checkouts. */
function run(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<Out> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 60_000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout, err: stderr, code: 0 });
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ out: stdout, err: stderr, code });
      reject(new Error(gitError(err)));
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (opts.input !== undefined || (error.code !== 'EPIPE' && error.code !== 'EOF')) reject(error);
    });
    child.stdin?.end(opts.input);
  });
}

async function git(args: string[], cwd: string, opts?: Parameters<typeof run>[2]): Promise<string> {
  return (await gitRaw(args, cwd, opts)).trim();
}

/** Git's output as it is: `git status --porcelain` starts with a space when a file is changed but not staged. */
async function gitRaw(args: string[], cwd: string, opts?: Parameters<typeof run>[2]): Promise<string> {
  const r = await run(args, cwd, opts);
  if (r.code !== 0) throw new Error(gitError({ stderr: r.err }) || `git ${args[0]} failed`);
  return r.out;
}

async function gitMaybe(args: string[], cwd: string): Promise<string | undefined> {
  const r = await run(args, cwd).catch(() => undefined);
  return r?.code === 0 ? r.out.trim() : undefined;
}

// ---- paths ---------------------------------------------------------------------------------------

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** A path to compare by: resolved, and case-insensitive where the file system is. */
function key(p: string): string {
  const r = real(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** `p` is inside `root`, or is it. Both are keys. */
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const slash = (p: string) => p.split(path.sep).join('/');

/** Relative to the floor when it's in it, else absolute; forward slashes either way. */
function shown(floor: string, abs: string): string {
  const rel = path.relative(floor, abs);
  return slash(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ---- Who still uses what -------------------------------------------------------------------------

interface SavedWorker {
  name?: unknown;
  deskId?: unknown;
  sessionId?: unknown;
  title?: unknown;
  prompt?: unknown;
  ask?: { first?: unknown; latest?: unknown };
  task?: { name?: unknown; summary?: unknown };
  worktree?: { path?: unknown; branch?: unknown };
  workspace?: { path?: unknown; repositories?: { path?: unknown; branch?: unknown }[] };
}

/** Everything the building's workers, meetings and terminals still use. */
export interface Owners {
  unlocatedTerminals?: boolean;
  /**
   * Folders (keys) and whose they are. 'tree': a worktree itself. 'desk': a desk's folder, owning every
   * worktree in it. 'cwd': where a terminal is, owning the worktree it's in.
   */
  paths: { key: string; what: string; how: 'tree' | 'desk' | 'cwd' }[];
  branches: Map<string, string>;
  /** Live workers' Claude sessions: a scratchpad worktree made in one of them is that worker's. */
  sessions: Map<string, string>;
}

/** CleanBot's own desk: what he's asked (the names of rows to delete) is never a reason to keep them. */
const CLEANBOT_DESK = 'station-cleanbot';

/** The Claude session a scratchpad worktree was made in: <tmp>/claude/<project>/<session>/scratchpad/…. */
function scratchpadSession(tmp: string, abs: string): string | undefined {
  const rel = path.relative(tmp, abs).split(path.sep);
  return rel[0] === 'claude' && rel.length > 3 && rel[3] === 'scratchpad' ? rel[2].toLowerCase() : undefined;
}

function ownerOf(owners: Owners, abs: string | undefined, branch: string | undefined, tmp?: string): string | undefined {
  if (abs) {
    if (owners.unlocatedTerminals) return 'an open console has an unknown current folder: close it before deleting worktrees';
    const k = key(abs);
    for (const p of owners.paths) {
      if (p.how === 'tree' ? p.key === k : p.how === 'desk' ? inside(p.key, k) : inside(k, p.key)) return p.what;
    }
    const session = tmp ? scratchpadSession(tmp, real(abs)) : undefined;
    const who = session && owners.sessions.get(session);
    if (who) return `a scratch copy ${who}'s Claude session made, which it may still be using: send ${who} home first`;
  }
  return branch ? owners.branches.get(branch) : undefined;
}

/**
 * Every floor's saved workers (.agent-office/workers.json, awake or asleep) and uncleared meetings, read
 * afresh each time: a worker hired a moment ago is saved as it's hired. With the office's own view,
 * every floor it has and the folders its terminals are in.
 */
export function readOwners(floorDirs: string[], view: OfficeView | undefined): Owners {
  const owners: Owners = { paths: [], branches: new Map(), sessions: new Map(), unlocatedTerminals: view?.unlocatedTerminals };
  const dirs = floorsOf(floorDirs, view);
  const many = dirs.length > 1;
  for (const dir of dirs) {
    const on = many ? ` on the ${path.basename(dir)} floor` : '';
    const saved = readJson(path.join(dir, '.agent-office', 'workers.json'));
    for (const w of Array.isArray(saved) ? (saved as SavedWorker[]) : []) {
      if (!w || typeof w !== 'object') continue;
      const name = typeof w.name === 'string' ? w.name : 'a worker';
      const who = `${name}${typeof w.deskId === 'string' ? ` (${w.deskId}${on})` : on}`;
      const what = `${who}'s: send ${name} home from the office instead`;
      if (typeof w.sessionId === 'string' && w.sessionId) owners.sessions.set(w.sessionId.toLowerCase(), who);
      if (typeof w.worktree?.path === 'string') owners.paths.push({ key: key(path.resolve(dir, w.worktree.path)), what, how: 'tree' });
      if (typeof w.worktree?.branch === 'string') owners.branches.set(w.worktree.branch, what);
      // A desk's worktrees in every repository are its worker's, and so is anything in the desk's folder.
      if (typeof w.workspace?.path === 'string') owners.paths.push({ key: key(path.resolve(dir, w.workspace.path)), what, how: 'desk' });
      for (const r of Array.isArray(w.workspace?.repositories) ? w.workspace.repositories : []) {
        if (typeof r?.path === 'string') owners.paths.push({ key: key(path.resolve(dir, r.path)), what, how: 'tree' });
        if (typeof r?.branch === 'string') owners.branches.set(r.branch, what);
      }
    }
    const meetings = readJson(path.join(dir, '.agent-office', 'meetings.json')) as { current?: unknown; past?: unknown } | undefined;
    for (const m of [meetings?.current, ...(Array.isArray(meetings?.past) ? meetings.past : [])] as { worktree?: { path?: unknown; branch?: unknown }; cleared?: boolean }[]) {
      if (!m?.worktree || m.cleared) continue;
      const what = `the meeting room's${on}: clear the meeting room instead`;
      if (typeof m.worktree.path === 'string') owners.paths.push({ key: key(path.resolve(dir, m.worktree.path)), what, how: 'tree' });
      if (typeof m.worktree.branch === 'string') owners.branches.set(m.worktree.branch, what);
    }
  }
  for (const b of view?.busy ?? []) if (typeof b?.path === 'string' && typeof b.what === 'string') owners.paths.push({ key: key(b.path), what: `${b.what} is working in it: close it or send the worker home first`, how: 'cwd' });
  return owners;
}

/** Each floor once: the ones given and the ones the office has. */
function floorsOf(floorDirs: string[], view: OfficeView | undefined): string[] {
  const dirs = new Map<string, string>();
  for (const d of [...floorDirs, ...(view?.floors.map((f) => f.dir) ?? [])]) if (d) dirs.set(key(d), d);
  return [...dirs.values()];
}

const text = (...parts: unknown[]) => parts.filter((p): p is string => typeof p === 'string' && !!p.trim()).join('\n');

/**
 * What the agents still need, read afresh from every floor's files: each live worker's request and
 * task (the PR agent and the VP working a PR, a worker told to carry on someone's branch), and every
 * task waiting or running on the queue (the fix tasks the PR agent and the VP queue for a PR among
 * them). CleanBot's own request isn't one: it names the rows the person wants gone.
 */
export function readNeeds(floorDirs: string[], view: OfficeView | undefined): Need[] {
  const needs: Need[] = [];
  const dirs = floorsOf(floorDirs, view);
  const many = dirs.length > 1;
  for (const dir of dirs) {
    const on = many ? ` on the ${path.basename(dir)} floor` : '';
    const saved = readJson(path.join(dir, '.agent-office', 'workers.json'));
    for (const w of Array.isArray(saved) ? (saved as SavedWorker[]) : []) {
      if (!w || typeof w !== 'object' || w.deskId === CLEANBOT_DESK) continue;
      const t = text(w.title, w.prompt, w.ask?.first, w.ask?.latest, w.task?.name, w.task?.summary);
      if (!t) continue;
      const name = typeof w.name === 'string' ? w.name : 'a worker';
      const desk = typeof w.deskId === 'string' ? w.deskId : '';
      const who = desk === 'station-pulls' ? `the PR agent${on}` : desk === 'station-vp' ? `the VP${on}` : `${name}${desk ? ` (${desk}${on})` : on}`;
      needs.push({ what: `${who} is working on it: wait until it's done, or send ${desk.startsWith('station-') ? 'it' : name} home`, text: t });
    }
    const queue = readJson(path.join(dir, '.agent-office', 'queue.json')) as { tasks?: unknown } | undefined;
    for (const t of Array.isArray(queue?.tasks) ? (queue.tasks as Record<string, unknown>[]) : []) {
      if (!t || (t.status !== 'queued' && t.status !== 'running')) continue;
      const body = text(t.title, t.prompt);
      if (!body) continue;
      const title = typeof t.title === 'string' ? t.title.slice(0, 60) : '';
      const by = typeof t.addedBy === 'string' ? ` (queued by ${t.addedBy})` : '';
      needs.push({ what: `task ${String(t.id)} "${title}"${by}${on} is ${t.status === 'running' ? 'running' : 'waiting'} and names it: let it finish, or take it off the queue`, text: body, ...(typeof t.repo === 'string' ? { repo: t.repo } : {}) });
    }
  }
  return needs;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The need that names a row: its branch, its worktree's folder name, or its PR's number. */
export function neededBy(needs: Need[], row: { branch?: string; worktree?: { path: string; kind: string }; pr?: { number: number } }, github?: string): Need | undefined {
  const pats: RegExp[] = [];
  if (row.branch) pats.push(new RegExp(`(^|[^\\w./-])${escapeRe(row.branch)}($|[^\\w./-]|\\.(?!\\w))`, 'i'));
  // An office worktree's folder is its seat (nibble-c2af): "carry on in nibble-c2af" names it.
  const seat = row.worktree && row.worktree.kind !== 'other' ? row.worktree.path.split('/').pop() : undefined;
  if (seat && /^[\w-]{4,}$/.test(seat) && /\d/.test(seat)) pats.push(new RegExp(`(^|[^\\w-])${escapeRe(seat)}($|[^\\w-])`, 'i'));
  const pr = row.pr ? new RegExp(`(#|\\bPR\\s*#?|\\bpull request\\s*#?|/pull/)${row.pr.number}(?!\\d)`, 'i') : undefined;
  for (const n of needs) {
    if (pats.some((p) => p.test(n.text))) return n;
    // A task that says which repository it's for only names this one's PRs when that's this repository.
    if (pr && pr.test(n.text) && (!n.repo || !github || n.repo.toLowerCase() === github.toLowerCase())) return n;
  }
  return undefined;
}

/** The floors the office keeps in floors.json, for when the office itself can't be asked. */
function savedFloors(floor: string): string[] {
  const dirs: string[] = [];
  const home = path.resolve(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), 'agent-office'));
  for (const file of [path.join(floor, '.agent-office', 'floors.json'), path.join(home, '.agent-office', 'floors.json')]) {
    const saved = readJson(file);
    for (const f of Array.isArray(saved) ? (saved as { dir?: unknown }[]) : []) if (typeof f?.dir === 'string') dirs.push(f.dir);
  }
  return dirs;
}

/** The running office, from inside one of its terminals: the same env office-queue uses. */
export async function askOffice(env: NodeJS.ProcessEnv = process.env): Promise<OfficeView | undefined> {
  const { AGENT_OFFICE_HOOK_URL: url, AGENT_OFFICE_WORKER_ID: worker, AGENT_OFFICE_HOOK_TOKEN: token } = env;
  if (!url || !worker || !token) return undefined;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/office/cleanbot?view=office&worker=${encodeURIComponent(worker)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as OfficeView;
    return Array.isArray(body?.floors) && Array.isArray(body?.busy) ? body : undefined;
  } catch {
    return undefined;
  }
}

// ---- Pull requests -------------------------------------------------------------------------------

const PR_JQ = '.[] | {number, state, merged: (.merged_at != null), head: .head.ref, repo: (.head.repo.full_name // ""), url: .html_url}';
const PR_PAGES = 5;

/** origin's pull requests over GitHub's REST API, whose quota is separate from the boards' GraphQL one. */
export const githubPulls: PullLister = async (repo, cwd) => {
  const list: PullRef[] = [];
  for (let page = 1; page <= PR_PAGES; page++) {
    const out = await gh(['api', '--method', 'GET', `repos/${repo}/pulls`, '-f', 'state=all', '-f', 'per_page=100', '-f', `page=${page}`, '--jq', PR_JQ], cwd, 60_000);
    const lines = out.split('\n').filter((l) => l.trim());
    for (const l of lines) {
      const p = JSON.parse(l) as { number: number; state: string; merged: boolean; head: string; repo: string; url: string };
      // Another fork's branch of the same name isn't this one (a deleted fork says nothing: keep it, to be safe).
      if (p.repo && p.repo.toLowerCase() !== repo.toLowerCase()) continue;
      list.push({ number: p.number, state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED', head: p.head, url: p.url });
    }
    if (lines.length < 100) break;
  }
  return list;
};

// ---- One repository ------------------------------------------------------------------------------

interface Repo {
  report: RepoReport;
  dir: string;
  /** Key of the repository's own .agent-office/worktrees. */
  worktreesHome: string;
  pulls: PullRef[];
  origin: Set<string>;
  hasOrigin: boolean;
}

interface Listed {
  abs: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

interface Candidate {
  repo: Repo;
  branch?: string;
  local: boolean;
  tip?: string;
  date?: string;
  worktree?: {
    abs: string;
    kind: NonNullable<PruneRow['worktree']>['kind'];
    exists: boolean;
    stray: boolean;
    detached: boolean;
    locked: boolean;
    head?: string;
    desk?: string;
  };
}

function worktreeList(out: string): Listed[] {
  const list: Listed[] = [];
  let cur: Listed | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { abs: path.resolve(line.slice('worktree '.length)), detached: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return list;
}

/** owner/name of a checkout's origin on GitHub, as configured (not as insteadOf rewrites it). */
async function githubOf(dir: string): Promise<string | undefined> {
  const url = await gitMaybe(['config', '--get', 'remote.origin.url'], dir);
  return url && /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
}

/** A Claude scratchpad worktree: in the temp folder, under a "scratchpad" folder. */
function isScratchpad(tmpKey: string, absKey: string): boolean {
  return inside(tmpKey, absKey) && absKey !== tmpKey && path.relative(tmpKey, absKey).split(path.sep).includes('scratchpad');
}

async function openRepo(floor: string, rel: string, name: string, opts: FloorPruneOptions, notes: string[]): Promise<Repo> {
  const dir = path.resolve(floor, rel);
  const report: RepoReport = { path: rel, name, fetch: 'skipped', prs: 'none', alwaysKeep: keepList(floor, rel) };
  const repo: Repo = { report, dir, worktreesHome: key(path.join(dir, WORKTREES_DIR)), pulls: [], origin: new Set(), hasOrigin: false };
  report.current = await gitMaybe(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
  repo.hasOrigin = (await gitMaybe(['remote'], dir))?.split('\n').includes('origin') ?? false;
  if (!repo.hasOrigin) report.fetch = 'no-origin';
  else if (opts.fetch !== false) {
    // So "its commits are on GitHub" is true now, not as of the last fetch; a branch deleted there is gone here too.
    const r = await run(['fetch', '--prune', '--quiet', 'origin'], dir, { timeout: 120_000 }).catch((err: Error) => ({ out: '', err: err.message, code: -1 }));
    report.fetch = r.code === 0 ? 'ok' : 'failed';
    if (r.code !== 0) {
      report.fetchError = gitError({ stderr: r.err }) || 'git fetch failed';
      notes.push(`${rel}: git fetch --prune origin failed (${report.fetchError}), so whether commits are on GitHub is unknown: branches that rely on it are kept`);
    }
  }
  report.defaultBranch = (await gitMaybe(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], dir))?.replace(/^origin\//, '');
  if (repo.hasOrigin) {
    for (const r of (await gitMaybe(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'], dir))?.split('\n') ?? []) {
      const b = r.replace(/^refs\/remotes\/origin\//, '');
      if (b && b !== 'HEAD' && b !== r) repo.origin.add(b);
    }
  }
  report.github = await githubOf(dir);
  if (report.github) {
    try {
      repo.pulls = await (opts.pulls ?? githubPulls)(report.github, dir);
      report.prs = 'ok';
    } catch (err) {
      report.prs = 'unknown';
      report.prError = (err as Error).message;
      notes.push(`${rel}: couldn't ask GitHub for its pull requests (${report.prError}): branches that may have one are kept`);
    }
  }
  return repo;
}

/** Every row of one repository: its worktrees (registered and stray), its branches, and origin's office/* branches. */
async function candidates(floor: string, repo: Repo, tmpKey: string): Promise<Candidate[]> {
  const { dir } = repo;
  const out: Candidate[] = [];
  const listed = worktreeList(await git(['worktree', 'list', '--porcelain'], dir));
  const desksHome = key(path.join(floor, WORKSPACES_DIR));
  // The desks' own record of their worktrees (workspace.json), to tell whose desk one is and to find a
  // half-deleted one. `mine`: it's this repository's worktree.
  const deskOf = new Map<string, { desk: string; abs: string; branch?: string; mine: boolean }>();
  for (const desk of existsSync(path.join(floor, WORKSPACES_DIR)) ? readdirSync(path.join(floor, WORKSPACES_DIR)) : []) {
    const ws = readJson(path.join(floor, WORKSPACES_DIR, desk, 'workspace.json')) as { repositories?: { repository?: unknown; path?: unknown; branch?: unknown }[] } | undefined;
    for (const r of Array.isArray(ws?.repositories) ? ws.repositories : []) {
      if (typeof r?.path !== 'string') continue;
      const abs = path.resolve(floor, r.path);
      deskOf.set(key(abs), { desk, abs, branch: typeof r.branch === 'string' ? r.branch : undefined, mine: r.repository === repo.report.path });
    }
  }
  const branches = new Map<string, { tip: string; date: string }>();
  for (const line of (await git(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/heads/'], dir)).split('\n')) {
    const [name, tip, date] = line.split('\0');
    if (name) branches.set(name, { tip, date });
  }
  const taken = new Set<string>();
  const registered = new Set<string>();
  for (const [i, w] of listed.entries()) {
    const k = key(w.abs);
    registered.add(k);
    // The first is the main checkout: never a row.
    if (i === 0) continue;
    const kind = inside(repo.worktreesHome, k) && k !== repo.worktreesHome ? 'office' : inside(desksHome, k) && k !== desksHome ? 'desk' : isScratchpad(tmpKey, k) ? 'scratchpad' : 'other';
    const b = w.branch;
    if (b) taken.add(b);
    out.push({
      repo,
      branch: b,
      local: !!b && branches.has(b),
      tip: b ? branches.get(b)?.tip : w.head,
      date: b ? branches.get(b)?.date : undefined,
      worktree: { abs: w.abs, kind, exists: !w.prunable && existsSync(w.abs), stray: false, detached: w.detached || !b, locked: w.locked, head: w.head, desk: kind === 'desk' ? deskOf.get(k)?.desk ?? path.relative(path.join(floor, WORKSPACES_DIR), w.abs).split(path.sep)[0] : undefined },
    });
  }
  // Folders git doesn't list any more: what a `git worktree remove` that failed partway leaves behind.
  const strays: { abs: string; branch?: string; kind: 'office' | 'desk'; desk?: string }[] = [];
  const home = path.join(dir, WORKTREES_DIR);
  for (const n of existsSync(home) ? readdirSync(home) : []) {
    const abs = path.join(home, n);
    if (!registered.has(key(abs)) && isDir(abs)) strays.push({ abs, branch: `${BRANCH_PREFIX}${n}`, kind: 'office' });
  }
  // A desk's folder for this repository that git doesn't list: the desk's metadata stays, only the folder is a row.
  for (const [k, d] of deskOf) if (d.mine && !registered.has(k) && inside(desksHome, k) && isDir(d.abs)) strays.push({ abs: d.abs, branch: d.branch, kind: 'desk', desk: d.desk });
  for (const s of strays) {
    const b = s.branch && branches.has(s.branch) && !taken.has(s.branch) ? s.branch : undefined;
    if (b) taken.add(b);
    out.push({ repo, branch: b, local: !!b, tip: b ? branches.get(b)?.tip : undefined, date: b ? branches.get(b)?.date : undefined, worktree: { abs: s.abs, kind: s.kind, exists: true, stray: true, detached: !b, locked: false, desk: s.desk } });
  }
  for (const [b, { tip, date }] of branches) if (!taken.has(b)) out.push({ repo, branch: b, local: true, tip, date });
  // origin's office/* branches with no local copy: deleted only with --remote.
  for (const b of repo.origin) if (b.startsWith(BRANCH_PREFIX) && !branches.has(b)) out.push({ repo, branch: b, local: false });
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- What a row holds ----------------------------------------------------------------------------

/** Ignored files that are work (a .env, notes, scratch output), not dependencies or build output. */
function workIgnored(paths: string[]): string[] {
  return paths.filter((p) => {
    const parts = p.replace(/\/+$/, '').split('/');
    return !parts.some((s) => BUILD_DIRS.has(s)) && !JUNK_FILE.test(p.replace(/\/+$/, ''));
  });
}

/** `git status -z` records: [xy, path]. */
function statusRecords(out: string): [string, string][] {
  const f = out.split('\0');
  const recs: [string, string][] = [];
  for (let i = 0; i < f.length; ) {
    const rec = f[i++];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    // A rename's old name comes next.
    if (/[RC]/.test(xy)) i++;
    recs.push([xy, rec.slice(3)]);
  }
  return recs;
}

/** Uncommitted changes and the ignored files that aren't build output, in a registered worktree. */
async function worktreeFiles(abs: string): Promise<{ uncommitted: number; ignored: string[] }> {
  const out = await gitRaw(['-c', 'core.longpaths=true', 'status', '--porcelain=v1', '-z', '-unormal', '--ignored=matching'], abs, { timeout: 120_000 });
  const recs = statusRecords(out);
  return { uncommitted: recs.filter(([xy]) => xy !== '!!').length, ignored: workIgnored(recs.filter(([xy]) => xy === '!!').map(([, p]) => p)) };
}

/**
 * What a half-deleted worktree folder holds, read without touching any real index: a throwaway index
 * (GIT_INDEX_FILE) gets `branch`'s tree (or nothing when there's no branch), and `git status` compares
 * the folder with it. `edits` are every path status reports as changed (a second column of M, T or A)
 * or untracked (??): a file whose content, at that path, the branch doesn't have, which deleting the
 * folder would lose. " D" is a file the half-delete already took. Whether a file's content happens to
 * match some blob elsewhere in the object database is no reason to drop it: that keeps neither the path
 * nor the fact that it was this worktree's, so it isn't looked at.
 */
export async function strayEdits(repoDir: string, folder: string, branch?: string): Promise<{ edits: string[]; ignored: string[] }> {
  const gitDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoDir);
  const tmp = path.join(os.tmpdir(), `agent-office-prune-${process.pid}-${randomBytes(6).toString('hex')}`);
  const index = `${tmp}.index`;
  const excludes = `${tmp}.exclude`;
  const inFolder = (args: string[]) =>
    gitRaw(['--git-dir', gitDir, '--work-tree', '.', '-c', 'core.longpaths=true', '-c', `core.excludesFile=${slash(excludes)}`, ...args], folder, { env: { GIT_INDEX_FILE: index }, timeout: 180_000 });
  try {
    // Its own .gitignore may be one of the files the half-delete took: use the branch's, and never count build output.
    const ignore = branch ? await run(['show', `refs/heads/${branch}:.gitignore`], repoDir) : undefined;
    await writeFile(excludes, `${ignore?.code === 0 ? ignore.out : ''}\n${[...BUILD_DIRS].map((d) => `${d}/`).join('\n')}\n`);
    await inFolder(branch ? ['read-tree', `refs/heads/${branch}`] : ['read-tree', '--empty']);
    const recs = statusRecords(await inFolder(['status', '--porcelain=v1', '-z', '-uall', '--ignored=matching']));
    // Everything status reports as changed or untracked against the branch's tree is work: nothing is
    // dropped for having content that some other blob in the repository happens to share.
    const edits = recs.filter(([xy]) => xy === '??' || (xy[1] !== ' ' && xy[1] !== 'D' && xy[1] !== '?' && xy[1] !== '!')).map(([, p]) => p);
    const ignored = workIgnored(recs.filter(([xy]) => xy === '!!').map(([, p]) => p));
    return { edits, ignored };
  } finally {
    await unlink(index).catch(() => undefined);
    await unlink(excludes).catch(() => undefined);
  }
}

/** When anything in a folder last changed, leaving out node_modules and .git. */
async function lastChange(dir: string): Promise<{ at: number; partial: boolean }> {
  let at = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    at = Math.max(at, (await lstat(d).catch(() => undefined))?.mtimeMs ?? 0);
    const files: string[] = [];
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (++seen > WALK_MAX) return { at, partial: true };
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(p);
      else files.push(p);
    }
    for (const s of await Promise.all(files.map((f) => lstat(f).catch(() => undefined)))) at = Math.max(at, s?.mtimeMs ?? 0);
  }
  return { at, partial: false };
}

async function mtime(file: string): Promise<number | undefined> {
  return (await stat(file).catch(() => undefined))?.mtimeMs;
}

/** A registered worktree's admin folder in the repository's .git, from the .git file in it. */
async function adminDir(abs: string): Promise<string | undefined> {
  const text = await readFile(path.join(abs, '.git'), 'utf8').catch(() => undefined);
  const m = text && /^gitdir:\s*(.+)$/m.exec(text);
  return m ? path.resolve(abs, m[1].trim()) : undefined;
}

/** A branch's reflog: when it was made (its first entry) and last moved (its last). */
async function reflogTimes(repoDir: string, branch: string): Promise<{ first?: number; last?: number }> {
  const file = await gitMaybe(['rev-parse', '--git-path', `logs/refs/heads/${branch}`], repoDir);
  const text = file && (await readFile(path.resolve(repoDir, file), 'utf8').catch(() => undefined));
  if (!text) return {};
  const times = text.split('\n').map((l) => /\s(\d{9,})\s[+-]\d{4}\t/.exec(l)?.[1]).filter(Boolean).map((s) => Number(s) * 1000);
  return { first: times[0], last: times[times.length - 1] };
}

/** Claude Code's name for a project folder under ~/.claude/projects. */
function claudeProject(abs: string): string {
  return abs.replace(/[^A-Za-z0-9]/g, '-');
}

/** When a Claude session last wrote its transcript for this folder (or for the session a scratchpad is from). */
async function claudeActivity(abs: string, projects: string, tmp: string): Promise<number | undefined> {
  const rel = path.relative(tmp, abs).split(path.sep);
  // <tmp>/claude/<project>/<session>/scratchpad/…: that session's transcript.
  if (rel[0] === 'claude' && rel.length > 3 && rel[3] === 'scratchpad') return mtime(path.join(projects, rel[1], `${rel[2]}.jsonl`));
  const dir = path.join(projects, claudeProject(abs));
  const files = await readdir(dir).catch(() => [] as string[]);
  let at: number | undefined;
  for (const f of files) {
    const m = await mtime(path.join(dir, f));
    if (m !== undefined && (at === undefined || m > at)) at = m;
  }
  return at;
}

async function count(args: string[], dir: string): Promise<number> {
  return Number(await git(['rev-list', '--count', ...args], dir));
}

// ---- The verdict ---------------------------------------------------------------------------------

interface Ctx {
  floor: string;
  owners: Owners;
  now: number;
  recentMs: number;
  tmp: string;
  tmpKey: string;
  projects: string;
  /** Where this command runs, and the office's own code: never deleted from under them. */
  self: { key: string; what: string }[];
  /** What the agents' requests and the queue's tasks name (readNeeds). */
  needs: Need[];
}

/** Everything about one row: re-run from scratch right before it's deleted. */
async function judge(c: Candidate, ctx: Ctx): Promise<Omit<PruneRow, 'n'>> {
  const { repo, branch: b, worktree: wt } = c;
  const report = repo.report;
  const officeBranch = !!b && b.startsWith(BRANCH_PREFIX);
  const officeTree = !!wt && wt.kind !== 'other';
  const onOrigin = !!b && repo.origin.has(b);
  const row: Omit<PruneRow, 'n'> = {
    repo: report.path,
    name: b ?? shown(ctx.floor, wt!.abs),
    branch: b,
    local: c.local,
    origin: onOrigin,
    verdict: 'safe',
    why: '',
    removes: [],
    discardable: false,
    suggest: 'keep',
  };
  if (wt) row.worktree = { path: shown(ctx.floor, wt.abs), kind: wt.kind, exists: wt.exists, ...(wt.stray ? { stray: true } : {}), ...(wt.detached ? { detached: true } : {}), ...(wt.locked ? { locked: true } : {}), ...(wt.desk ? { desk: wt.desk } : {}) };
  const pr = b ? pullForBranch(repo.pulls.map((p) => ({ number: p.number, url: p.url, state: p.state, headRefName: p.head })), b) : undefined;
  if (pr) row.pr = pr;
  const tip = c.tip ?? wt?.head;
  if (c.date) row.lastCommit = c.date;
  else if (tip) row.lastCommit = await gitMaybe(['log', '-1', '--format=%cI', tip], repo.dir);
  if (officeTree) row.removes.push(wt!.stray ? 'folder' : 'worktree');
  // Git won't delete a branch a worktree outside the office's folders has checked out, and neither do we.
  if (officeBranch && c.local && (!wt || officeTree)) row.removes.push('branch');
  if (officeBranch && onOrigin) row.removes.push('origin');
  const set = (verdict: Verdict, why: string) => {
    row.verdict = verdict;
    row.why = why;
    row.discardable = DISCARDABLE.has(verdict);
    return row;
  };

  // Not the office's: listed, never deleted.
  if (b && (PROTECTED_BRANCHES.has(b) || b === report.current || b === report.defaultBranch)) {
    row.removes = [];
    return set('protected', b === report.current ? 'checked out in the main checkout' : b === report.defaultBranch ? "the repository's default branch" : `${b} is always kept`);
  }
  if (b?.startsWith(PR_ASSETS)) {
    row.removes = [];
    return set('protected', 'hosts PR screenshots: pull requests link to its images');
  }
  if (!officeBranch && !officeTree) {
    row.removes = [];
    return set('not-office', wt ? `a worktree the office didn't make (${row.worktree!.path})` : "not an office/* branch");
  }
  if (officeBranch && wt && !officeTree) {
    row.removes = [];
    return set('protected', `checked out at ${row.worktree!.path}, a folder the office didn't make`);
  }

  // A live worker's (its scratch copies too), a meeting's, a terminal's, or where this very command runs.
  const owner = ownerOf(ctx.owners, wt?.abs, b, ctx.tmp);
  if (owner) return set('worker', owner);
  if (wt) {
    const k = key(wt.abs);
    const self = ctx.self.find((s) => inside(k, s.key));
    if (self) return set('protected', self.what);
  }
  // What the PR agent and the VP work from: an open PR's branch, and whatever an agent's request or a
  // queued task names (a PR being fixed, a branch to carry on).
  if (pr?.state === 'OPEN') return set('open-pr', `PR #${pr.number} is open: the PR agent and the VP work from its branch`);
  const need = neededBy(ctx.needs, row, report.github);
  if (need) return set('needed', need.what);
  if (wt?.locked) return set('protected', 'locked with git worktree lock: unlock it first');

  // Just made: maybe a worker being hired this moment, whose workers.json entry isn't saved yet.
  const created: number[] = [];
  const touched: { at: number; what: string }[] = [];
  let admin: string | undefined;
  if (wt?.exists) {
    if (wt.stray) {
      const s = await stat(wt.abs).catch(() => undefined);
      if (s) created.push(s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs);
    } else {
      // `git worktree add` writes commondir once; HEAD moves with every checkout and commit.
      admin = await adminDir(wt.abs);
      const made = admin ? await mtime(path.join(admin, 'commondir')) : undefined;
      if (made) created.push(made);
      const head = admin ? await mtime(path.join(admin, 'HEAD')) : undefined;
      if (head) touched.push({ at: head, what: 'its HEAD moved' });
    }
  }
  if (b && c.local) {
    const log = await reflogTimes(repo.dir, b);
    if (log.first) created.push(log.first);
    if (log.last) touched.push({ at: log.last, what: 'its branch moved' });
  }
  const born = Math.max(0, ...created);
  if (born && ctx.now - born < NEW_MS) return set('new', `made ${ago(ctx.now - born)}: it may be a worker being hired, so it's never deleted this young`);

  // What deleting it would lose.
  const holds: NonNullable<PruneRow['holds']> = { uncommitted: 0, unpushed: 0, ignored: [], edits: 0 };
  const lost: string[] = [];
  const unknown: string[] = [];
  try {
    if (wt?.exists && wt.stray) {
      const s = await strayEdits(repo.dir, wt.abs, b);
      holds.edits = s.edits.length;
      holds.ignored = s.ignored;
    } else if (wt?.exists) {
      const f = await worktreeFiles(wt.abs);
      holds.uncommitted = f.uncommitted;
      holds.ignored = f.ignored;
    }
    // Commits in neither the main checkout nor on GitHub (freshly fetched) are only here.
    const safe = ['HEAD', ...(repo.hasOrigin ? ['--remotes=origin'] : [])];
    if (tip && (c.local || wt)) {
      holds.unpushed = await count([tip, '--not', ...safe], repo.dir);
      if (!holds.unpushed && repo.hasOrigin && report.fetch !== 'ok') {
        const local = await count([tip, '--not', 'HEAD'], repo.dir);
        if (local) unknown.push(`git fetch failed, so whether its ${plural(local, 'commit')} are still on GitHub is unknown`);
      }
    }
    // Pushed, but in no open or merged PR (rewritten copies count, as the PR board counts them): the
    // PR board's unshipped work, which it offers to carry into a PR. Deleting the branch takes it off.
    const base = report.current ?? report.defaultBranch;
    if (officeBranch && tip && (c.local || wt) && !holds.unpushed && base) {
      let missing = await missingCommits(repo.dir, base, tip);
      const remoteBase = `refs/remotes/origin/${base}`;
      if (missing && repo.hasOrigin && (await gitMaybe(['rev-parse', '--verify', '--quiet', remoteBase], repo.dir))) missing = Math.min(missing, await missingCommits(repo.dir, remoteBase, tip).catch(() => missing));
      if (missing) holds.unshipped = missing;
    }
  } catch (err) {
    return set('unknown', `git couldn't say what it holds: ${(err as Error).message}`);
  }
  if (holds.uncommitted) lost.push(plural(holds.uncommitted, 'uncommitted change'));
  if (holds.edits) lost.push(`${plural(holds.edits, 'changed or new file')} not on its branch`);
  if (holds.unpushed) lost.push(plural(holds.unpushed, 'unpushed commit'));
  if (holds.unshipped) lost.push(`${plural(holds.unshipped, 'commit')} no open or merged PR carries (unshipped work on the PR board)`);
  if (holds.ignored.length) lost.push(`ignored files: ${holds.ignored.slice(0, IGNORED_LISTED).join(', ')}${holds.ignored.length > IGNORED_LISTED ? ` and ${holds.ignored.length - IGNORED_LISTED} more` : ''}`);
  if (wt || c.local) row.holds = holds;

  // origin's copy goes (with --remote) only when its PR is merged, or closed with nothing that isn't elsewhere.
  const remoteOnly = !c.local && !wt;
  if (row.removes.includes('origin')) {
    let stays: { verdict: Verdict; why: string } | undefined;
    if (report.fetch !== 'ok') stays = { verdict: 'unknown', why: 'git fetch failed' };
    else if (!pr) stays = { verdict: report.prs === 'unknown' ? 'unknown' : 'work', why: report.prs === 'unknown' ? "GitHub couldn't be asked about its PR" : 'it has no pull request' };
    else if (pr.state === 'CLOSED') {
      const only = await count([`refs/remotes/origin/${b}`, '--not', 'HEAD', `--exclude=refs/remotes/origin/${b}`, '--remotes=origin'], repo.dir).catch(() => -1);
      if (only !== 0) stays = only > 0 ? { verdict: 'work', why: `PR #${pr.number} was closed unmerged and ${plural(only, 'commit')} of it are only on GitHub` } : { verdict: 'unknown', why: "git couldn't say what it holds" };
    }
    if (stays) row.originStays = stays.why;
    if (stays && remoteOnly) {
      row.removes = [];
      return set(stays.verdict, `only on GitHub, and it stays: ${stays.why}`);
    }
  }
  if (remoteOnly) return set('safe', `only on GitHub (--remote deletes it there); PR #${pr!.number} ${prState(pr)}`);
  if (report.prs === 'unknown' && officeBranch && (onOrigin || report.fetch !== 'ok')) unknown.push("GitHub couldn't be asked whether it has an open PR");

  // In use lately: a terminal, a dev server or a Claude session the office doesn't track.
  if (wt?.exists) {
    const walk = await lastChange(wt.abs);
    if (walk.at) {
      row.changed = new Date(walk.at).toISOString();
      touched.push({ at: walk.at, what: 'files in it changed' });
    }
    if (walk.partial) unknown.push('too many files to check them all for recent changes');
  }
  if (wt) {
    const claude = await claudeActivity(wt.abs, ctx.projects, ctx.tmp);
    if (claude) touched.push({ at: claude, what: 'a Claude session there wrote' });
  }
  const recent = touched.filter((t) => ctx.now - t.at < ctx.recentMs).sort((a, b) => b.at - a.at);

  if (lost.length) return set('work', `holds ${lost.join(', ')}${recent.length ? `; ${recent[0].what} ${ago(ctx.now - recent[0].at)}` : ''}`);
  if (unknown.length) return set('unknown', unknown.join('; '));
  if (recent.length) return set('recent', `${recent[0].what} ${ago(ctx.now - recent[0].at)}: something may still be using it`);
  const what = row.removes.includes('folder') ? 'a stray folder with nothing changed or new against its branch' : wt ? (wt.exists ? 'clean' : 'its folder is already gone') : 'branch only, its worktree is gone';
  return set('safe', `${what}, nothing unpushed${pr ? `; PR #${pr.number} ${prState(pr)}` : ''}`);
}

const prState = (pr: PullRequestRef | undefined) => (pr?.state ?? 'unknown').toLowerCase();

/**
 * CleanBot's suggestion for a judged row: delete the safe ones nobody's pinned; a look (the person
 * decides, seeing what it holds) for ones that hold work but have sat untouched LOOK_MS or more; keep
 * everything else. Never "delete" for anything that isn't safe.
 */
export function suggestFor(row: Pick<PruneRow, 'verdict' | 'kept' | 'lastCommit' | 'changed'>, now: number): Suggestion {
  if (row.kept) return 'keep';
  if (row.verdict === 'safe') return 'delete';
  if (row.verdict !== 'work' && row.verdict !== 'unknown') return 'keep';
  const last = Math.max(Date.parse(row.lastCommit ?? '') || 0, Date.parse(row.changed ?? '') || 0);
  return last && now - last >= LOOK_MS ? 'look' : 'keep';
}

// ---- Always keep ---------------------------------------------------------------------------------

function keepFile(floor: string): string {
  return path.join(floor, '.agent-office', KEEP_FILE);
}

function keepList(floor: string, repo: string): string[] {
  const saved = readJson(keepFile(floor)) as Record<string, unknown> | undefined;
  const list = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved[repo] : undefined;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
}

function saveKeep(floor: string, repo: string, add: string[], drop: string[]) {
  const saved = (readJson(keepFile(floor)) as Record<string, string[]> | undefined) ?? {};
  const all = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const list = new Set(keepList(floor, repo));
  for (const n of add) list.add(n);
  for (const n of drop) list.delete(n);
  if (list.size) all[repo] = [...list].sort();
  else delete all[repo];
  mkdirSync(path.dirname(keepFile(floor)), { recursive: true });
  writeFileSync(keepFile(floor), JSON.stringify(all, null, 2), { mode: 0o600 });
}

/**
 * Adds names to (or, with `forget`, takes them off) the floor's always-keep list: in the repository
 * named, or in every repository of the floor when none is. Returns the lists as they now stand.
 */
export async function pinRows(floorDir: string, names: string[], opts: { repo?: string; forget?: boolean } = {}): Promise<{ repo: string; alwaysKeep: string[] }[]> {
  const floor = real(floorDir);
  const found = await workspaceRepositories(floor);
  let repos = found.repositories.filter((r) => !r.error);
  if (opts.repo !== undefined) {
    const want = slash(opts.repo).replace(/^\.\/|\/+$/g, '') || '.';
    repos = repos.filter((r) => r.path === want || r.name === want);
    if (!repos.length) throw new Error(`No repository ${opts.repo} on this floor (there's ${found.repositories.map((r) => r.path).join(', ') || 'none'})`);
  }
  return repos.map((r) => {
    saveKeep(floor, r.path, opts.forget ? [] : names, opts.forget ? names : []);
    return { repo: r.path, alwaysKeep: keepList(floor, r.path) };
  });
}

/** A name as the command line and the table compare it: forward slashes, no trailing one, and case-insensitive on Windows. */
const norm = (s: string) => (process.platform === 'win32' ? slash(s).toLowerCase() : slash(s)).replace(/\/+$/, '');

/** A name given on the command line matches a row by its name, its branch or its worktree's path. */
function matches(row: Pick<PruneRow, 'name' | 'branch' | 'worktree'>, names: Set<string>): boolean {
  const want = new Set([...names].map(norm));
  return [row.name, row.branch, row.worktree?.path].some((n) => n !== undefined && want.has(norm(n)));
}

export interface Selection {
  rows: Set<PruneRow>;
  refused: { name: string; why: string }[];
}

/**
 * The rows the command line names (--only, --discard, --keep). A name is a branch, or a worktree's path
 * as the table shows it. On a floor of several repositories the same branch name can be in more than
 * one, so `repo:name` (app:office/foo) says which, or --repo scopes the whole run to one. A bare name
 * that's in several repositories is refused when `one` is set (--only and --discard: a yes to losing
 * the work in one numbered row is not a yes to the same-named row elsewhere), and applies to each of
 * them when it isn't (--keep: keeping more is the safe way round). Row numbers aren't taken: a row's
 * number can change between the list a person saw and the run that deletes.
 */
export function selectRows(rows: PruneRow[], names: string[], one: boolean): Selection {
  const sel: Selection = { rows: new Set(), refused: [] };
  const repos = [...new Set(rows.map((r) => r.repo))];
  const several = repos.length > 1;
  for (const name of names) {
    let hits = rows.filter((r) => matches(r, new Set([name])));
    if (!hits.length) {
      const scoped = repoScoped(name, repos);
      if (scoped) hits = rows.filter((r) => r.repo === scoped.repo && matches(r, new Set([scoped.name])));
    }
    if (!hits.length) {
      const why = /^#?\d+$/.test(name)
        ? "row numbers aren't taken, since a row's number can change between runs: name the row as the table shows it"
        : `no such row on this floor (names are branches, or worktree paths as the table shows them${several ? '; on a floor of several repositories, repo:name says which' : ''})`;
      sel.refused.push({ name, why });
      continue;
    }
    const inRepos = [...new Set(hits.map((r) => r.repo))];
    if (one && inRepos.length > 1) {
      sel.refused.push({ name, why: `${name} is in ${inRepos.length} repositories (${inRepos.join(', ')}): say which, as ${inRepos[0]}:${name}, or pass --repo ${inRepos[0]}` });
      continue;
    }
    for (const r of hits) sel.rows.add(r);
  }
  return sel;
}

/** `repo:name`, when `repo` is a repository of the floor (the longest such path wins: apps/web before apps). */
function repoScoped(name: string, repos: string[]): { repo: string; name: string } | undefined {
  for (const repo of [...repos].sort((a, b) => b.length - a.length)) {
    const prefix = `${repo}:`;
    if (name.length > prefix.length && norm(name.slice(0, prefix.length)) === norm(prefix)) return { repo, name: name.slice(prefix.length) };
  }
  return undefined;
}

// ---- Deleting ------------------------------------------------------------------------------------

async function remove(c: Candidate, row: Omit<PruneRow, 'n'>, ctx: Ctx, opts: { discard: boolean; remote: boolean; dryRun: boolean }): Promise<RunStep[]> {
  const steps: RunStep[] = [];
  const step = (what: RunStep['what'], error?: string) => {
    steps.push({ repo: row.repo, name: row.name, what, ok: !error, ...(error ? { error } : {}) });
    return !error;
  };
  const { dir } = c.repo;
  const wt = c.worktree;
  if (opts.dryRun) {
    for (const what of row.removes) if (what !== 'origin' || (opts.remote && !row.originStays)) step(what);
    return steps;
  }
  if (wt && row.removes.includes('folder')) {
    // Only ever inside a repository's or the floor's .agent-office.
    const k = key(wt.abs);
    const allowed = [key(path.join(dir, '.agent-office')), key(path.join(ctx.floor, '.agent-office'))].some((home) => inside(home, k) && home !== k);
    if (!allowed) return (step('folder', `refused: ${row.worktree!.path} isn't inside an .agent-office folder`), steps);
    try {
      // fs.rm copes with paths too long for git on Windows; retries ride out files locked for a moment.
      await rm(wt.abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (existsSync(wt.abs)) throw new Error('some files could not be deleted');
    } catch (err) {
      return (step('folder', `${(err as Error).message}: part of the folder is left, run again to see what`), steps);
    }
    await run(['worktree', 'prune'], dir).catch(() => undefined);
    step('folder');
  } else if (wt && row.removes.includes('worktree')) {
    if (!wt.exists) {
      const r = await run(['worktree', 'prune'], dir).catch((err: Error) => ({ out: '', err: err.message, code: -1 }));
      if (!step('worktree', r.code === 0 ? undefined : gitError({ stderr: r.err }))) return steps;
    } else {
      // --force only for a row the person chose to discard, having seen what it holds. Never retried.
      const r = await run(['-c', 'core.longpaths=true', 'worktree', 'remove', ...(opts.discard ? ['--force'] : []), wt.abs], dir, { timeout: 300_000 }).catch((err: Error) => ({ out: '', err: err.message, code: -1 }));
      if (r.code !== 0) {
        const left = existsSync(wt.abs) ? '; what git managed to delete is gone and the rest is left as a stray folder, run again to see it' : '';
        return (step('worktree', `${gitError({ stderr: r.err }) || 'git worktree remove failed'}${left}`), steps);
      }
      step('worktree');
    }
  }
  if (c.local && row.removes.includes('branch')) {
    const r = await run(['branch', '-D', c.branch!], dir).catch((err: Error) => ({ out: '', err: err.message, code: -1 }));
    if (!step('branch', r.code === 0 ? undefined : gitError({ stderr: r.err }))) return steps;
  }
  if (opts.remote && row.removes.includes('origin') && !row.originStays) {
    const r = await run(['push', '--quiet', 'origin', '--delete', c.branch!], dir, { timeout: 120_000 }).catch((err: Error) => ({ out: '', err: err.message, code: -1 }));
    step('origin', r.code === 0 ? undefined : gitError({ stderr: r.err }));
  }
  return steps;
}

// ---- The run -------------------------------------------------------------------------------------

/** The whole floor: every repository's rows, then (with --only) the named ones deleted. */
export async function floorPrune(opts: FloorPruneOptions): Promise<FloorPruneReport> {
  const floor = real(opts.floor);
  const now = opts.now ?? Date.now;
  const tmp = real(opts.tmp ?? os.tmpdir());
  const notes: string[] = [];
  const view = await (opts.office ?? askOffice)();
  const report: FloorPruneReport = { floor: slash(floor), at: new Date(now()).toISOString(), recentHours: (opts.recentMs ?? RECENT_MS) / 3_600_000, office: view ? 'asked' : 'not reachable', notes, repos: [], rows: [], suggested: { delete: [], remote: [], look: [] } };
  if (!view) notes.push("The running office couldn't be asked which terminals are open (this isn't an office terminal, or it's down): relied on every floor's workers.json and on recent activity");

  const found = await workspaceRepositories(floor);
  if (found.truncated) notes.push('The floor has more folders than are searched for repositories: some may be missing');
  let repos = found.repositories;
  if (opts.repo !== undefined) {
    const want = slash(opts.repo).replace(/^\.\/|\/+$/g, '') || '.';
    repos = repos.filter((r) => r.path === want || r.name === want || (want === '.' && r.path === '.'));
    if (!repos.length) throw new Error(`No repository ${opts.repo} on this floor (there's ${found.repositories.map((r) => r.path).join(', ') || 'none'})`);
  }
  const floorDirs = [floor, ...savedFloors(floor), ...repos.map((r) => path.resolve(floor, r.path))];
  const ctx: Ctx = {
    floor,
    owners: readOwners(floorDirs, view),
    now: now(),
    recentMs: opts.recentMs ?? RECENT_MS,
    tmp,
    tmpKey: key(tmp),
    projects: opts.claudeProjects ?? path.join(os.homedir(), '.claude', 'projects'),
    self: [
      { key: key(process.cwd()), what: 'this command is running from inside it' },
      ...(officeRoot() ? [{ key: key(officeRoot()!), what: "the running office's own code is in it" }] : []),
    ],
    needs: readNeeds(floorDirs, view),
  };

  const opened: { repo: Repo; cands: Candidate[] }[] = [];
  for (const r of repos) {
    const name = r.path === '.' ? path.basename(floor) : r.name;
    if (r.error) {
      report.repos.push({ path: r.path, name, fetch: 'skipped', prs: 'none', alwaysKeep: [], error: r.error });
      continue;
    }
    if (opts.alwaysKeep?.length || opts.forgetKeep?.length) saveKeep(floor, r.path, opts.repo !== undefined || repos.length === 1 ? opts.alwaysKeep ?? [] : [], opts.forgetKeep ?? []);
    try {
      const repo = await openRepo(floor, r.path, name, opts, notes);
      report.repos.push(repo.report);
      opened.push({ repo, cands: await candidates(floor, repo, ctx.tmpKey) });
    } catch (err) {
      report.repos.push({ path: r.path, name, fetch: 'skipped', prs: 'none', alwaysKeep: [], error: (err as Error).message });
    }
  }

  const byRow = new Map<PruneRow, Candidate>();
  for (const { repo, cands } of opened) {
    const judged = await pool(cands, 6, (c) => judge(c, ctx));
    // The office's rows first, by name; then what isn't the office's.
    const order = judged.map((row, i) => ({ row, c: cands[i] })).sort((a, b) => Number(a.row.verdict === 'not-office') - Number(b.row.verdict === 'not-office') || a.row.name.localeCompare(b.row.name));
    const always = new Set(repo.report.alwaysKeep);
    for (const { row, c } of order) {
      const r: PruneRow = { n: report.rows.length + 1, ...row };
      if (matches(r, always)) r.kept = 'always';
      report.rows.push(r);
      byRow.set(r, c);
    }
  }
  // --keep: a bare name in several repositories keeps each of them (the safe way round).
  for (const r of selectRows(report.rows, opts.keep ?? [], false).rows) if (!r.kept) r.kept = 'this run';
  // Pinning a name no row of a several-repository floor has, without --repo: say where it went.
  if (opts.alwaysKeep?.length && opts.repo === undefined && repos.length > 1) {
    for (const n of opts.alwaysKeep) {
      const hit = report.rows.filter((r) => matches(r, new Set([n])));
      for (const repoPath of new Set(hit.map((r) => r.repo))) saveKeep(floor, repoPath, [n], []);
      for (const r of hit) r.kept = 'always';
      if (!hit.length) notes.push(`${n} isn't a row on this floor: pass --repo to pin it in one repository anyway`);
    }
    for (const rep of report.repos) rep.alwaysKeep = keepList(floor, rep.path);
  }
  suggest(report, ctx.now);

  if (!opts.only?.length) return report;

  // Deleting: each named row, looked at again right before it goes.
  const runOut: PruneRun = { dryRun: !!opts.dryRun, remote: !!opts.remote, removed: [], failed: [], refused: [] };
  report.run = runOut;
  // Each name picks rows in one repository: a bare name that's in several is refused, not applied to all.
  const only = selectRows(report.rows, opts.only, true);
  const discard = selectRows(report.rows, opts.discard ?? [], true);
  runOut.refused.push(...only.refused);
  for (const r of discard.refused) runOut.refused.push({ name: r.name, why: `--discard: ${r.why}` });
  for (const row of discard.rows) if (!only.rows.has(row)) runOut.refused.push({ repo: row.repo, name: row.name, why: '--discard only applies to rows also named in --only' });
  for (const row of report.rows) {
    if (!only.rows.has(row)) continue;
    const refuse = (why: string) => runOut.refused.push({ repo: row.repo, name: row.name, why });
    if (row.kept === 'always') {
      refuse('on the always-keep list (office-cleanbot forget, or --forget-keep, takes it off)');
      continue;
    }
    if (row.kept) {
      refuse('named in --keep');
      continue;
    }
    const c = byRow.get(row)!;
    // Workers hired and tasks queued since the table was made, and whatever changed in the row since.
    const fresher = await (opts.office ?? askOffice)();
    ctx.owners = readOwners(floorDirs, fresher);
    ctx.needs = readNeeds(floorDirs, fresher);
    ctx.now = now();
    const fresh = await judge(c, ctx);
    // --discard was said of this row, in this repository: never of a same-named row elsewhere on the floor.
    const forced = discard.rows.has(row);
    if (fresh.verdict !== 'safe' && !(forced && fresh.discardable)) {
      refuse(`${VERDICT_LABEL[fresh.verdict]}: ${fresh.why}${fresh.discardable ? ' (--discard deletes it anyway, losing that)' : ''}`);
      continue;
    }
    if (!fresh.removes.length) {
      refuse('nothing of it is the office\'s to delete');
      continue;
    }
    if (fresh.removes.length === 1 && fresh.removes[0] === 'origin' && !opts.remote) {
      refuse('only on GitHub: --remote deletes it there');
      continue;
    }
    const steps = await remove(c, fresh, ctx, { discard: forced && fresh.verdict !== 'safe', remote: !!opts.remote, dryRun: !!opts.dryRun });
    for (const s of steps) (s.ok ? runOut.removed : runOut.failed).push(s);
    if (opts.remote && fresh.removes.includes('origin') && fresh.originStays) refuse(`GitHub's copy stays: ${fresh.originStays}`);
  }
  if (!opts.dryRun && (runOut.removed.length || runOut.failed.length)) logRun(floor, report, opts.by);
  return report;
}

/** Each row's suggestion, and the lists CleanBot offers: delete (and on GitHub only, with --remote), and a look. */
function suggest(report: FloorPruneReport, now: number) {
  const s = report.suggested;
  for (const r of report.rows) {
    r.suggest = suggestFor(r, now);
    const ref = { n: r.n, repo: r.repo, name: r.name, why: r.why };
    if (r.suggest === 'look') s.look.push(ref);
    else if (r.suggest === 'delete') (!r.local && !r.worktree ? s.remote : s.delete).push(ref);
  }
}

/** One line per run in the floor's .agent-office/cleanup-log.jsonl, for the next run or a person. */
function logRun(floor: string, report: FloorPruneReport, by?: string) {
  const run = report.run!;
  const line = { at: new Date().toISOString(), by: by ?? process.env.USERNAME ?? process.env.USER ?? 'someone', floor: report.floor, remote: run.remote, removed: run.removed, failed: run.failed, refused: run.refused };
  try {
    mkdirSync(path.join(floor, '.agent-office'), { recursive: true });
    appendFileSync(path.join(floor, '.agent-office', LOG_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    report.notes.push(`Couldn't write the run log: ${(err as Error).message}`);
  }
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ---- The command line ----------------------------------------------------------------------------

export const FLOOR_HELP = `agent-office prune --floor — every repository on a floor, with every safety check

Usage:
  agent-office prune --floor [dir] [options]

Lists the office's leftovers in each repository of the floor in [dir] (default: current directory):
office/* branches, worktrees under .agent-office/worktrees (and stray folders git no longer lists),
desks' worktrees under .agent-office/workspaces, and Claude scratchpad worktrees in the temp folder.
Each gets a verdict, and the table ends with the rows it suggests deleting (the safe ones) and the
command that deletes them. Nothing is deleted unless it's named with --only, and each named row is
checked again right before it goes. Never deleted: live workers' rows, protected and just-made ones,
open PRs' branches, and anything a worker's request (the PR agent's and the VP's too) or a queued
task names.

Options:
  --json                 Print it all as JSON (what CleanBot reads)
  --repo <path>          Only this repository of the floor
  --only <names>         Delete these rows: branch names, or worktree paths as listed (comma-separated).
                         On a floor of several repositories, repo:name (app:office/foo) says which when
                         the name is in more than one; a bare name that is, is refused. Row numbers
                         aren't taken, since they can change between runs
  --keep <names>         Keep these rows this run, even if named in --only
  --discard <names>      Rows also named in --only to delete even though they hold work or were
                         recently active, losing that. Named the same way: it applies to that row in
                         that repository only
  --remote               Also delete GitHub's (origin's) copy of branches whose PR is merged or closed
  --always-keep <names>  Add to the floor's always-keep list (.agent-office/${KEEP_FILE})
  --forget-keep <names>  Take them off it
  --recent <hours>       Changed this recently counts as in use (default ${RECENT_MS / 3_600_000})
  --no-fetch             Skip git fetch --prune origin (whether commits are on GitHub is then unknown)
  -n, --dry-run          Show what --only would delete, and change nothing
  -h, --help             Show this help
`;

/** Options that make `agent-office prune` the whole-floor sweep; without them it's upstream's prune. */
const FLOOR_FLAGS = new Set(['--floor', '--json', '--repo', '--only', '--keep', '--discard', '--remote', '--always-keep', '--forget-keep', '--recent', '--no-fetch']);
const VALUED = new Set(['--repo', '--only', '--keep', '--discard', '--always-keep', '--forget-keep', '--recent']);

export function isFloorPrune(argv: string[]): boolean {
  return argv.some((a) => FLOOR_FLAGS.has(a.split('=')[0]));
}

class UsageError extends Error {}

export function parseFloorArgs(argv: string[], cwd = process.cwd()): FloorPruneOptions & { json: boolean; help: boolean } {
  const out: FloorPruneOptions & { json: boolean; help: boolean } = { floor: cwd, json: false, help: false };
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const add = (k: 'only' | 'keep' | 'discard' | 'alwaysKeep' | 'forgetKeep', v: string) => (out[k] = [...(out[k] ?? []), ...list(v)]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    let value: string | undefined;
    if (VALUED.has(flag)) {
      value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith('-'))) throw new UsageError(`${flag} needs a value`);
    } else if (eq > 0) throw new UsageError(`${flag} takes no value`);
    if (flag === '-h' || flag === '--help') out.help = true;
    else if (flag === '-n' || flag === '--dry-run') out.dryRun = true;
    else if (flag === '-f' || flag === '--force') throw new UsageError('--force is for the plain prune: here, name the rows to delete anyway with --discard, after seeing what they hold');
    else if (flag === '--floor') continue;
    else if (flag === '--json') out.json = true;
    else if (flag === '--remote') out.remote = true;
    else if (flag === '--no-fetch') out.fetch = false;
    else if (flag === '--repo') out.repo = value;
    else if (flag === '--only') add('only', value!);
    else if (flag === '--keep') add('keep', value!);
    else if (flag === '--discard') add('discard', value!);
    else if (flag === '--always-keep') add('alwaysKeep', value!);
    else if (flag === '--forget-keep') add('forgetKeep', value!);
    else if (flag === '--recent') {
      const h = Number(value);
      if (!(h > 0)) throw new UsageError('--recent takes a number of hours, e.g. --recent 48');
      out.recentMs = h * 3_600_000;
    } else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
    else out.floor = path.resolve(cwd, a);
  }
  if (out.discard?.length && !out.only?.length) throw new UsageError('--discard only applies to rows named in --only');
  return out;
}

/** `agent-office prune --floor …`: 0 when done, 1 when something named couldn't be deleted, 2 for a usage error. */
export async function floorPruneCommand(argv: string[]): Promise<number> {
  let opts: ReturnType<typeof parseFloorArgs>;
  try {
    opts = parseFloorArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`agent-office prune: ${err.message}\n`);
    process.stderr.write(FLOOR_HELP);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(FLOOR_HELP);
    return 0;
  }
  if (!existsSync(opts.floor)) {
    console.error(`agent-office prune: directory not found: ${opts.floor}`);
    return 2;
  }
  let report: FloorPruneReport;
  try {
    report = await floorPrune(opts);
  } catch (err) {
    console.error(`agent-office prune: ${(err as Error).message}`);
    return 1;
  }
  process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, !!opts.dryRun));
  return report.run && (report.run.failed.length || report.run.refused.length) ? 1 : 0;
}

/** How the delete command is spelled: this CLI's, or CleanBot's office-cleanbot. */
export type CommandStyle = 'prune' | 'cleanbot';

/** The command that deletes `rows` (per repository on a floor of several: names can repeat across them). */
export function deleteCommands(report: FloorPruneReport, rows: SuggestedRow[], style: CommandStyle, remote = false): string[] {
  const byRepo = new Map<string, string[]>();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r.name]);
  const several = report.repos.length > 1;
  // Commas are safe unquoted in sh and PowerShell, and both commands split names on them.
  const quote = (s: string) => (/^[\w./@:+,-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);
  return [...byRepo].map(([repo, names]) => {
    const repoArg = several ? ` --repo ${quote(repo)}` : '';
    const list = quote(names.join(','));
    return style === 'cleanbot' ? `office-cleanbot delete ${list}${repoArg}${remote ? ' --remote' : ''}` : `agent-office prune --floor${repoArg} --only ${list}${remote ? ' --remote' : ''}`;
  });
}

/** The report as a person reads it: a numbered table per repository, then what to delete. */
export function renderReport(report: FloorPruneReport, dryRun: boolean, style: CommandStyle = 'prune'): string {
  const lines: string[] = ['', `  ${style === 'cleanbot' ? '🧹 CleanBot' : 'agent-office prune --floor'} — ${report.floor}${dryRun ? ' (dry run)' : ''}`, ''];
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : '—');
  const since = (iso?: string) => (iso ? ago(Date.parse(report.at) - Date.parse(iso)) : '—');
  for (const repo of report.repos) {
    const head = [
      repo.github ? `origin ${repo.github}` : undefined,
      repo.fetch === 'ok' ? 'fetched' : repo.fetch === 'failed' ? 'FETCH FAILED' : repo.fetch === 'no-origin' ? 'no origin' : 'not fetched',
      repo.prs === 'ok' ? 'PRs read' : repo.prs === 'unknown' ? "PRs couldn't be read" : undefined,
      repo.alwaysKeep.length ? `always keep: ${repo.alwaysKeep.join(', ')}` : undefined,
    ].filter(Boolean);
    lines.push(`  📁 ${repo.path === '.' ? repo.name : repo.path} — ${repo.error ? `couldn't read it: ${repo.error}` : head.join(' · ')}`);
    const rows = report.rows.filter((r) => r.repo === repo.path);
    const mine = rows.filter((r) => r.verdict !== 'not-office');
    if (mine.length) {
      lines.push(`    ${'#'.padStart(3)}  ${'Branch or worktree'.padEnd(44)} ${'PR'.padEnd(12)} ${'Last commit'.padEnd(11)} ${'Changed'.padEnd(10)} Verdict`);
      for (const r of mine) {
        const extra = r.worktree?.stray ? ' (stray folder)' : r.worktree?.kind === 'scratchpad' ? ' (scratchpad)' : r.worktree?.desk ? ` (desk ${r.worktree.desk})` : !r.local && !r.worktree ? ' (GitHub only)' : '';
        const pr = r.pr ? `#${r.pr.number} ${prState(r.pr)}` : '—';
        const kept = r.kept === 'always' ? ' [always keep]' : r.kept ? ' [keep]' : '';
        // The mark goes with the verdict: an emoji's width varies between terminals, so not in a padded column.
        const mark = r.suggest === 'delete' ? '🗑 ' : r.suggest === 'look' ? '👀 ' : '';
        lines.push(`    ${String(r.n).padStart(3)}  ${(r.name + extra).padEnd(44)} ${pr.padEnd(12)} ${day(r.lastCommit).padEnd(11)} ${since(r.changed).padEnd(10)} ${mark}${VERDICT_LABEL[r.verdict]}${kept} — ${r.why}`);
      }
    } else if (!repo.error) lines.push("    nothing of the office's here: all clean");
    const others = rows.filter((r) => r.verdict === 'not-office');
    if (others.length) lines.push(`    Not the office's, left alone: ${others.map((r) => `${r.n} ${r.name}`).join(', ')}`);
    lines.push('');
  }
  for (const n of report.notes) lines.push(`  ⚠ ${n}`);
  const run = report.run;
  if (run) {
    lines.push('');
    for (const s of run.removed) lines.push(`  ${run.dryRun ? 'would remove' : 'removed'}  ${s.what.padEnd(8)} ${s.name}${s.repo !== '.' ? ` (${s.repo})` : ''}`);
    for (const s of run.failed) lines.push(`  FAILED        ${s.what.padEnd(8)} ${s.name}${s.repo !== '.' ? ` (${s.repo})` : ''}: ${s.error}`);
    for (const r of run.refused) lines.push(`  kept          ${r.name}${r.repo && r.repo !== '.' ? ` (${r.repo})` : ''}: ${r.why}`);
    lines.push('', `  ${run.removed.length} ${run.dryRun ? 'to remove' : 'removed'}, ${run.failed.length} failed, ${run.refused.length} kept.`);
  } else {
    const s = report.suggested;
    const mine = report.rows.filter((r) => r.verdict !== 'not-office').length;
    const list = (rows: SuggestedRow[]) => rows.map((r) => `${r.n} ${r.name}${report.repos.length > 1 ? ` (${r.repo})` : ''}`).join(', ');
    lines.push('', `  ${mine} of the office's. Nothing was deleted.`);
    if (s.delete.length) {
      lines.push(`  🗑 Suggested to delete (${s.delete.length}, safe: nothing would be lost and nothing needs them): ${list(s.delete)}`);
      for (const cmd of deleteCommands(report, s.delete, style)) lines.push(`     ${cmd}`);
    } else lines.push('  🗑 Nothing is safe to delete right now.');
    if (s.remote.length) {
      lines.push(`  ☁ Only on GitHub, their PRs merged or closed (${s.remote.length}), deleted there only with --remote: ${list(s.remote)}`);
      for (const cmd of deleteCommands(report, s.remote, style, true)) lines.push(`     ${cmd}`);
    }
    if (s.look.length) lines.push(`  👀 Worth a look, the person decides (${s.look.length}: they hold work but nothing's touched them for ${Math.round(LOOK_MS / 86_400_000)} days or more): ${list(s.look)}`);
    lines.push('  Everything else is kept: it holds work, or a worker, the PR agent, the VP or a queued task still needs it.');
  }
  lines.push('');
  return lines.join('\n');
}
