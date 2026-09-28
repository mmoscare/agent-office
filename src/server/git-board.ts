import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRepo } from '../shared/floors.js';
import type { GitBranchInfo, GitCommitLine, GitDiff, GitDiffMode, GitFileChange, GitFileStatus, GitRepoDetail, GitRepoList, GitRepoSummary, OfficeStatus } from '../shared/git-board.js';
import type { PullRequestRef } from '../shared/protocol.js';
import { findBranchPr, gh } from './github.js';
import { floorRepository, workspaceRepositories } from './workspaces.js';

// The Git board (the PR board's other side): every repository on the floor, its branches, and what
// each branch has that its copy on GitHub doesn't (or the other way round), file by file. Read-only
// apart from `git fetch`, which brings the GitHub side up to date. Discovery is the same bounded
// walk multi-repository desks use (workspaces.ts), so a floor that is one repository lists just it.

const MAX_FILES = 500;
const MAX_DIFF = 200_000;
const MAX_COMMITS = 50;
/** Untracked files bigger than this aren't read to count their lines. */
const MAX_COUNT_BYTES = 8 * 1024 * 1024;
/** Repositories read at once for the board's front. */
const POOL = 6;

class GitError extends Error {}

interface Result {
  out: string;
  err: string;
  code: number;
}

/** Runs git; a non-zero exit is a result. Never prompts for credentials: it can't be answered here. */
function run(args: string[], cwd: string, timeout = 30_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout, err: stderr, code: 0 });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (typeof e.code === 'number') return resolve({ out: stdout, err: stderr, code: e.code });
      if (e.code === 'ENOENT') return reject(new GitError('git is not installed on the server'));
      if (e.killed) return reject(new GitError(`git ${args[0]} took more than ${Math.round(timeout / 1000)}s and was stopped`));
      reject(new GitError(String(e.message || err)));
    });
  });
}

/** git's "fatal:"/"error:" line, else its last one. */
function reason(r: Result, fallback: string): string {
  const lines = r.err.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1];
  return line ? line.replace(/^(fatal|error):\s*/i, '') : fallback;
}

async function git(args: string[], cwd: string, timeout?: number): Promise<string> {
  const r = await run(args, cwd, timeout);
  if (r.code !== 0) throw new GitError(reason(r, `git ${args[0]} failed`));
  return r.out.replace(/\n$/, '');
}

async function gitMaybe(args: string[], cwd: string): Promise<string | undefined> {
  const r = await run(args, cwd);
  return r.code === 0 ? r.out.trim() : undefined;
}

/** NUL-separated fields of `git ... -z` output. */
function fields(out: string): string[] {
  const f = out.split('\0');
  if (f[f.length - 1] === '') f.pop();
  return f;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A repository of the floor's, by its path on the board; refuses anything else. */
function repoDir(floorDir: string, rel: string): string {
  try {
    return floorRepository(floorDir, rel);
  } catch (err) {
    throw new GitError(message(err));
  }
}

/** Where the GitHub copy of a local branch is: its upstream, else origin/<name> when that exists. Full ref names. */
async function remoteRefs(dir: string): Promise<Set<string>> {
  const out = await gitMaybe(['for-each-ref', '--format=%(refname)', 'refs/remotes/'], dir);
  return new Set((out ?? '').split('\n').filter((r) => r && !r.endsWith('/HEAD')));
}

function short(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '');
}

async function counts(dir: string, a: string, b: string): Promise<{ ahead: number; behind: number }> {
  const out = await gitMaybe(['rev-list', '--left-right', '--count', `${a}...${b}`], dir);
  const [ahead, behind] = (out ?? '0\t0').split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/** GitHub owner/name of origin, when it's on GitHub. */
async function githubOf(dir: string): Promise<string | undefined> {
  const url = await gitMaybe(['remote', 'get-url', 'origin'], dir);
  return url && /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
}

/** When this checkout last fetched: FETCH_HEAD's time. */
async function fetchedAt(dir: string): Promise<number | undefined> {
  const p = await gitMaybe(['rev-parse', '--git-path', 'FETCH_HEAD'], dir);
  if (!p) return undefined;
  try {
    return (await stat(path.resolve(dir, p))).mtimeMs;
  } catch {
    return undefined;
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

// ---- The board's front: every repository -------------------------------------------------------

export async function gitRepositories(floorDir: string): Promise<GitRepoList> {
  const found = await workspaceRepositories(floorDir);
  const repos = await pool(found.repositories, POOL, async (r): Promise<GitRepoSummary> => {
    const base: GitRepoSummary = { path: r.path, name: r.path === '.' ? path.basename(path.resolve(floorDir)) : r.name, branch: r.branch, ahead: 0, behind: 0, dirty: r.dirty };
    if (r.error) return { ...base, error: r.error };
    try {
      const dir = repoDir(floorDir, r.path);
      const [github, remotes] = await Promise.all([githubOf(dir), remoteRefs(dir)]);
      const upstream = r.branch ? await upstreamOf(dir, r.branch, remotes) : undefined;
      const c = upstream && !upstream.gone ? await counts(dir, 'HEAD', upstream.ref) : { ahead: 0, behind: 0 };
      return { ...base, github, upstream: upstream && !upstream.gone ? short(upstream.ref) : undefined, ...c };
    } catch (err) {
      return { ...base, error: message(err) };
    }
  });
  return { repos, floorIsRepo: repos.length === 1 && repos[0].path === '.', truncated: found.truncated };
}

/** A local branch's GitHub copy: its configured upstream, else a remote branch of the same name on origin. */
async function upstreamOf(dir: string, branch: string, remotes: Set<string>): Promise<{ ref: string; gone?: boolean } | undefined> {
  const configured = await gitMaybe(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], dir);
  if (configured) return remotes.has(configured) ? { ref: configured } : { ref: configured, gone: true };
  const guess = `refs/remotes/origin/${branch}`;
  return remotes.has(guess) ? { ref: guess } : undefined;
}

// ---- One repository: branches and changes ------------------------------------------------------

interface Inspected {
  detail: GitRepoDetail;
  dir: string;
  /** Full ref (or HEAD) of the branch shown. */
  head: string;
  /** The commit the GitHub list is taken from, when there is one. */
  from?: string;
  /** Whether the shown branch is the checked-out one, so the working tree counts. */
  live: boolean;
}

async function branchList(dir: string, current: string | undefined, remotes: Set<string>): Promise<GitBranchInfo[]> {
  const out = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%00%(upstream)%00%(committerdate:iso-strict)%00%(subject)', 'refs/heads/'], dir);
  const rows = out.split('\n').filter(Boolean).map((line) => line.split('\0'));
  const list = await pool(rows, POOL, async ([name, configured, date, subject]): Promise<GitBranchInfo> => {
    const b: GitBranchInfo = { name, current: name === current, ahead: 0, behind: 0, date, subject };
    const up = configured ? (remotes.has(configured) ? { ref: configured } : { ref: configured, gone: true }) : remotes.has(`refs/remotes/origin/${name}`) ? { ref: `refs/remotes/origin/${name}` } : undefined;
    if (!up) return b;
    b.upstream = short(up.ref);
    if (up.gone) b.gone = true;
    else Object.assign(b, await counts(dir, `refs/heads/${name}`, up.ref));
    return b;
  });
  // The checked-out branch first, then the most recently committed.
  return list.sort((a, b) => Number(b.current) - Number(a.current));
}

/** The branch GitHub treats as the default (origin/HEAD), else origin/main or origin/master. */
async function defaultRemote(dir: string, remotes: Set<string>): Promise<string | undefined> {
  const head = await gitMaybe(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], dir);
  if (head && remotes.has(head)) return head;
  return ['refs/remotes/origin/main', 'refs/remotes/origin/master'].find((r) => remotes.has(r));
}

async function commits(dir: string, range: string): Promise<GitCommitLine[]> {
  const out = await gitMaybe(['log', `-n${MAX_COMMITS}`, '--format=%h%x00%s%x00%an%x00%cI', range, '--'], dir);
  return (out ?? '').split('\n').filter(Boolean).map((l) => {
    const [hash, subject, author, date] = l.split('\0');
    return { hash, subject, author, date };
  });
}

async function countLines(file: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > MAX_COUNT_BYTES) return { lines: 0, binary: false };
    const buf = await readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { lines: 0, binary: true };
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    if (buf.length && buf[buf.length - 1] !== 10) n++;
    return { lines: n, binary: false };
  } catch {
    return { lines: 0, binary: false };
  }
}

/** Files that differ between two sides (`to` omitted: the working tree), with line counts. */
async function diffFiles(dir: string, from: string, to?: string): Promise<GitFileChange[]> {
  const range = to ? [from, to] : [from];
  const [names, numstat] = await Promise.all([git(['diff', '--name-status', '-M', '-z', ...range, '--'], dir), git(['diff', '--numstat', '-M', '-z', ...range, '--'], dir)]);
  const files = new Map<string, GitFileChange>();
  // "M\0path\0", renames "R100\0old\0new\0".
  const ns = fields(names);
  for (let i = 0; i < ns.length; ) {
    const kind = ns[i++][0];
    const renamed = kind === 'R' || kind === 'C';
    const old = renamed ? ns[i++] : undefined;
    const p = ns[i++];
    if (p === undefined) break;
    const status: GitFileStatus = renamed ? 'R' : kind === 'A' || kind === 'D' || kind === 'T' ? kind : 'M';
    files.set(p, { path: p, from: old, status, additions: 0, deletions: 0, binary: false });
  }
  // "add\tdel\tpath\0", renames "add\tdel\t\0old\0new\0"; binaries count as "-".
  const st = fields(numstat);
  for (let i = 0; i < st.length; ) {
    const [a, d, p0] = st[i++].split('\t');
    const p = p0 === '' ? st[(i += 2) - 1] : p0;
    const f = p === undefined ? undefined : files.get(p);
    if (!f) continue;
    if (a === '-') f.binary = true;
    else {
      f.additions = Number(a) || 0;
      f.deletions = Number(d) || 0;
    }
  }
  return [...files.values()];
}

/** `git status`: what's uncommitted, staged or not, and the untracked files. */
async function status(dir: string): Promise<{ tracked: Map<string, { staged: boolean; unstaged: boolean; status: GitFileStatus; from?: string }>; untracked: string[] }> {
  const sf = fields(await git(['status', '--porcelain=v1', '-z', '-uall'], dir));
  const tracked = new Map<string, { staged: boolean; unstaged: boolean; status: GitFileStatus; from?: string }>();
  const untracked: string[] = [];
  for (let i = 0; i < sf.length; ) {
    const rec = sf[i++];
    const [x, y] = rec;
    const p = rec.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(p);
      continue;
    }
    if (x === '!' && y === '!') continue;
    const renamed = /[RC]/.test(x + y);
    const from = renamed ? sf[i++] : undefined;
    const letter = x !== ' ' && x !== '?' ? x : y;
    const status: GitFileStatus = renamed ? 'R' : letter === 'A' || letter === 'D' || letter === 'T' ? letter : 'M';
    tracked.set(p, { staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && y !== '?', status, from });
  }
  return { tracked, untracked };
}

async function withUntracked(dir: string, list: GitFileChange[], untracked: string[]): Promise<GitFileChange[]> {
  const known = new Set(list.map((f) => f.path));
  const extra = untracked.filter((p) => !known.has(p)).slice(0, MAX_FILES);
  const added = await pool(extra, 16, async (p): Promise<GitFileChange> => {
    const { lines, binary } = await countLines(path.join(dir, p));
    return { path: p, status: '?', additions: lines, deletions: 0, binary, unstaged: true };
  });
  return [...list, ...added].sort((a, b) => a.path.localeCompare(b.path));
}

async function inspect(floorDir: string, rel: string, wanted?: string): Promise<Inspected> {
  const dir = repoDir(floorDir, rel);
  const name = rel === '.' ? path.basename(path.resolve(floorDir)) : path.basename(dir);
  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD'], dir);
  if (head.code !== 0) throw new GitError('This repository has no commits yet');
  const current = (await gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], dir)) || undefined;
  const [remotes, github, fetched] = await Promise.all([remoteRefs(dir), githubOf(dir), fetchedAt(dir)]);
  const branches = await branchList(dir, current, remotes);
  if (wanted && !branches.some((b) => b.name === wanted)) throw new GitError(`No branch called ${wanted} here`);
  const shown = wanted ?? current;
  const live = !shown || shown === current;
  const ref = shown ? `refs/heads/${shown}` : 'HEAD';
  const info = branches.find((b) => b.name === shown);
  const def = await defaultRemote(dir, remotes);
  const detail: GitRepoDetail = { path: rel, name, github, branch: shown ?? 'HEAD (detached)', current, branches, compare: {}, githubFiles: [], uncommitted: [], outgoing: [], incoming: [], ahead: 0, behind: 0, defaultBranch: def?.replace(/^refs\/remotes\/origin\//, ''), fetchedAt: fetched, more: 0 };

  let from: string | undefined;
  if (info?.upstream && !info.gone) {
    const up = `refs/remotes/${info.upstream}`;
    from = (await gitMaybe(['rev-parse', '--verify', '--quiet', `${up}^{commit}`], dir)) || undefined;
    detail.compare = { ref: info.upstream };
    detail.ahead = info.ahead;
    detail.behind = info.behind;
    if (from) [detail.outgoing, detail.incoming] = await Promise.all([commits(dir, `${up}..${ref}`), commits(dir, `${ref}..${up}`)]);
  } else {
    // Not on GitHub (yet, or any more): what it adds to the default branch, from where they split.
    const split = def ? await gitMaybe(['merge-base', def, ref], dir) : undefined;
    const why = info?.gone ? `${info.upstream} was deleted from GitHub` : shown ? `${shown} isn't on GitHub yet` : 'HEAD is detached';
    if (def && split) {
      from = split;
      detail.compare = { ref: short(def), unpublished: true, note: `${why}, so this is what it adds to ${short(def)}` };
      detail.outgoing = await commits(dir, `${split}..${ref}`);
      detail.ahead = Number(await gitMaybe(['rev-list', '--count', `${split}..${ref}`], dir)) || 0;
    } else detail.compare = { note: `${why}, and there's no GitHub branch to compare it with` };
  }

  const st = live ? await status(dir) : undefined;
  if (from) {
    let files = await diffFiles(dir, from, live ? undefined : ref);
    if (st) {
      for (const f of files) if (st.tracked.has(f.path) || (f.from && st.tracked.has(f.from))) f.uncommitted = true;
      files = (await withUntracked(dir, files, st.untracked)).map((f) => (f.status === '?' ? { ...f, unstaged: undefined, uncommitted: true } : f));
    }
    detail.more = Math.max(0, files.length - MAX_FILES);
    detail.githubFiles = files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FILES);
  }
  if (st) {
    const counted = new Map((await diffFiles(dir, 'HEAD')).map((f) => [f.path, f]));
    const tracked = [...st.tracked].map(([p, t]): GitFileChange => {
      const c = counted.get(p);
      return { path: p, from: t.from, status: t.status, additions: c?.additions ?? 0, deletions: c?.deletions ?? 0, binary: c?.binary ?? false, staged: t.staged, unstaged: t.unstaged };
    });
    detail.uncommitted = (await withUntracked(dir, tracked, st.untracked)).slice(0, MAX_FILES);
  }
  return { detail, dir, head: ref, from, live };
}

export async function gitRepository(floorDir: string, rel: string, branch?: string): Promise<GitRepoDetail> {
  try {
    return (await inspect(floorDir, rel, branch)).detail;
  } catch (err) {
    return { path: rel, name: rel === '.' ? path.basename(path.resolve(floorDir)) : path.basename(rel), branch: branch ?? '', branches: [], compare: {}, githubFiles: [], uncommitted: [], outgoing: [], incoming: [], ahead: 0, behind: 0, more: 0, error: message(err) };
  }
}

/** One file's diff: against GitHub (`github`) or against the last commit (`uncommitted`). */
export async function gitFileDiff(floorDir: string, rel: string, branch: string | undefined, file: string, mode: GitDiffMode): Promise<GitDiff | string> {
  try {
    const it = await inspect(floorDir, rel, branch);
    const list = mode === 'github' ? it.detail.githubFiles : it.detail.uncommitted;
    const f = list.find((x) => x.path === file);
    if (!f) return it.detail.error ?? 'That file has no changes';
    let out: string;
    if (f.status === '?') {
      // Exit code 1 only means the file isn't empty.
      const r = await run(['diff', '--no-index', '--', '/dev/null', f.path], it.dir);
      if (r.code > 1) throw new GitError(reason(r, 'git diff failed'));
      out = r.out;
    } else {
      const from = mode === 'github' ? it.from : 'HEAD';
      if (!from) return 'There is nothing on GitHub to compare with';
      const range = mode === 'github' && !it.live ? [from, it.head] : [from];
      out = await git(['diff', '-M', ...range, '--', ...(f.from ? [f.from] : []), f.path], it.dir);
    }
    const truncated = out.length > MAX_DIFF;
    return { diff: truncated ? out.slice(0, MAX_DIFF) : out, truncated };
  } catch (err) {
    return message(err);
  }
}

const fetching = new Map<string, Promise<string | undefined>>();

/** `git fetch --prune` from origin, so the GitHub side is current. One at a time per repository. */
export function gitFetch(floorDir: string, rel: string): Promise<string | undefined> {
  let dir: string;
  try {
    dir = repoDir(floorDir, rel);
  } catch (err) {
    return Promise.resolve(message(err));
  }
  const key = dir.toLowerCase();
  let p = fetching.get(key);
  if (!p) {
    p = (async () => {
      try {
        const remotes = (await git(['remote'], dir)).split('\n').filter(Boolean);
        if (!remotes.includes('origin')) return 'This repository has no origin remote to fetch from';
        await git(['fetch', '--prune', '--quiet', 'origin'], dir, 90_000);
        return undefined;
      } catch (err) {
        return message(err);
      } finally {
        fetching.delete(key);
      }
    })();
    fetching.set(key, p);
  }
  return p;
}

// ---- Changing things: stage, commit, push, pull, open a PR --------------------------------------
// Only ever on the branch checked out in the folder, one action at a time per repository. Hooks run
// as they would in a terminal; nothing is forced.

const acting = new Map<string, string>();

async function act<T>(floorDir: string, rel: string, label: string, fn: (dir: string) => Promise<T>): Promise<T | string> {
  let dir: string;
  try {
    dir = repoDir(floorDir, rel);
  } catch (err) {
    return message(err);
  }
  const key = dir.toLowerCase();
  const now = acting.get(key);
  if (now) return `Hold on — still ${now}`;
  acting.set(key, label);
  try {
    return await fn(dir);
  } catch (err) {
    return message(err);
  } finally {
    acting.delete(key);
  }
}

async function currentBranch(dir: string): Promise<string> {
  const b = await gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], dir);
  if (!b) throw new GitError('HEAD is detached: check out a branch first');
  return b;
}

/** Paths the request names that really are uncommitted here (with a rename's old name too). */
async function uncommittedPaths(floorDir: string, rel: string, paths: string[]): Promise<string[]> {
  const { detail } = await inspect(floorDir, rel);
  const out: string[] = [];
  for (const p of paths) {
    const f = detail.uncommitted.find((x) => x.path === p);
    if (!f) throw new GitError(`${p} has no uncommitted changes`);
    out.push(p, ...(f.from ? [f.from] : []));
  }
  return out;
}

/** `git add`: everything (`paths` omitted, like `git add -A`), or the files named. */
export function gitStage(floorDir: string, rel: string, paths?: string[]): Promise<string | undefined> {
  return act(floorDir, rel, 'staging', async (dir) => {
    if (!paths) await git(['add', '-A'], dir, 60_000);
    else await git(['add', '-A', '--', ...(await uncommittedPaths(floorDir, rel, paths))], dir, 60_000);
    return undefined;
  });
}

/** Takes files back out of the index, keeping their edits: everything, or the files named. */
export function gitUnstage(floorDir: string, rel: string, paths?: string[]): Promise<string | undefined> {
  return act(floorDir, rel, 'unstaging', async (dir) => {
    await git(['restore', '--staged', '--', ...(paths ? await uncommittedPaths(floorDir, rel, paths) : ['.'])], dir, 60_000);
    return undefined;
  });
}

/** Commits what's staged; with nothing staged, stages everything first (VS Code's "smart commit"). */
export function gitCommit(floorDir: string, rel: string, msg: string): Promise<{ hash: string; stagedAll: boolean } | string> {
  const text = msg.trim();
  if (!text) return Promise.resolve('The commit needs a message');
  return act(floorDir, rel, 'committing', async (dir) => {
    await currentBranch(dir);
    const staged = (await run(['diff', '--cached', '--quiet'], dir)).code === 1;
    if (!staged) {
      await git(['add', '-A'], dir, 60_000);
      if ((await run(['diff', '--cached', '--quiet'], dir)).code !== 1) throw new GitError('Nothing to commit');
    }
    await git(['commit', '-q', '-m', text], dir, 180_000);
    return { hash: await git(['rev-parse', '--short', 'HEAD'], dir), stagedAll: !staged };
  });
}

/**
 * Pushes the checked-out branch to the same name on origin (the GitHub repository this checkout is
 * cloned from), tracking it when it has no upstream yet. Never forced.
 */
export function gitPush(floorDir: string, rel: string): Promise<{ branch: string } | string> {
  return act(floorDir, rel, 'pushing', async (dir) => {
    const branch = await currentBranch(dir);
    const remotes = (await git(['remote'], dir)).split('\n').filter(Boolean);
    if (!remotes.includes('origin')) throw new GitError('This repository has no origin remote to push to');
    const tracking = await gitMaybe(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], dir);
    await git(['push', ...(tracking ? [] : ['-u']), 'origin', `refs/heads/${branch}:refs/heads/${branch}`], dir, 180_000);
    return { branch };
  });
}

/** Brings the GitHub commits in, only as a fast-forward: nothing to merge by hand here. */
export function gitPull(floorDir: string, rel: string): Promise<string | undefined> {
  return act(floorDir, rel, 'pulling', async (dir) => {
    await currentBranch(dir);
    await git(['pull', '--ff-only', '--quiet'], dir, 180_000);
    return undefined;
  });
}

/** The pull request of the checked-out branch, in any state, if it has one. */
export async function gitBranchPr(floorDir: string, rel: string): Promise<{ pr?: PullRequestRef; branch?: string } | string> {
  try {
    const dir = repoDir(floorDir, rel);
    const branch = await gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], dir);
    if (!branch) return {};
    return { pr: await findBranchPr(branch, dir), branch };
  } catch (err) {
    return message(err);
  }
}

/** Opens a pull request from the checked-out branch (already pushed) into the default branch. */
export function gitOpenPr(floorDir: string, rel: string, title: string, body: string): Promise<{ url: string } | string> {
  if (!title.trim()) return Promise.resolve('The pull request needs a title');
  return act(floorDir, rel, 'opening a pull request', async (dir) => {
    const branch = await currentBranch(dir);
    const remotes = await remoteRefs(dir);
    const def = await defaultRemote(dir, remotes);
    if (!def) throw new GitError("Couldn't tell which branch pull requests go into (origin has no default branch)");
    const base = def.replace(/^refs\/remotes\/origin\//, '');
    if (base === branch) throw new GitError(`${branch} is the default branch: pull requests come from other branches`);
    if (!remotes.has(`refs/remotes/origin/${branch}`)) throw new GitError('Push the branch first');
    const existing = await findBranchPr(branch, dir);
    if (existing?.state === 'OPEN') return { url: existing.url };
    const repo = await githubOf(dir);
    const out = await gh(['pr', 'create', ...(repo ? ['--repo', repo] : []), '--head', branch, '--base', base, '--title', title.trim(), '--body', body], dir, 120_000);
    const url = out.trim().split('\n').pop() ?? '';
    if (!/^https?:\/\//.test(url)) throw new GitError(url || 'gh pr create failed');
    return { url };
  });
}

// ---- The office's own code ----------------------------------------------------------------------
// Where the running office comes from, so the Git board can say when it's behind GitHub, when it
// needs building and when it needs restarting, with the commands for each (see OfficeStatus).

const startedAt = Date.now() - process.uptime() * 1000;
const OFFICE_FETCH_MS = 2 * 60_000;
let officeFetched = 0;

/** The package the office runs from: up from this file to the agent-office package.json. */
function officeRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'agent-office') return dir;
    } catch {
      // not here: keep going up
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

async function mtime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function officeStatus(): Promise<OfficeStatus | undefined> {
  const dir = officeRoot();
  if (!dir) return undefined;
  const top = await gitMaybe(['rev-parse', '--show-toplevel'], dir);
  if (!top || path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase()) return undefined;
  const status: OfficeStatus = { dir, ahead: 0, behind: 0, dirty: 0, startedAt, needs: { pull: false, build: false, restart: false } };
  try {
    // Keep the GitHub side current here too, now and then: this is how "↓ to pull" knows.
    if (Date.now() - officeFetched > OFFICE_FETCH_MS) {
      officeFetched = Date.now();
      await run(['fetch', '--quiet', 'origin'], dir, 60_000).catch(() => undefined);
    }
    const [branch, remotes, github, fetched, dirty, logPath] = await Promise.all([
      gitMaybe(['symbolic-ref', '--short', '-q', 'HEAD'], dir),
      remoteRefs(dir),
      githubOf(dir),
      fetchedAt(dir),
      gitMaybe(['status', '--porcelain=v1', '-unormal'], dir),
      gitMaybe(['rev-parse', '--git-path', 'logs/HEAD'], dir),
    ]);
    Object.assign(status, { branch: branch || undefined, github, fetchedAt: fetched, dirty: (dirty ?? '').split('\n').filter(Boolean).length });
    const up = branch ? await upstreamOf(dir, branch, remotes) : undefined;
    if (up && !up.gone) {
      status.upstream = short(up.ref);
      Object.assign(status, await counts(dir, 'HEAD', up.ref));
    }
    // HEAD's reflog moves on every pull, merge and commit: the code changed then.
    status.changedAt = logPath ? await mtime(path.resolve(dir, logPath)) : undefined;
    // A build writes both halves; the older one says when it was last complete.
    const built = await Promise.all([mtime(path.join(dir, 'dist', 'public', 'index.html')), mtime(path.join(dir, 'dist', 'server', 'server', 'server.js'))]);
    status.builtAt = built.every((t) => t !== undefined) ? Math.min(...(built as number[])) : undefined;
    status.needs = {
      pull: status.behind > 0,
      build: !status.builtAt || (status.changedAt !== undefined && status.changedAt > status.builtAt),
      restart: status.builtAt !== undefined && status.builtAt > startedAt,
    };
  } catch (err) {
    status.error = message(err);
  }
  return status;
}
