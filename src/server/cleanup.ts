import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { branchNeedsWorktree, cleanupLocked, cleanupLosses, type CleanupChoice, type CleanupItem, type CleanupPr, type CleanupRun, type CleanupScan, type CleanupStep, type CleanupVerdict, type CleanupWorktree } from '../shared/cleanup.js';
import { pullForBranch } from '../shared/pulls.js';
import { originRepo } from './building.js';
import { officeRoot, withGitRepository } from './git-board.js';
import { gh } from './github.js';
import { savedWorkers } from './prune.js';
import { missingCommits } from './unshipped.js';
import { WORKSPACES_DIR, floorRepository } from './workspaces.js';
import { WORKTREES_DIR, Worktrees, describeWork, gitError } from './worktrees.js';

// The cleanup screen's server side (the screen is ui/cleanup.ts): every branch of one repository on a
// floor, local and on origin, with its worktree, its PR and what deleting it would lose; then deleting
// the ones the owner ticked. The checks are Worktrees.inspect()/describeWork() and prune's saved
// workers, plus two more: half-deleted worktree folders ("strays", left when `git worktree remove`
// fails partway on Windows) are read through a throwaway index, and origin's copy of a branch is only
// offered once its PR is merged or closed. Nothing is deleted without a fresh look right before.

const ALWAYS_KEPT = new Set(['main', 'personal']);
/** Pins ("always keep"), per repository, in the floor's own .agent-office folder: never tracked. */
const KEEP_FILE = 'cleanup-keep.json';
const PR_TTL_MS = 2 * 60_000;
const PR_PAGES = 5;
/** A stray with more edited files than this isn't read file by file. */
const MAX_EDITS = 2000;
/** Names and commits listed in "what would be lost". */
const LIST = 5;
const POOL = 6;

interface Result {
  out: string;
  err: string;
  code: number;
}

/** Runs git; a non-zero exit is a result. Never prompts, never takes optional locks from the live checkouts. */
function run(args: string[], cwd: string, opts: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 60_000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout, err: stderr, code: 0 });
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === 'number') return resolve({ out: stdout, err: stderr, code });
      reject(new Error(gitError(err)));
    });
    child.stdin?.end(opts.input ?? '');
  });
}

async function git(args: string[], cwd: string, opts?: Parameters<typeof run>[2]): Promise<string> {
  const r = await run(args, cwd, opts);
  if (r.code !== 0) throw new Error(gitError({ stderr: r.err }) || `git ${args[0]} failed`);
  return r.out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** A path to compare by: resolved, and case-insensitive where the file system is. */
function pathKey(p: string): string {
  const r = real(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function commonDir(dir: string): Promise<string | undefined> {
  const r = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir).catch(() => undefined);
  return r?.code === 0 ? pathKey(r.out.trim()) : undefined;
}

// ---- Keep pins ------------------------------------------------------------------------------------

function pinFile(floorDir: string): string {
  return path.join(floorDir, '.agent-office', KEEP_FILE);
}

function readPins(floorDir: string): Record<string, string[]> {
  try {
    const saved = JSON.parse(readFileSync(pinFile(floorDir), 'utf8')) as unknown;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** The ids pinned to "always keep" in one repository of the floor. */
export function cleanupPins(floorDir: string, repo: string): Set<string> {
  const list = readPins(floorDir)[repo];
  return new Set(Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
}

/** Pins (or unpins) a branch or worktree so every cleanup keeps it. Returns what went wrong, if anything. */
export function setCleanupPin(floorDir: string, repo: string, id: string, pinned: boolean): string | undefined {
  try {
    floorRepository(floorDir, repo);
  } catch (err) {
    return (err as Error).message;
  }
  if (!id || id.length > 4096) return 'Choose a branch or worktree';
  const all = readPins(floorDir);
  const pins = cleanupPins(floorDir, repo);
  if (pinned) pins.add(id);
  else pins.delete(id);
  if (pins.size) all[repo] = [...pins].sort();
  else delete all[repo];
  try {
    writeFileSync(pinFile(floorDir), JSON.stringify(all, null, 2), { mode: 0o600 });
    return undefined;
  } catch (err) {
    return `Couldn't save the pin: ${(err as Error).message}`;
  }
}

// ---- Who still uses what --------------------------------------------------------------------------

interface Hold {
  kind: 'worker' | 'protected';
  text: string;
}

/** What the building still uses: live workers' and meetings' worktrees and branches, floors' own checkouts, desks. */
interface Live {
  /** By worktree folder (pathKey). */
  paths: Map<string, Hold>;
  /** By `${commonDir}\0${branch}`, or `*\0${branch}` when the repository couldn't be told. */
  branches: Map<string, Hold>;
  /** Multi-repository desks' worktrees (pathKey): the desk's folder name and the repositories it spans. */
  desks: Map<string, NonNullable<CleanupWorktree['desk']>>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Every floor's saved workers (prune's savedWorkers()), meetings and desks. The whole building, since a
 * repository can be one floor and a folder of another's too; a worker hired seconds ago is saved as it's hired.
 */
async function liveOwners(floors: { name: string; dir: string }[]): Promise<Live> {
  const live: Live = { paths: new Map(), branches: new Map(), desks: new Map() };
  const commons = new Map<string, Promise<string | undefined>>();
  const common = (dir: string) => {
    const k = pathKey(dir);
    if (!commons.has(k)) commons.set(k, commonDir(dir));
    return commons.get(k)!;
  };
  const hold = async (floorDir: string, repoDir: string, wt: { path?: string; branch?: string }, h: Hold) => {
    if (wt.path) live.paths.set(pathKey(path.resolve(floorDir, wt.path)), h);
    if (wt.branch) live.branches.set(`${(await common(repoDir)) ?? '*'}\0${wt.branch}`, h);
  };
  for (const f of floors) {
    live.paths.set(pathKey(f.dir), { kind: 'protected', text: `the ${f.name} floor's own checkout` });
    const on = floors.length > 1 ? ` on ${f.name}` : '';
    for (const w of savedWorkers(f.dir)) {
      if (!w || typeof w !== 'object') continue;
      const name = typeof w.name === 'string' ? w.name : 'a worker';
      const h: Hold = { kind: 'worker', text: `${name}'s${w.deskId ? ` (${w.deskId}${on})` : on}: clock ${name} out from the office instead` };
      if (w.worktree && typeof w.worktree.branch === 'string') await hold(f.dir, f.dir, w.worktree, h);
      for (const r of Array.isArray(w.workspace?.repositories) ? w.workspace.repositories : []) {
        if (typeof r?.repository === 'string') await hold(f.dir, path.resolve(f.dir, r.repository), r, h);
      }
    }
    const meetings = readJson(path.join(f.dir, '.agent-office', 'meetings.json')) as { current?: unknown; past?: unknown } | undefined;
    for (const m of [meetings?.current, ...(Array.isArray(meetings?.past) ? meetings.past : [])] as { worktree?: { path: string; branch: string }; cleared?: boolean }[]) {
      if (m?.worktree && !m.cleared) await hold(f.dir, f.dir, m.worktree, { kind: 'worker', text: `the meeting room's${on}: clear the meeting room instead` });
    }
    // Desks spanning several repositories: their worktrees in every repository belong to the desk.
    const home = path.join(f.dir, WORKSPACES_DIR);
    for (const name of existsSync(home) ? readdirSync(home) : []) {
      const ws = readJson(path.join(home, name, 'workspace.json')) as { repositories?: { repository: string; path: string }[] } | undefined;
      if (!Array.isArray(ws?.repositories)) continue;
      const desk = { name, repositories: ws.repositories.map((r) => r.repository) };
      for (const r of ws.repositories) if (typeof r?.path === 'string') live.desks.set(pathKey(path.resolve(f.dir, r.path)), desk);
    }
  }
  const office = officeRoot();
  if (office) live.paths.set(pathKey(office), { kind: 'protected', text: "the running office's own code" });
  return live;
}

// ---- Pull requests --------------------------------------------------------------------------------

interface RawPr {
  number: number;
  state: string;
  merged: boolean;
  head: string;
  sha: string;
  repo: string;
  url: string;
}

const PR_JQ = '.[] | {number, state, merged: (.merged_at != null), head: .head.ref, sha: .head.sha, repo: (.head.repo.full_name // ""), url: .html_url}';
const prCache = new Map<string, { at: number; list: RawPr[] }>();

/** origin's pull requests, newest first, over GitHub's REST API (its quota is separate from the boards' GraphQL one). */
async function pullRequests(github: string, cwd: string, fresh: boolean, query: typeof gh): Promise<RawPr[]> {
  const key = github.toLowerCase();
  const hit = prCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < PR_TTL_MS) return hit.list;
  const list: RawPr[] = [];
  for (let page = 1; page <= PR_PAGES; page++) {
    const out = await query(['api', '--method', 'GET', `repos/${github}/pulls`, '-f', 'state=all', '-f', 'per_page=100', '-f', `page=${page}`, '--jq', PR_JQ], cwd, 60_000);
    const lines = out.split('\n').filter((l) => l.trim());
    for (const l of lines) list.push(JSON.parse(l) as RawPr);
    if (lines.length < 100) break;
  }
  prCache.set(key, { at: Date.now(), list });
  return list;
}

// ---- Strays ---------------------------------------------------------------------------------------

/**
 * What a half-deleted worktree folder holds, read without touching any real index: a throwaway index
 * (GIT_INDEX_FILE) gets `branch`'s tree, or nothing when the branch is gone, and `git status` compares
 * the folder with it. Only a second column of M (or T) and ?? count; " D" is a file the half-delete
 * already took. Each edited file is hashed (`git hash-object`) and looked up (`git cat-file`, batched):
 * `unknown` lists the ones whose content git doesn't have anywhere.
 */
export async function strayEdits(dir: string, folder: string, branch?: string): Promise<{ edited: string[]; unknown: string[] }> {
  const gitDir = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).trim();
  const tmp = path.join(os.tmpdir(), `agent-office-cleanup-${process.pid}-${randomBytes(6).toString('hex')}`);
  const index = `${tmp}.index`;
  const excludes = `${tmp}.exclude`;
  const inFolder = (args: string[], input?: string) => git(['--git-dir', gitDir, '--work-tree', folder, '-c', `core.excludesFile=${excludes.split(path.sep).join('/')}`, ...args], folder, { env: { GIT_INDEX_FILE: index }, input, timeout: 120_000 });
  try {
    const tree = branch ? `refs/heads/${branch}` : 'HEAD';
    // Its own .gitignore may be one of the files the half-delete took: use the branch's.
    const ignore = await run(['show', `${tree}:.gitignore`], dir);
    await writeFile(excludes, ignore.code === 0 ? ignore.out : '');
    await inFolder(branch ? ['read-tree', tree] : ['read-tree', '--empty']);
    const f = (await inFolder(['status', '--porcelain=v1', '-z', '-uall'])).split('\0');
    if (f[f.length - 1] === '') f.pop();
    const edited: string[] = [];
    for (let i = 0; i < f.length; ) {
      const rec = f[i++];
      const [x, y] = rec;
      // A rename's old name comes next.
      if (/[RC]/.test(x + y)) i++;
      if ((x === '?' && y === '?') || (y !== ' ' && y !== 'D' && y !== '?')) edited.push(rec.slice(3));
    }
    if (edited.length > MAX_EDITS) throw new Error(`${edited.length} edited files, too many to check one by one`);
    // Folders (a nested repository) and odd names can't be hashed: count them as unknown.
    const files = edited.filter((p) => !p.endsWith('/') && !p.includes('\n'));
    const unknown = edited.filter((p) => !files.includes(p));
    if (files.length) {
      const shas = (await inFolder(['hash-object', '--stdin-paths'], `${files.join('\n')}\n`)).trim().split('\n');
      const found = (await git(['--git-dir', gitDir, 'cat-file', '--batch-check'], dir, { input: `${shas.join('\n')}\n` })).trim().split('\n');
      files.forEach((p, i) => {
        if (!found[i] || found[i].endsWith(' missing')) unknown.push(p);
      });
    }
    return { edited, unknown };
  } finally {
    await Promise.all([index, `${index}.lock`, excludes].map((p) => rm(p, { force: true }).catch(() => undefined)));
  }
}

/**
 * Takes the links (symlinks, Windows junctions) out of a worktree before git deletes it: git on
 * Windows follows a junction and empties its target, e.g. a node_modules linked in from another
 * checkout. Unlinking removes only the link. Real folders are walked; links are never followed.
 */
export async function unlinkLinks(folder: string): Promise<number> {
  let n = 0;
  const queue = [folder];
  while (queue.length) {
    const batch = queue.splice(0, 16);
    await Promise.all(batch.map(async (d) => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) {
          await unlink(p);
          n++;
        } else if (e.isDirectory()) queue.push(p);
      }
    }));
  }
  return n;
}

// ---- The survey -----------------------------------------------------------------------------------

export interface CleanupOptions {
  floorDir: string;
  /** The repository, relative to the floor, as the Git board lists it. */
  repo: string;
  /** Every floor of the building, whose saved workers keep theirs. */
  floors: { name: string; dir: string }[];
  /** Ask GitHub again instead of using the PRs read in the last couple of minutes. */
  fresh?: boolean;
  /** gh, replaceable in tests. */
  gh?: typeof gh;
}

interface Listed {
  abs: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
}

/** What the scan knows about an item beyond what the browser gets. */
interface Found {
  item: CleanupItem;
  /** The worktree folder, absolute. */
  abs?: string;
  /** Where Worktrees() is rooted for it: the checkout whose .agent-office/worktrees holds the folder. */
  home?: string;
  /** A detached worktree's commit. */
  head?: string;
  /** Locked with `git worktree lock`. */
  locked?: boolean;
}

function parseWorktrees(out: string): Listed[] {
  const list: Listed[] = [];
  let cur: Listed | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push((cur = { abs: path.resolve(line.slice('worktree '.length)), detached: false, prunable: false, locked: false }));
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  return list;
}

async function pool<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function survey(o: CleanupOptions): Promise<{ scan: CleanupScan; found: Map<string, Found>; dir: string }> {
  const dir = floorRepository(o.floorDir, o.repo);
  const name = o.repo === '.' ? path.basename(path.resolve(o.floorDir)) : path.basename(dir);
  const [refs, wtOut, cur, originHead, fetchHead, common, live] = await Promise.all([
    git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/heads/', 'refs/remotes/origin/'], dir),
    git(['worktree', 'list', '--porcelain'], dir),
    run(['symbolic-ref', '--short', '-q', 'HEAD'], dir),
    run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], dir),
    run(['rev-parse', '--git-path', 'FETCH_HEAD'], dir),
    commonDir(dir),
    liveOwners(o.floors),
  ]);
  const current = cur.code === 0 ? cur.out.trim() || undefined : undefined;
  const local = new Map<string, { tip: string; date: string }>();
  const remote = new Map<string, { tip: string; date: string }>();
  for (const line of refs.split('\n')) {
    const [ref, tip, date] = line.split('\0');
    if (!ref || !tip) continue;
    if (ref.startsWith('refs/heads/')) local.set(ref.slice('refs/heads/'.length), { tip, date });
    else if (ref !== 'refs/remotes/origin/HEAD') remote.set(ref.slice('refs/remotes/origin/'.length), { tip, date });
  }
  const def = (originHead.code === 0 ? originHead.out.trim().replace(/^refs\/remotes\/origin\//, '') : undefined) || ['main', 'master'].find((b) => remote.has(b)) || ['main', 'master'].find((b) => local.has(b));
  const defaultRefs = def ? [...(local.has(def) ? [`refs/heads/${def}`] : []), ...(remote.has(def) ? [`refs/remotes/origin/${def}`] : [])] : [];
  const localDefault = def && local.has(def) ? [`refs/heads/${def}`] : [];
  const fetchedAt = fetchHead.code === 0 ? await stat(path.resolve(dir, fetchHead.out.trim())).then((s) => s.mtimeMs, () => undefined) : undefined;

  // Pull requests, one read of origin's list for the whole repository.
  const github = originRepo(dir);
  let prs: CleanupScan['prs'] = github ? 'ok' : 'none';
  let prError: string | undefined;
  let raw: RawPr[] = [];
  if (github) {
    try {
      raw = await pullRequests(github, dir, !!o.fresh, o.gh ?? gh);
    } catch (err) {
      prs = 'unknown';
      prError = (err as Error).message;
    }
  }
  const prOf = (branch: string): (CleanupPr & { sha: string }) | undefined => {
    const mine = raw.filter((p) => p.head === branch && p.repo.toLowerCase() === github?.toLowerCase());
    const picked = pullForBranch(mine.map((p) => ({ number: p.number, url: p.url, headRefName: p.head, state: p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED' })), branch);
    return picked ? { number: picked.number, url: picked.url, state: picked.state as CleanupPr['state'], sha: mine.find((p) => p.number === picked.number)?.sha ?? '' } : undefined;
  };

  // Rows: every branch here or on origin, then the worktrees and stray folders, onto their branch when they have one.
  const pins = cleanupPins(o.floorDir, o.repo);
  const found = new Map<string, Found>();
  const show = (abs: string) => (within(o.floorDir, abs) || pathKey(abs) === pathKey(o.floorDir) ? path.relative(o.floorDir, abs).split(path.sep).join('/') : abs);
  const blank = (id: string, branch?: string): Found => ({
    item: { id, branch, local: !!branch && local.has(branch), remote: !!branch && remote.has(branch), verdict: { kind: 'safe', text: 'safe' }, loses: { worktree: [], branch: [], remote: [] }, remoteDeletable: false, pinned: pins.has(id), token: '' },
  });
  for (const b of new Set([...local.keys(), ...remote.keys()])) found.set(b, blank(b, b));
  const homes = [dir, ...(within(dir, real(o.floorDir)) ? [o.floorDir] : [])];
  const homeOf = (abs: string) => homes.find((h) => new Worktrees(h).owns(abs));
  const listed = parseWorktrees(wtOut);
  for (const wt of listed.slice(1)) {
    if (pathKey(wt.abs) === pathKey(dir)) continue;
    const onBranch = wt.branch ? found.get(wt.branch) : undefined;
    const f = onBranch && !onBranch.abs ? onBranch : blank(show(wt.abs));
    if (f !== onBranch) found.set(f.item.id, f);
    const home = homeOf(wt.abs);
    f.abs = wt.abs;
    f.home = home;
    const desk = live.desks.get(pathKey(wt.abs));
    f.item.worktree = { path: show(wt.abs), exists: !wt.prunable && existsSync(wt.abs), ...(home || desk ? {} : { external: true }), ...(wt.detached || !wt.branch ? { detached: true } : {}), ...(desk ? { desk } : {}) };
    f.locked = wt.locked;
    if (!wt.branch) f.head = wt.head;
  }
  for (const home of homes) {
    for (const rel of (await new Worktrees(home).list()).strays) {
      const abs = path.join(home, rel);
      const b = found.get(`office/${path.basename(abs)}`);
      const f = b?.item.local && !b.abs ? b : blank(show(abs));
      if (f !== b) found.set(f.item.id, f);
      f.abs = abs;
      f.home = home;
      f.item.worktree = { path: show(abs), exists: true, stray: true };
    }
  }

  await pool([...found.values()], (f) => judge(f, { dir, current, def, defaultRefs, localDefault, common, live, prs, prOf, local, remote }));
  const items = [...found.values()].map((f) => f.item);
  return { scan: { repo: o.repo, name, github, current, defaultBranch: def, prs, prError, fetchedAt, items }, found, dir };
}

interface Context {
  dir: string;
  current?: string;
  def?: string;
  defaultRefs: string[];
  localDefault: string[];
  common?: string;
  live: Live;
  prs: CleanupScan['prs'];
  prOf(branch: string): (CleanupPr & { sha: string }) | undefined;
  local: Map<string, { tip: string; date: string }>;
  remote: Map<string, { tip: string; date: string }>;
}

/** Commits `tip` has that no remote, the main checkout nor the default branch has, rewritten copies (squash, rebase) counted as there. */
async function unpushedOf(c: Context, tip: string, counted: number): Promise<{ n: number; lines: string[] }> {
  if (!counted) return { n: 0, lines: [] };
  let n = Number((await git(['rev-list', '--count', tip, '--not', 'HEAD', '--remotes', ...c.localDefault], c.dir)).trim()) || 0;
  for (const ref of c.defaultRefs) if (n && !(await missingCommits(c.dir, ref, tip).catch(() => n))) n = 0;
  if (!n) return { n, lines: [] };
  const log = await git(['log', `-n${LIST}`, '--format=%h %s', tip, '--not', 'HEAD', '--remotes', ...c.localDefault], c.dir);
  return { n, lines: log.split('\n').filter(Boolean) };
}

const listed = (names: string[], total: number) => `${names.slice(0, LIST).join(', ')}${total > LIST ? `, … ${total - LIST} more` : ''}`;

/** Fills in an item's PR, verdict, what deleting each part would lose, and its token. */
async function judge(f: Found, c: Context) {
  const it = f.item;
  const b = it.branch;
  const tip = b ? c.local.get(b)?.tip : f.head;
  const remoteTip = b ? c.remote.get(b)?.tip : undefined;
  if (b) it.date = c.local.get(b)?.date ?? c.remote.get(b)?.date;
  const pr = b && c.prs === 'ok' ? c.prOf(b) : undefined;
  if (pr) it.pr = { number: pr.number, url: pr.url, state: pr.state };
  if (!it.date && tip) it.date = (await run(['log', '-1', '--format=%cI', tip], c.dir)).out.trim() || undefined;

  // Kept whatever it holds: a live worker's, or protected.
  const wtKey = f.abs ? pathKey(f.abs) : undefined;
  const hold = (wtKey ? c.live.paths.get(wtKey) : undefined) ?? (b ? c.live.branches.get(`${c.common ?? '*'}\0${b}`) ?? c.live.branches.get(`*\0${b}`) : undefined);
  const protectedWhy = !b
    ? undefined
    : b === c.current
      ? 'checked out in the main checkout'
      : b === c.def
        ? 'the default branch'
        : ALWAYS_KEPT.has(b)
          ? `${b} is always kept`
          : b.startsWith('pr-assets/')
            ? "hosts pull requests' screenshots"
            : pr?.state === 'OPEN'
              ? `PR #${pr.number} is open`
              : undefined;
  const locked: CleanupVerdict | undefined = hold?.kind === 'worker' ? { kind: 'worker', text: hold.text } : hold ? { kind: 'protected', text: hold.text } : protectedWhy ? { kind: 'protected', text: protectedWhy } : f.locked ? { kind: 'protected', text: 'locked with git worktree lock' } : undefined;

  let dirty = 0;
  let unpushed = 0;
  let remoteLost = 0;
  let note = '';
  try {
    if (!locked) {
      const trees = new Worktrees(c.dir);
      const wt = it.worktree;
      // Worktrees.inspect: uncommitted files in the folder, and commits on no remote and not in the main checkout.
      const rel = f.abs && wt && !wt.stray ? path.relative(c.dir, f.abs) : undefined;
      if (rel !== undefined && path.isAbsolute(rel)) throw new Error('its worktree is on another drive');
      const ref = tip ?? (b && it.local ? b : undefined);
      const state = ref ? await trees.inspect({ path: rel, branch: ref }) : undefined;
      if (state?.error) throw new Error(state.error);
      if (wt?.stray) {
        const edits = await strayEdits(c.dir, f.abs!, it.local ? b : undefined);
        dirty = edits.unknown.length;
        if (dirty) it.loses.worktree.push(`${plural(dirty, 'edited file')} in ${wt.path} that git doesn't have: ${listed(edits.unknown, dirty)}`);
        note = edits.edited.length ? `half-deleted folder; its ${plural(edits.edited.length, 'edited file')} ${edits.edited.length === 1 ? 'is' : 'are'} already in git` : 'half-deleted folder, nothing edited';
      } else if (wt && state?.dirty) {
        const names: string[] = [];
        for (const r of (await git(['status', '--porcelain=v1', '-z', '-unormal'], f.abs!)).split('\0').filter((r) => /^.. /.test(r))) {
          // A link (node_modules linked in from another checkout) isn't work: it's unlinked, never followed.
          const link = r.startsWith('??') && (await lstat(path.join(f.abs!, r.slice(3).replace(/\/$/, ''))).then((s) => s.isSymbolicLink(), () => false));
          if (!link) names.push(r.slice(3));
        }
        dirty = names.length;
        if (dirty) it.loses.worktree.push(`${plural(dirty, 'uncommitted change')} in ${wt.path}: ${listed(names, dirty)}`);
        else note = 'only a linked folder in it, which is unlinked, not followed';
      } else if (wt && !wt.exists) note = 'its folder is already gone; git worktree prune forgets it';
      if (ref && state) {
        const u = await unpushedOf(c, ref, state.unpushed);
        unpushed = u.n;
        if (!u.n && state.unpushed) note = `its commits are already in ${c.def}`;
        if (u.n) (b ? it.loses.branch : it.loses.worktree).push(`${plural(u.n, 'commit')} ${b ? `on ${b} that no remote has` : 'only this detached worktree has'}: ${u.lines.join('; ')}${u.n > u.lines.length ? '; …' : ''}`);
      }
    }
    // Origin's copy: only once its PR is merged or closed, and what origin alone has there counts as lost.
    if (b && remoteTip) {
      if (locked) it.remoteWhy = locked.text;
      else if (c.prs === 'unknown') it.remoteWhy = "GitHub couldn't say whether it has an open PR";
      else if (!pr) it.remoteWhy = 'it has no pull request';
      else {
        it.remoteDeletable = true;
        if (remoteTip !== pr.sha) {
          const ref = `refs/remotes/origin/${b}`;
          remoteLost = Number((await git(['rev-list', '--count', ref, '--not', `--exclude=${ref}`, '--remotes', 'HEAD', ...c.localDefault], c.dir)).trim()) || 0;
          for (const d of c.defaultRefs) if (remoteLost && !(await missingCommits(c.dir, d, ref).catch(() => remoteLost))) remoteLost = 0;
          if (remoteLost) it.loses.remote.push(`${plural(remoteLost, 'commit')} on origin/${b} that PR #${pr.number} doesn't have`);
        }
      }
    }
    if (locked) it.verdict = locked;
    else {
      const work = describeWork({ exists: true, dirty, ahead: 0, unpushed });
      const onlyOrigin = !it.local && !it.worktree;
      if (work) it.verdict = { kind: 'work', text: work };
      else if (onlyOrigin && remoteLost) it.verdict = { kind: 'work', text: `${plural(remoteLost, 'commit')} only on origin` };
      else it.verdict = { kind: 'safe', text: `safe${onlyOrigin ? ' (only on origin)' : note ? ` (${note})` : ''}` };
    }
  } catch (err) {
    it.verdict = locked ?? { kind: 'unknown', text: `could not check it (${(err as Error).message})` };
    it.remoteDeletable = false;
  }
  it.token = createHash('sha1').update(JSON.stringify([tip, remoteTip, f.abs, it.worktree?.exists, dirty, unpushed, remoteLost, it.pr?.state, it.verdict.kind, it.loses])).digest('hex').slice(0, 16);
}

/** Every branch and worktree of one repository on a floor, with what deleting each would lose. */
export async function scanCleanup(o: CleanupOptions): Promise<CleanupScan> {
  return (await survey(o)).scan;
}

// ---- Deleting -------------------------------------------------------------------------------------

function refusal(it: CleanupItem, c: CleanupChoice): string | undefined {
  if (c.token !== it.token) return 'It changed since you looked: refresh and check it again';
  if (it.pinned) return 'Pinned to always keep: unpin it first';
  if (cleanupLocked(it)) return it.verdict.text;
  if (!c.worktree && !c.branch && !c.remote) return 'Nothing ticked to delete';
  if (c.worktree && !it.worktree) return 'It has no worktree';
  if (c.branch && !it.local) return 'There is no local branch';
  if (c.remote && !it.remoteDeletable) return `Origin's copy can't be deleted from here: ${it.remoteWhy ?? 'it has none'}`;
  if (c.branch && !c.worktree && branchNeedsWorktree(it)) return 'Delete its worktree too: git keeps a branch that a worktree has checked out';
  const lost = cleanupLosses(it, c);
  if (lost.length && !c.force) return `It holds work (${lost.join('; ')}): tick "delete anyway" to lose it`;
  return undefined;
}

/** Deletes a stray folder: only inside .agent-office/worktrees, and only while git still doesn't list it. */
async function removeStray(home: string, abs: string): Promise<string | undefined> {
  const trees = new Worktrees(home);
  if (!trees.owns(abs)) return `Only folders inside ${WORKTREES_DIR} are deleted`;
  if (!(await trees.list()).strays.some((s) => pathKey(path.join(home, s)) === pathKey(abs))) return 'Git lists it as a worktree again: refresh';
  try {
    // fs.rm copes with the paths too long for git; the retries ride out a file Windows has locked for a moment.
    await rm(abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    return (err as Error).message;
  }
  return existsSync(abs) ? 'The folder is still there: a program may have a file in it open' : undefined;
}

async function removeWorktree(f: Found, dir: string): Promise<string | undefined> {
  const it = f.item;
  if (!f.abs || !it.worktree) return 'It has no worktree';
  if (it.worktree.stray) return removeStray(f.home ?? dir, f.abs);
  const home = f.home ?? dir;
  const rel = path.relative(home, f.abs);
  if (path.isAbsolute(rel)) return 'Its worktree is on another drive: remove it with git worktree remove';
  if (it.worktree.exists) await unlinkLinks(f.abs);
  const err = await new Worktrees(home).remove({ path: rel, branch: it.branch ?? '' }, 'worktree');
  if (err) return err;
  return existsSync(f.abs) ? 'The folder is still there: a program may have a file in it open' : undefined;
}

async function deleteRemote(dir: string, branch: string): Promise<string | undefined> {
  // Always origin, never upstream or any other remote.
  const r = await run(['push', 'origin', `:refs/heads/${branch}`], dir, { timeout: 120_000 });
  return r.code === 0 ? undefined : gitError({ stderr: r.err }) || 'git push failed';
}

/**
 * Deletes what `choices` tick, after a fresh scan: anything that changed since it was shown, is pinned,
 * protected, a live worker's, or holds work without its "delete anyway" is refused. `dryRun` only says
 * what would happen. One cleanup (or Git board action) at a time per repository.
 */
export async function runCleanup(o: CleanupOptions & { choices: CleanupChoice[]; dryRun: boolean }): Promise<CleanupRun | string> {
  if (!Array.isArray(o.choices) || o.choices.length > 1000 || o.choices.some((c) => !c || typeof c.id !== 'string' || typeof c.token !== 'string')) return 'Bad request';
  const go = async (): Promise<CleanupRun> => {
    // The real thing asks GitHub again: a closed PR can have been reopened.
    const { found, dir } = await survey({ ...o, fresh: o.fresh || !o.dryRun });
    const out: CleanupRun = { dryRun: o.dryRun, steps: [], refused: [] };
    for (const c of o.choices) {
      const choice = { ...c, worktree: c.worktree === true, branch: c.branch === true, remote: c.remote === true, force: c.force === true };
      const f = found.get(c.id);
      const why = f ? refusal(f.item, choice) : 'It is not there any more';
      if (why || !f) {
        out.refused.push({ id: c.id, why: why ?? 'It is not there any more' });
        continue;
      }
      const it = f.item;
      const wt = it.worktree;
      const plan: CleanupStep[] = [];
      if (choice.worktree && wt) plan.push({ id: it.id, what: 'worktree', label: wt.stray ? `Delete the half-deleted folder ${wt.path}` : wt.exists ? `Remove the worktree ${wt.path}` : `Forget the worktree ${wt.path} (its folder is already gone)` });
      if (choice.branch) plan.push({ id: it.id, what: 'branch', label: `Delete the local branch ${it.branch}` });
      if (choice.remote) plan.push({ id: it.id, what: 'remote', label: `Delete origin/${it.branch} on GitHub (PR #${it.pr?.number} ${it.pr?.state.toLowerCase()})` });
      const lost = cleanupLosses(it, choice);
      if (lost.length) for (const s of plan) s.label += ` — losing ${lost.join('; ')}`;
      if (!o.dryRun) {
        for (const s of plan) {
          if (plan.some((p) => p.ok === false)) {
            s.ok = false;
            s.error = 'Skipped: an earlier step for it failed';
            continue;
          }
          const err = s.what === 'worktree' ? await removeWorktree(f, dir) : s.what === 'branch' ? await new Worktrees(dir).remove({ branch: it.branch! }, 'all') : await deleteRemote(dir, it.branch!);
          s.ok = !err;
          if (err) s.error = err;
        }
      }
      out.steps.push(...plan);
    }
    return out;
  };
  try {
    if (o.dryRun) return await go();
    return await withGitRepository(o.floorDir, o.repo, 'cleaning up branches', go);
  } catch (err) {
    return (err as Error).message;
  }
}
