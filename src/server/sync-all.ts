import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRepo } from '../shared/floors.js';
import { interruptedByRestart, type UpdateWorker } from '../shared/office-update.js';
import {
  BIG_FILE,
  blockedReason,
  changeAreas,
  newsLines,
  planNextSteps,
  riskyName,
  riskyText,
  suggestMessage,
  type NextSteps,
  type SyncChoice,
  type SyncFile,
  type SyncPlan,
  type SyncRepo,
  type SyncRepoResult,
  type SyncResult,
} from '../shared/sync-all.js';
import { tidyTitle } from './change-notes.js';
import { officeRoot, withGitRepository, type OfficeFloor } from './git-board.js';
import { mergedPrs, redact } from './office-update.js';
import { floorRepository, workspaceRepositories } from './workspaces.js';

// 🔄 Sync everything: the push-button by the gong. For each repository on the floor and the office's
// app folder: save the ticked files as a commit, pull (a merge, never a rebase: GitHub's side comes
// in on top of the saved work), and upload. A clash is undone at once (`git merge --abort`) and said
// plainly; nothing is ever forced, stashed, reset or rebased. The Git board's per-repository lock
// keeps it from running alongside a commit or push there. Then, from what the app folder's new
// commits touch, the checklist of what to do next (shared/sync-all.ts).

const MAX_FILES = 300;
const SCAN_BYTES = 1024 * 1024;
const MAX_DIFF = 16 * 1024 * 1024;
const REVIEW_MS = 10 * 60_000;
const FETCH_MS = 90_000;
const POOL = 4;

interface Run {
  out: string;
  err: string;
  code: number;
}

/** Runs git; a non-zero exit is a result. Never prompts for credentials: nobody could answer here. */
function git(args: string[], cwd: string, timeout = 60_000, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env } }, (err, stdout, stderr) => {
      if (!err) return resolve({ out: stdout, err: stderr, code: 0 });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      if (typeof e.code === 'number') return resolve({ out: stdout, err: stderr, code: e.code });
      if (e.code === 'ENOENT') return reject(new Error('git is not installed on the office’s computer'));
      if (e.killed) return reject(new Error(`git ${args[0]} took more than ${Math.round(timeout / 1000)}s and was stopped`));
      reject(err);
    });
  });
}

async function gitOut(args: string[], cwd: string): Promise<string | undefined> {
  const r = await git(args, cwd, 30_000, { GIT_OPTIONAL_LOCKS: '0' });
  return r.code === 0 ? r.out.trim() : undefined;
}

const log = (label: string, r: Run) => `$ git ${label}\n${r.out}${r.err}`.trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sameDir = (a: string, b: string) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function list(items: string[], max = 6): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
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

// ---- Where: the floor's repositories and the app folder --------------------------------------------

interface Place {
  id: string;
  dir: string;
  kind: 'floor' | 'office';
  name: string;
  /** Where it is on the floor, for the floor's What's new (. for the floor itself). */
  floorPath?: string;
  error?: string;
}

async function places(floorDir: string, app: string | undefined): Promise<{ places: Place[]; truncated: boolean }> {
  const found = await workspaceRepositories(floorDir);
  const out: Place[] = found.repositories.map((r) => {
    const name = r.path === '.' ? path.basename(path.resolve(floorDir)) : r.name;
    try {
      return { id: `floor:${r.path}`, dir: floorRepository(floorDir, r.path), kind: 'floor' as const, name, floorPath: r.path, error: r.error };
    } catch (err) {
      return { id: `floor:${r.path}`, dir: path.resolve(floorDir, r.path), kind: 'floor' as const, name, floorPath: r.path, error: (err as Error).message };
    }
  });
  if (app) {
    try {
      const dir = floorRepository(app, '.');
      const same = out.findIndex((p) => sameDir(p.dir, dir));
      const office: Place = { id: 'office', dir, kind: 'office', name: 'Agent Office app', floorPath: same >= 0 ? out[same].floorPath : undefined };
      if (same >= 0) out[same] = office;
      else out.push(office);
    } catch {
      // A packaged office has no app checkout to sync.
    }
  }
  return { places: out, truncated: found.truncated };
}

// ---- Looking: branch, GitHub copy, unsaved files ---------------------------------------------------

interface Tracking {
  branch?: string;
  head?: string;
  /** refs/remotes/origin/personal */
  upstreamRef?: string;
  /** origin */
  remote?: string;
  /** refs/heads/personal, on the remote. */
  remoteRef?: string;
  problem?: string;
  noPush?: string;
  /** Where Go writes the list of files to save: inside the repository's own .git folder. */
  pathsFile?: string;
  /** The repository's shared .git folder: worktrees of one repository are synced one after another. */
  common?: string;
  /** owner/name, when origin is on GitHub. */
  github?: string;
}

/** Operations that leave a checkout half done: a sync keeps out of it until they're finished. */
const UNFINISHED: [marker: string, what: string][] = [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']];

/** The branch, the GitHub branch it follows, and whether it can be synced: every question at once (git is slow to start on a busy machine). */
async function tracking(dir: string, name: string): Promise<Tracking> {
  const [branch, head, gitPaths, heads, fetchUrl, pushUrls] = await Promise.all([
    gitOut(['symbolic-ref', '--short', '-q', 'HEAD'], dir),
    gitOut(['rev-parse', '--verify', '--quiet', 'HEAD'], dir),
    gitOut(['rev-parse', '--git-common-dir', ...UNFINISHED.flatMap(([m]) => ['--git-path', m]), '--git-path', `agent-office-sync-${process.pid}.paths`], dir),
    gitOut(['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/'], dir),
    gitOut(['remote', 'get-url', 'origin'], dir),
    gitOut(['remote', 'get-url', '--push', '--all', 'origin'], dir),
  ]);
  if (!head) return { problem: `${name} has no commits yet, so there’s nothing to pull into.` };
  if (!branch) return { head, problem: `${name} isn’t on a branch (its HEAD is detached), so there’s nowhere to save to. Ask Claude to “put ${name} back on its branch”.` };
  const [common, ...where] = (gitPaths ?? '').split('\n').map((p) => path.resolve(dir, p.trim()));
  const unfinished = UNFINISHED.find((_, i) => where[i] && existsSync(where[i]));
  if (unfinished) return { branch, head, problem: `${name} is in the middle of ${unfinished[1]}, so it’s left alone. Ask Claude to “finish the ${unfinished[1].replace(/^an? /, '')} in ${name}”.` };
  const row = (heads ?? '').split('\n').map((l) => l.split('\0')).find((f) => f[0] === `refs/heads/${branch}`) ?? [];
  const [, upstreamRef, remote, remoteRef] = row;
  if (!upstreamRef) return { branch, head, problem: `The branch ${branch} in ${name} doesn’t follow a branch on GitHub, so there’s nothing to pull from or upload to. Publish it once with ⬆️ Push on the Git board, then sync.` };
  const github = fetchUrl && /github\.com[/:]/i.test(fetchUrl) ? normalizeRepo(fetchUrl) : undefined;
  const t: Tracking = { branch, head, upstreamRef, remote: remote || undefined, remoteRef: remoteRef || undefined, pathsFile: where[UNFINISHED.length], common, ...(github ? { github } : {}) };
  if (!t.remote || !t.remoteRef) return { ...t, problem: `The branch ${branch} in ${name} follows ${upstreamRef.replace(/^refs\/remotes\//, '')}, which isn’t a branch on GitHub. Ask Claude to “set ${branch} to follow its GitHub branch”.` };
  if (t.remote !== 'origin') t.noPush = `It follows ${t.remote}, not your own copy on GitHub (origin), so it’s pulled but never uploaded from here.`;
  else if (!fetchUrl) t.problem = `${name} has no origin to pull from.`;
  else if ((pushUrls ?? '') !== fetchUrl) t.noPush = 'Its origin uploads somewhere else than it downloads from, so it’s not uploaded from here. Check that remote before uploading.';
  return t;
}

interface Dirty {
  path: string;
  from?: string;
  status: SyncFile['status'];
}

/** `git status`: every uncommitted file, new ones one by one (ignored ones aren't listed: .gitignore holds). */
async function dirtyFiles(dir: string): Promise<Dirty[]> {
  const r = await git(['status', '--porcelain=v1', '-z', '-uall'], dir, 60_000, { GIT_OPTIONAL_LOCKS: '0' });
  if (r.code !== 0) throw new Error(`git status failed: ${r.err.trim() || r.code}`);
  const fields = r.out.split('\0');
  const out: Dirty[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy === '!!') continue;
    if (xy === '??') {
      out.push({ path: p, status: '?' });
      continue;
    }
    if (/[RC]/.test(xy)) {
      out.push({ path: p, from: fields[++i], status: 'R' });
      continue;
    }
    out.push({ path: p, status: xy.includes('D') ? 'D' : xy.includes('A') && !xy.includes('M') ? 'A' : 'M' });
  }
  return out;
}

/** Lines added to tracked files since the last commit, per file (to look for secrets in what's new). */
async function addedLines(dir: string): Promise<Map<string, string>> {
  const r = await git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--'], dir, 60_000, { GIT_OPTIONAL_LOCKS: '0' });
  const added = new Map<string, string>();
  if (r.code !== 0 || r.out.length > MAX_DIFF) return added;
  let file: string | undefined;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^"|"$/g, '');
      file = p === '/dev/null' ? undefined : p.replace(/^b\//, '');
    } else if (file && line.startsWith('+')) added.set(file, `${added.get(file) ?? ''}${line.slice(1)}\n`);
  }
  return added;
}

function head(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(SCAN_BYTES);
    const n = readSync(fd, buf, 0, SCAN_BYTES, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The review's view of each file: blocked (never), risky (unticked), or fine. Blocked folders are said once. */
async function reviewFiles(dir: string, dirty: Dirty[]): Promise<{ files: SyncFile[]; more: number }> {
  const added = dirty.some((d) => d.status !== '?' && d.status !== 'D') ? await addedLines(dir) : new Map<string, string>();
  const files: SyncFile[] = [];
  const blockedDirs = new Map<string, { reason: string; n: number }>();
  for (const d of dirty) {
    const blocked = blockedReason(d.path);
    if (blocked) {
      // node_modules/…, .agent-office/…: one line for the folder, not one per file.
      const parts = d.path.split('/');
      const at = parts.findIndex((s) => ['.agent-office', 'node_modules', 'dist', 'worktrees'].includes(s));
      const key = d.path.endsWith('/') || at < 0 ? d.path : `${parts.slice(0, at + 1).join('/')}/`;
      const b = blockedDirs.get(key) ?? { reason: blocked, n: 0 };
      b.n++;
      blockedDirs.set(key, b);
      continue;
    }
    const f: SyncFile = { path: d.path, status: d.status, ...(d.from ? { from: d.from } : {}) };
    let risky = riskyName(d.path);
    if (!risky && d.status !== 'D') {
      const full = path.join(dir, d.path);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        size = 0;
      }
      if (size > BIG_FILE) risky = `a big file (${(size / 1024 / 1024).toFixed(1)} MB)`;
      else if (d.status === '?') {
        const buf = head(full);
        if (buf && !buf.includes(0)) risky = riskyText(buf.toString('utf8'));
      } else {
        const text = added.get(d.path);
        if (text) risky = riskyText(text);
      }
    }
    if (risky) f.risky = risky;
    files.push(f);
  }
  const blocked: SyncFile[] = [...blockedDirs].map(([p, b]) => ({ path: b.n > 1 ? `${p} (${b.n} files)` : p, status: '?', blocked: b.reason }));
  const all = [...files.sort((a, b) => Number(!!a.risky) - Number(!!b.risky) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), ...blocked];
  return { files: all.slice(0, MAX_FILES), more: Math.max(0, all.length - MAX_FILES) };
}

/** Commits only here, and only on GitHub: `rev-list --left-right --count` output. */
function counts(out: string | undefined): { ahead: number; behind: number } {
  const [ahead, behind] = (out ?? '0\t0').split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

interface Reviewed {
  repo: SyncRepo;
  head?: string;
  /** Tickable paths (and a rename's old name), as reviewed. */
  paths: Map<string, string | undefined>;
  /** The shared .git folder (see Tracking.common). */
  common?: string;
  floorPath?: string;
  github?: string;
}

async function look(place: Place, fetch: boolean): Promise<Reviewed> {
  const repo: SyncRepo = { id: place.id, name: place.name, dir: place.dir, kind: place.kind, ahead: 0, behind: 0, outgoing: [], files: [], more: 0, suggested: '' };
  const paths = new Map<string, string | undefined>();
  if (place.error) return { repo: { ...repo, problem: `${place.name} can’t be read: ${place.error}` }, paths };
  try {
    const t = await tracking(place.dir, place.name);
    Object.assign(repo, { branch: t.branch, problem: t.problem, noPush: t.noPush });
    if (t.upstreamRef) repo.upstream = t.upstreamRef.replace(/^refs\/remotes\//, '');
    if (!t.problem && fetch && t.remote) await git(['fetch', '--quiet', t.remote], place.dir, 30_000).catch(() => undefined);
    const up = !t.problem && t.upstreamRef;
    // Coming in, counted along GitHub's own line of history: a merged pull request is one change.
    const [dirty, lr, incoming] = await Promise.all([
      dirtyFiles(place.dir),
      up ? gitOut(['rev-list', '--left-right', '--count', `HEAD...${t.upstreamRef}`], place.dir) : undefined,
      up ? gitOut(['rev-list', '--count', '--first-parent', `HEAD..${t.upstreamRef}`], place.dir) : undefined,
    ]);
    const { files, more } = await reviewFiles(place.dir, dirty);
    repo.files = files;
    repo.more = more;
    repo.suggested = suggestMessage(files.filter((f) => !f.blocked && !f.risky));
    for (const f of files) if (!f.blocked) paths.set(f.path, f.from);
    repo.ahead = counts(lr).ahead;
    repo.behind = Number(incoming) || 0;
    if (repo.ahead) repo.outgoing = ((await gitOut(['log', '-5', '--format=%s', `${t.upstreamRef}..HEAD`], place.dir)) ?? '').split('\n').filter(Boolean);
    return { repo, head: t.head, paths, common: t.common, floorPath: place.floorPath, github: t.github };
  } catch (err) {
    return { repo: { ...repo, problem: `${place.name} can’t be read: ${redact((err as Error).message)}` }, paths };
  }
}

// ---- The review ----------------------------------------------------------------------------------

interface Review {
  floorDir: string;
  at: number;
  repos: Map<string, Reviewed>;
}

const reviews = new Map<string, Review>();
let running = false;

/** What Go would do: each repository, its unsaved files (risky ones unticked, blocked ones out), and why any is skipped. */
export async function syncPlan(floorDir: string, admin: boolean, opts: { app?: string; fetch?: boolean } = {}): Promise<SyncPlan> {
  const app = 'app' in opts ? opts.app : officeRoot();
  const found = await places(floorDir, app);
  const looked = await pool(found.places, POOL, (p) => look(p, opts.fetch !== false));
  const now = Date.now();
  for (const [k, r] of reviews) if (now - r.at > REVIEW_MS) reviews.delete(k);
  if (reviews.size >= 50) reviews.delete(reviews.keys().next().value!);
  const token = randomUUID();
  reviews.set(token, { floorDir, at: now, repos: new Map(looked.map((l) => [l.repo.id, l])) });
  return { repos: looked.map((l) => l.repo), token, checkedAt: now, truncated: found.truncated, admin };
}

// ---- Go ------------------------------------------------------------------------------------------

function outcome(repo: SyncRepo, extra: Partial<SyncRepoResult> & Pick<SyncRepoResult, 'state' | 'message'>): SyncRepoResult {
  const details = extra.details ? redact(extra.details).slice(-20_000) : undefined;
  return { id: repo.id, name: repo.name, kind: repo.kind, saved: 0, pulled: 0, pushed: 0, prs: [], otherCommits: 0, news: [], ...extra, details };
}

/** A merge that stopped: undone at once, and checked that the folder is exactly as it was. */
async function undoMerge(dir: string, before: string, mergeLog: string): Promise<{ restored: boolean; clashes: string[]; log: string }> {
  const unmerged = ((await gitOut(['diff', '--name-only', '--diff-filter=U'], dir)) ?? '').split('\n').filter(Boolean);
  const clashes = unmerged.length ? unmerged : [...mergeLog.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/g)].map((m) => m[1]);
  let text = mergeLog;
  if (await gitOut(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir)) {
    const abort = await git(['merge', '--abort'], dir, 60_000);
    text += `\n${log('merge --abort', abort)}`;
  }
  const now = await gitOut(['rev-parse', 'HEAD'], dir);
  const merging = await gitOut(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir);
  const unmergedNow = ((await gitOut(['diff', '--name-only', '--diff-filter=U'], dir)) ?? '').split('\n').filter(Boolean);
  return { restored: now === before && !merging && !unmergedNow.length, clashes, log: text };
}

/** One repository: save the ticked files, pull, upload. Inside the Git board's lock for that checkout. */
async function syncOne(reviewed: Reviewed, choice: SyncChoice | undefined): Promise<SyncRepoResult> {
  const { repo } = reviewed;
  if (repo.problem) return outcome(repo, { state: 'skipped', message: repo.problem });
  const done = await withGitRepository(repo.dir, '.', 'syncing', async (dir): Promise<SyncRepoResult> => {
    const t = await tracking(dir, repo.name);
    if (t.problem) return outcome(repo, { state: 'skipped', message: t.problem });
    if (t.branch !== repo.branch) return outcome(repo, { state: 'skipped', message: `${repo.name} is on a different branch now (${t.branch}), so nothing was done. Press Sync again to check it.` });
    const lines: string[] = [];

    // 1. Save: only files that were on the review, ticked, and still unsaved.
    const wanted = (choice?.files ?? []).filter((p) => reviewed.paths.has(p));
    const now = new Map((await dirtyFiles(dir)).map((d) => [d.path, d]));
    const saving = wanted.filter((p) => now.has(p) && !blockedReason(p));
    let saved = 0;
    let commit: string | undefined;
    if (saving.length) {
      const message = (choice?.message ?? '').trim() || suggestMessage(saving.map((p) => now.get(p)!)) || 'Save work';
      const specs = [...new Set(saving.flatMap((p) => [p, ...(now.get(p)?.from ? [now.get(p)!.from!] : [])]))];
      // The list goes in a file in .git: a long command line would break on Windows.
      const file = t.pathsFile ?? path.join(dir, '.git', `agent-office-sync-${process.pid}.paths`);
      writeFileSync(file, specs.join('\0'));
      try {
        const add = await git(['add', '-A', `--pathspec-from-file=${file}`, '--pathspec-file-nul'], dir, 120_000, { GIT_LITERAL_PATHSPECS: '1' });
        lines.push(log('add -A <the ticked files>', add));
        if (add.code !== 0) return outcome(repo, { state: 'failed', message: `Couldn’t save the files in ${repo.name}. Nothing was committed.`, details: lines.join('\n') });
        // --only (the default with paths): anything else already staged stays staged, and out of this commit.
        const c = await git(['commit', '-q', '-m', message, `--pathspec-from-file=${file}`, '--pathspec-file-nul'], dir, 180_000, { GIT_LITERAL_PATHSPECS: '1' });
        lines.push(log(`commit -m "${message.split('\n')[0]}" <the ticked files>`, c));
        if (c.code !== 0) {
          const identity = /tell me who you are|empty ident|user\.email/i.test(c.err + c.out);
          return outcome(repo, {
            state: 'failed',
            message: identity ? `Git doesn’t know a name and email for commits in ${repo.name}, so nothing was saved. Ask Claude to “set up git’s name and email”.` : `Couldn’t commit in ${repo.name} (a commit check may have stopped it). Nothing was saved, pulled or uploaded.`,
            details: lines.join('\n'),
          });
        }
      } finally {
        rmSync(file, { force: true });
      }
      saved = saving.length;
    }
    const skipped = wanted.length - saving.length;

    // 2. Pull: GitHub's changes merged on top of the saved work.
    const f = await git(['fetch', '--quiet', t.remote!], dir, FETCH_MS);
    lines.push(log(`fetch ${t.remote}`, f));
    const [heads, lr] = await Promise.all([gitOut(['rev-parse', 'HEAD', t.upstreamRef!], dir), gitOut(['rev-list', '--left-right', '--count', `HEAD...${t.upstreamRef}`], dir)]);
    const [before, target] = (heads ?? '').split('\n');
    if (saved) commit = before.slice(0, 7);
    const savedText = saved ? `Saved ${plural(saved, 'file')}${commit ? ` (${commit})` : ''}` : 'Nothing to save';
    if (f.code !== 0 || !target) {
      return outcome(repo, { state: 'failed', saved, commit, message: `${savedText}${saved ? ' here' : ''}, but couldn’t reach GitHub, so nothing was pulled or uploaded. Check the internet connection and sync again.`, details: lines.join('\n') });
    }
    const incoming = counts(lr).behind;
    const news = incoming ? await mergedPrs(dir, before, target) : { prs: [], other: 0 };
    // Said along GitHub's own line of history: a merged pull request is one change, not two commits.
    const pulled = incoming ? Math.max(1, news.prs.length + news.other) : 0;
    if (incoming) {
      const m = await git(['merge', '--ff', '--no-edit', '--no-autostash', t.upstreamRef!], dir, 180_000, { GIT_MERGE_AUTOEDIT: 'no' });
      const mergeLog = log(`merge --ff --no-edit ${repo.upstream}`, m);
      lines.push(mergeLog);
      if (m.code !== 0) {
        const undo = await undoMerge(dir, before, mergeLog);
        lines.push(undo.log);
        const kept = saved ? `Your ${plural(saved, 'file')} ${saved === 1 ? 'is' : 'are'} saved in a commit here, not uploaded. ` : '';
        if (!undo.restored) {
          return outcome(repo, { state: 'failed', saved, commit, message: `${kept}The pull stopped halfway in ${repo.name} and couldn’t be undone by itself. Don’t restart the office. Ask Claude to “fix ${repo.name} after a failed pull”.`, details: lines.join('\n') });
        }
        const overwrite = /would be overwritten|untracked working tree files/i.test(mergeLog);
        if (undo.clashes.length && !overwrite) {
          return outcome(repo, { state: 'conflict', saved, commit, clashes: undo.clashes, message: `${kept}GitHub changed the same lines in ${list(undo.clashes)}, so nothing was merged or uploaded. Ask Claude to “merge GitHub’s changes into ${repo.name}”.`, details: lines.join('\n') });
        }
        const touched = [...mergeLog.matchAll(/^\t(.+)$/gm)].map((x) => x[1].trim());
        return outcome(repo, {
          state: 'failed',
          saved,
          commit,
          clashes: touched.length ? touched : undefined,
          message: overwrite
            ? `${kept}GitHub’s changes touch files that still have unsaved edits here${touched.length ? ` (${list(touched)})` : ''}, so nothing was merged. Save or tick those files, then sync again.`
            : `${kept}Git couldn’t finish the pull in ${repo.name}, so nothing was merged or uploaded.`,
          details: lines.join('\n'),
        });
      }
    }
    const [after, aheadOut] = incoming ? await Promise.all([gitOut(['rev-parse', 'HEAD'], dir), gitOut(['rev-list', '--count', `${t.upstreamRef}..HEAD`], dir)]) : [before, String(counts(lr).ahead)];

    // 3. Upload what GitHub doesn't have: never forced.
    const ahead = Number(aheadOut) || 0;
    let pushed = 0;
    let pushText = '';
    if (ahead && t.noPush) pushText = `not uploaded: ${t.noPush.replace(/^It /, 'it ')}`;
    else if (ahead) {
      const p = await git(['push', '--quiet', t.remote!, `refs/heads/${t.branch}:${t.remoteRef}`], dir, 180_000);
      lines.push(log(`push ${t.remote} ${t.branch}:${t.remoteRef}`, p));
      if (p.code !== 0) {
        const rejected = /rejected|non-fast-forward|fetch first/i.test(p.err);
        return outcome(repo, {
          state: 'failed',
          saved,
          commit,
          pulled,
          before,
          after,
          prs: news.prs,
          otherCommits: news.other,
          message: `${savedText}${pulled ? `, pulled ${plural(pulled, 'new change')}` : ''}, but the upload failed: ${rejected ? 'GitHub got newer changes meanwhile. Sync again.' : 'check the internet connection and your GitHub login, then sync again.'} Nothing was forced.`,
          details: lines.join('\n'),
        });
      }
      pushed = ahead;
      pushText = `uploaded ${plural(ahead, 'commit')}`;
    }
    const parts = [savedText, pushText || (saved ? '' : 'nothing to upload'), pulled ? `pulled ${plural(pulled, 'new change')}` : 'already had the latest'].filter(Boolean);
    const note = skipped ? ` ${plural(skipped, 'ticked file')} had no changes left to save.` : '';
    return outcome(repo, { state: 'done', saved, commit, pulled, pushed, before, after, prs: news.prs, otherCommits: news.other, message: `${parts.join(', ')}.${note}`, details: lines.join('\n') });
  });
  return typeof done === 'string' ? outcome(repo, { state: 'failed', message: /Hold on/.test(done) ? `${done} in ${repo.name}: sync again in a moment.` : `Couldn’t sync ${repo.name}: ${done}` }) : done;
}

/** Workers a restart would interrupt, on every floor. */
function busyWorkers(floors: OfficeFloor[]): UpdateWorker[] {
  return floors.flatMap((f) => (f.workers?.() ?? []).filter((w) => w.kind !== 'shell' && interruptedByRestart(w.status)).map((w) => ({ id: w.id, name: w.name, floor: f.name, status: w.status })));
}

/** The office restarts itself through the Windows launcher (personal/windows/host.mjs). */
function canRestart(): boolean {
  const l = (globalThis as Record<symbol, unknown>)[Symbol.for('agent-office.launcher')] as { restart?: unknown } | undefined;
  return typeof l?.restart === 'function';
}

/** What the app folder's new commits need: from the paths they change, before → after. */
export async function nextSteps(app: SyncRepoResult | undefined, appDir: string | undefined, floors: OfficeFloor[], restartable = canRestart()): Promise<NextSteps> {
  const busy = busyWorkers(floors);
  if (!app || !appDir || !app.before || !app.after || app.before === app.after) {
    return { areas: [], steps: [], news: [], busy, changed: false, appDir };
  }
  const diff = await gitOut(['diff', '--name-only', '--no-renames', `${app.before}..${app.after}`], appDir);
  const areas = changeAreas((diff ?? '').split('\n').filter(Boolean));
  return { areas, steps: planNextSteps(areas, appDir, { busy: busy.length, canRestart: restartable }), news: app.news, busy, changed: true, appDir };
}

/** Go: every repository on the review, then what to do next (from the app folder's new commits). */
export async function syncRun(floorDir: string, token: string, choices: SyncChoice[], floors: OfficeFloor[], opts: { restartable?: boolean } = {}): Promise<SyncResult | string> {
  const review = reviews.get(token);
  if (!review || !sameDir(review.floorDir, floorDir) || Date.now() - review.at > REVIEW_MS) return 'That review is out of date. Press Sync again to look afresh.';
  if (running) return 'Hold on: a sync is already running.';
  running = true;
  reviews.delete(token);
  try {
    const byId = new Map(choices.map((c) => [c.id, c]));
    const order = [...review.repos.values()].sort((a, b) => Number(a.repo.kind === 'office') - Number(b.repo.kind === 'office'));
    // Separate repositories side by side (git is slow to start on a busy machine); worktrees of one
    // repository share its refs, so those go one after another.
    const groups = new Map<string, Reviewed[]>();
    for (const r of order) {
      const key = (r.common ?? r.repo.dir).toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const done = new Map<Reviewed, SyncRepoResult>();
    await pool([...groups.values()], POOL, async (group) => {
      for (const r of group) done.set(r, await syncOne(r, byId.get(r.repo.id)));
    });
    // What's new, said the way the clipboard's What's new says a title; where the repository is, for its plain words.
    const results = order.map((r): SyncRepoResult => {
      const x = done.get(r)!;
      return { ...x, news: newsLines(x.prs, x.otherCommits, (t) => tidyTitle(t).replace(/[.!?…]+$/, '')), ...(r.floorPath ? { floorPath: r.floorPath } : {}), ...(r.github ? { github: r.github } : {}) };
    });
    const app = results.find((r) => r.kind === 'office');
    const appDir = order.find((r) => r.repo.kind === 'office')?.repo.dir;
    return { repos: results, next: await nextSteps(app, appDir, floors, opts.restartable ?? canRestart()) };
  } finally {
    running = false;
  }
}

function choicesOf(v: unknown): SyncChoice[] {
  if (!Array.isArray(v) || v.length > 100) throw new Error('Bad request');
  return v.map((c) => {
    const o = c as Record<string, unknown>;
    if (typeof o?.id !== 'string' || !Array.isArray(o.files) || o.files.length > 5000 || o.files.some((f) => typeof f !== 'string' || !f || f.length > 4096)) throw new Error('Bad request');
    return { id: o.id.slice(0, 4096), files: o.files as string[], message: typeof o.message === 'string' ? o.message.slice(0, 20_000) : '' };
  });
}

/** /api/git/sync-all: GET the review; POST …/run to do it (admins only). */
export async function routeSyncAll(p: string, method: string, body: Record<string, unknown>, floorDir: string, floors: OfficeFloor[], who: { admin: boolean }, app = officeRoot()): Promise<[number, unknown]> {
  if (p === '/api/git/sync-all' && method === 'GET') return [200, await syncPlan(floorDir, who.admin, { app })];
  if (p === '/api/git/sync-all/run' && method === 'POST') {
    if (!who.admin) return [403, { error: 'Only an admin can sync the office' }];
    const r = await syncRun(floorDir, typeof body.token === 'string' ? body.token.slice(0, 100) : '', choicesOf(body.choices ?? []), floors);
    return typeof r === 'string' ? [200, { error: r }] : [200, r];
  }
  return [404, { error: 'Not found' }];
}
