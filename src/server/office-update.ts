import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRepo } from '../shared/floors.js';
import {
  blocksIdleRestart,
  interruptedByRestart,
  type OfficeUpdateState,
  type UpdateOutcome,
  type UpdatePr,
  type UpdateRestartRecord,
  type UpdateStepId,
  type UpdateStepState,
  type UpdateWorker,
} from '../shared/office-update.js';
import { clearStaged, headOf, isLink, readBuildInfo, readJson, stagePaths, swapDistOnExit, writeBuildInfo, writeJson, type Applied, type StagedBuild } from './app-swap.js';
import { gitPull, officeRoot, type OfficeFloor } from './git-board.js';

// The guided office update: after a pull request for Agent Office itself is merged, the walkthrough
// (client ui/office-update.ts) does one step per button and checks it worked before moving on:
//   1. pull each floor that is a copy of the office's code (fast-forward only, as the Git board does);
//   2. pull the app folder the office runs from: a normal merge (it may have commits of its own), never
//      with unfinished work in it, and a clash is undone at once with `git merge --abort`;
//   3. new packages, when package-lock.json no longer matches node_modules: `npm ci` into a staging copy;
//   4. `npm run build` in that staging copy (<app>/.agent-office/app-update/next), so the running office's
//      own dist and node_modules are never touched while it runs;
//   5. restart through the Windows launcher, which switches the staged build in while the office is
//      stopped (app-swap.ts), then check the office came back on the new commit.
// Never resets, stashes, forces or deletes anything but its own staging folders.

const FETCH_MS = 2 * 60_000;
const FRESH_FETCH_MS = 15_000;
const MAX_PRS = 30;
const PACKAGES_TIMEOUT = 15 * 60_000;
const BUILD_TIMEOUT = 10 * 60_000;
const TAIL_LINES = 60;
const IDLE_CHECK_MS = 3000;

interface Run {
  out: string;
  err: string;
  code: number;
}

/** Runs git; a non-zero exit is a result. Never prompts for credentials: nobody could answer here. */
function git(args: string[], cwd: string, timeout = 30_000, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env } }, (err, stdout, stderr) => {
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

/** Credentials that could turn up in git or npm output, blanked before anything is shown or kept. */
export function redact(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,})\b/g, '***');
}

const clean = (text: string) => redact(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trim();

function mtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "PR #57", "PRs #57 and #58", or "5 pull requests". */
export function prText(prs: UpdatePr[]): string {
  if (!prs.length) return 'the new code';
  if (prs.length > 4) return `${prs.length} pull requests`;
  return `${prs.length === 1 ? 'PR' : 'PRs'} ${list(prs.map((p) => `#${p.number}`))}`;
}

function outcome(ok: boolean, message: string, extra: Partial<UpdateOutcome> = {}): UpdateOutcome {
  const details = extra.details ? clean(extra.details).slice(-20_000) : undefined;
  return { ok, message, ...extra, details: details || undefined, at: Date.now() };
}

/** Pull requests merged into `to` since `from`, from the merge commits on its own line of history. */
export async function mergedPrs(dir: string, from: string | undefined, to: string | undefined): Promise<{ prs: UpdatePr[]; other: number }> {
  if (!to) return { prs: [], other: 0 };
  const r = await git(['log', '--first-parent', `-n${MAX_PRS * 2}`, '--format=%H%x00%s%x00%b%x1e', from ? `${from}..${to}` : to, '--'], dir);
  if (r.code !== 0) return { prs: [], other: 0 };
  const prs: UpdatePr[] = [];
  let other = 0;
  for (const rec of r.out.split('\x1e')) {
    const [sha, subject, body = ''] = rec.replace(/^\s+/, '').split('\0');
    if (!sha || !subject) continue;
    const merge = /^Merge pull request #(\d+) from \S+/.exec(subject);
    const squash = /\(#(\d+)\)\s*$/.exec(subject);
    if (merge) prs.push({ number: Number(merge[1]), title: body.split('\n').map((l) => l.trim()).find(Boolean) ?? subject, sha });
    else if (squash) prs.push({ number: Number(squash[1]), title: subject.replace(/\s*\(#\d+\)\s*$/, ''), sha });
    else other++;
  }
  // Oldest first, as they were merged.
  return { prs: prs.slice(0, MAX_PRS).reverse(), other };
}

interface LockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
}

/**
 * Whether node_modules still matches package-lock.json: npm's record of what it installed
 * (node_modules/.package-lock.json) against what the lock asks for. `runtime`: a package the office
 * itself runs with changed, not only build tools.
 */
export function packageCheck(dir: string): { needed: boolean; runtime: boolean; changes: string[] } {
  const lock = readJson<{ packages?: Record<string, LockEntry> }>(path.join(dir, 'package-lock.json'))?.packages;
  if (!lock) return { needed: false, runtime: false, changes: [] };
  if (!existsSync(path.join(dir, 'node_modules'))) return { needed: true, runtime: true, changes: ['node_modules is missing'] };
  const have = readJson<{ packages?: Record<string, LockEntry> }>(path.join(dir, 'node_modules', '.package-lock.json'))?.packages;
  // npm writes that record on every install; without it there's nothing to compare with.
  if (!have) return { needed: false, runtime: false, changes: [] };
  const changes: string[] = [];
  let runtime = false;
  for (const [key, want] of Object.entries(lock)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const got = have[key];
    if (!got) {
      // Other platforms' builds of a tool are optional, and aren't installed here.
      if (want.optional || want.devOptional || want.peer) continue;
      changes.push(`${name} ${want.version ?? ''} (new)`.replace('  ', ' '));
    } else if (want.version && got.version !== want.version) changes.push(`${name} ${got.version ?? '?'} → ${want.version}`);
    else continue;
    if (!want.dev) runtime = true;
  }
  return { needed: changes.length > 0, runtime, changes: changes.slice(0, 60) };
}

/** Where npm is: next to the Node running the office (npm's own CLI, run by that Node, with no shell). */
function npmCommand(): { file: string; args: string[] } {
  const node = path.dirname(process.execPath);
  const cli = [process.env.npm_execpath, path.join(node, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(node, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) => f && /npm-cli\.js$/.test(f) && existsSync(f));
  return cli ? { file: process.execPath, args: [cli] } : { file: 'npm', args: [] };
}

/** The first line of a failed build or install that says what's wrong. */
export function summarize(tail: string): string | undefined {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick =
    lines.find((l) => /error TS\d+:/.test(l)) ??
    lines.find((l) => /^\[vite\]|Rollup failed|Could not resolve|is not exported by/.test(l)) ??
    lines.find((l) => /^npm (error|ERR!)/.test(l) && !/^npm (error|ERR!)\s*(code|path|errno|syscall|A complete log|$)/.test(l)) ??
    lines.find((l) => /\berror\b|Error:/i.test(l) && !/^npm (error|ERR!)/.test(l));
  return pick ? pick.replace(/^npm (error|ERR!)\s*/, '').slice(0, 300) : undefined;
}

/** A floor copy of the office's code, and how far behind GitHub it is. */
interface FloorCopy {
  name: string;
  dir: string;
  behind: number;
  dirty: number;
}

interface Job {
  kind: 'packages' | 'build';
  commit: string;
  startedAt: number;
  phase: string;
  lines: string[];
  finishedAt?: number;
  ok?: boolean;
}

interface Launcher {
  restart(): void;
}

/** The Windows launcher's host.mjs, when it runs this office and can start it again (personal/windows). */
function launcher(): Launcher | undefined {
  const l = (globalThis as Record<symbol, unknown>)[Symbol.for('agent-office.launcher')] as Launcher | undefined;
  return typeof l?.restart === 'function' ? l : undefined;
}

export interface UpdaterOptions {
  appDir: string;
  /** The commit the running office was built from, when that's known. */
  running?: string;
  /** The app folder's commit when the office started. */
  startupHead?: string;
  startedAt: number;
  /** Finds the launcher (tests stand in for it). */
  launcher?: () => Launcher | undefined;
  /** Switch a staged build in on the way out when no launcher will (off in tests). */
  exitSwap?: boolean;
}

export class OfficeUpdater {
  private job: Job | undefined;
  private busyWith: string | undefined;
  private outcomes: Partial<Record<UpdateStepId, UpdateOutcome>> = {};
  private outcomesFor: string | undefined;
  private skipped = new Set<UpdateStepId>();
  private waiter: { since: number; timer: NodeJS.Timeout } | undefined;
  private pending = false;
  private exitHooked = false;
  private fetchedAt = new Map<string, number>();
  /** From the latest look, for a restart by hand noticed only on the way out. */
  private lastFloors: OfficeFloor[] = [];
  private lastPrs: UpdatePr[] = [];

  constructor(private opts: UpdaterOptions) {
    if (readJson<StagedBuild>(this.paths.ready)) this.hookExitSwap();
  }

  get appDir() {
    return this.opts.appDir;
  }

  private get paths() {
    return stagePaths(this.opts.appDir);
  }

  private launcher(): Launcher | undefined {
    return (this.opts.launcher ?? launcher)();
  }

  /** Without a launcher to switch it in, a staged build (without new packages) goes in as the office stops. */
  private hookExitSwap() {
    if (this.exitHooked || this.opts.exitSwap === false || this.launcher()) return;
    this.exitHooked = true;
    const dir = this.opts.appDir;
    process.once('exit', () => {
      if (this.launcher()) return;
      this.recordOnExit();
      swapDistOnExit(dir);
    });
  }

  /** Stopped by hand with a build waiting (tray menu, Ctrl+C): who was busy, for the "continue" list. */
  private recordOnExit() {
    const ready = readJson<StagedBuild>(this.paths.ready);
    const last = this.record();
    if (!ready || (last && last.at >= this.opts.startedAt)) return;
    try {
      writeJson(this.paths.restart, { at: Date.now(), by: 'a restart by hand', expect: ready.commit, prs: this.lastPrs, busy: this.busy(this.lastFloors) } satisfies UpdateRestartRecord);
    } catch {
      // On the way out: nothing else to be done.
    }
  }

  private async fetch(dir: string, fresh: boolean) {
    const key = dir.toLowerCase();
    if (Date.now() - (this.fetchedAt.get(key) ?? 0) < (fresh ? FRESH_FETCH_MS : FETCH_MS)) return;
    this.fetchedAt.set(key, Date.now());
    await git(['fetch', '--quiet', 'origin'], dir, 90_000).catch(() => undefined);
  }

  /** The app folder's branch and the GitHub branch it follows. */
  private async tracking(): Promise<{ branch?: string; upstream?: string; upstreamRef?: string }> {
    const dir = this.opts.appDir;
    const branch = (await gitOut(['symbolic-ref', '--short', '-q', 'HEAD'], dir)) || undefined;
    if (!branch) return {};
    const upstreamRef = (await gitOut(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], dir)) || undefined;
    if (!upstreamRef || !(await gitOut(['rev-parse', '--verify', '--quiet', upstreamRef], dir))) return { branch };
    return { branch, upstreamRef, upstream: upstreamRef.replace(/^refs\/remotes\//, '') };
  }

  private async counts(dir: string, a: string, b: string): Promise<{ ahead: number; behind: number }> {
    const out = await gitOut(['rev-list', '--left-right', '--count', `${a}...${b}`], dir);
    const [ahead, behind] = (out ?? '0\t0').split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  /** Uncommitted files, new ones included: "XY path\0", a rename followed by its old name. */
  private async dirtyFiles(dir: string): Promise<string[]> {
    const r = await git(['status', '--porcelain=v1', '-z', '-unormal'], dir, 30_000, { GIT_OPTIONAL_LOCKS: '0' });
    if (r.code !== 0) return [];
    const fields = r.out.split('\0');
    const files: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const rec = fields[i];
      if (rec.length < 4) continue;
      files.push(rec.slice(3));
      if (/[RC]/.test(rec.slice(0, 2))) i++;
    }
    return files;
  }

  /** Who a repository is: owner/name on GitHub, else its origin's address. */
  private async origin(dir: string): Promise<string | undefined> {
    const url = await gitOut(['remote', 'get-url', 'origin'], dir);
    if (!url) return undefined;
    const github = /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
    if (github) return `github:${github.toLowerCase()}`;
    const local = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : path.resolve(dir, url);
    return local.replace(/[\\/]+$/, '').replace(/\.git$/i, '').toLowerCase();
  }

  /** The office's floors that are checkouts of its own code (not the app folder itself). */
  private async floorCopies(floors: OfficeFloor[], fresh: boolean): Promise<FloorCopy[]> {
    const app = this.opts.appDir;
    const mine = await this.origin(app);
    if (!mine) return [];
    const out: FloorCopy[] = [];
    for (const f of floors) {
      try {
        if (path.resolve(f.dir).toLowerCase() === path.resolve(app).toLowerCase()) continue;
        const top = await gitOut(['rev-parse', '--show-toplevel'], f.dir);
        if (!top || path.resolve(top).toLowerCase() !== path.resolve(f.dir).toLowerCase()) continue;
        if ((await this.origin(f.dir)) !== mine) continue;
        await this.fetch(f.dir, fresh);
        const branch = await gitOut(['symbolic-ref', '--short', '-q', 'HEAD'], f.dir);
        const up = branch ? await gitOut(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], f.dir) : undefined;
        const behind = up && (await gitOut(['rev-parse', '--verify', '--quiet', up], f.dir)) ? (await this.counts(f.dir, 'HEAD', up)).behind : 0;
        out.push({ name: f.name, dir: f.dir, behind, dirty: (await this.dirtyFiles(f.dir)).length });
      } catch {
        // Not a readable checkout: not one of the office's copies, then.
      }
    }
    return out;
  }

  private busy(floors: OfficeFloor[], which = interruptedByRestart): UpdateWorker[] {
    return floors.flatMap((f) =>
      (f.workers?.() ?? []).filter((w) => w.kind !== 'shell' && which(w.status)).map((w) => ({ id: w.id, name: w.name, floor: f.name, status: w.status })),
    );
  }

  /** What the office runs: its build's own record, else the commit it started on (see startupSnapshot). */
  private running(): string | undefined {
    return this.opts.running;
  }

  /** The commit the dist folder in the app folder was built from, if it can be told. */
  private async distCommit(head: string | undefined): Promise<string | undefined> {
    const dist = path.join(this.opts.appDir, 'dist');
    const info = readBuildInfo(dist);
    if (info) return info.commit;
    const built = Math.min(mtime(path.join(dist, 'public', 'index.html')) ?? NaN, mtime(path.join(dist, 'server', 'server', 'server.js')) ?? NaN);
    if (Number.isNaN(built) || !head) return undefined;
    const log = await gitOut(['rev-parse', '--git-path', 'logs/HEAD'], this.opts.appDir);
    const changed = log ? mtime(path.resolve(this.opts.appDir, log)) : undefined;
    // A build by hand after the checkout last changed is a build of what's checked out.
    return changed === undefined || built >= changed ? head : undefined;
  }

  private ready(head: string | undefined): StagedBuild | undefined {
    const r = readJson<StagedBuild>(this.paths.ready);
    return r && head && r.commit === head ? r : undefined;
  }

  private stagedPackages(head: string | undefined): boolean {
    const s = readJson<{ commit: string; packages: boolean }>(path.join(this.paths.next, '.stage.json'));
    return !!(head && ((s?.packages && s.commit === head && existsSync(path.join(this.paths.next, 'node_modules'))) || this.ready(head)?.packages));
  }

  private restartInfo(): OfficeUpdateState['restart'] {
    if (this.launcher()) return { available: true };
    if (process.stdin.isTTY) return { available: false, reason: 'powershell' };
    return { available: false, reason: process.platform === 'win32' ? 'old-launcher' : 'other' };
  }

  private record(): UpdateRestartRecord | undefined {
    return readJson<UpdateRestartRecord>(this.paths.restart);
  }

  /** How the last restart for an update went: back on the commit it should be, or why not. */
  private async lastRestart(floors: OfficeFloor[]): Promise<OfficeUpdateState['last']> {
    const record = this.record();
    if (!record) return undefined;
    const workers = new Map(floors.flatMap((f) => (f.workers?.() ?? []).map((w) => [w.id, { w, floor: f.name }] as const)));
    const now = record.busy.map((b) => {
      const found = workers.get(b.id);
      return found ? { ...b, status: found.w.status, name: found.w.name } : { ...b, gone: true };
    });
    const base = { ...record, now };
    if (this.opts.startedAt < record.at) return { ...base, verdict: 'pending', message: 'The office hasn’t restarted yet.' };
    const applied = readJson<Applied>(this.paths.applied);
    const since = applied && applied.at >= record.at - 5000 ? applied : undefined;
    if (since?.state === 'rolled-back') {
      return { ...base, verdict: 'rolled-back', message: 'The new version didn’t start, so the office went back to the previous one. Nothing is lost. Ask Claude to “find out why the new version of the office didn’t start”.', details: since.error };
    }
    const running = this.running();
    const live = !!running && (running === record.expect || (await git(['merge-base', '--is-ancestor', record.expect, running], this.opts.appDir)).code === 0);
    if (live) {
      const missing: UpdatePr[] = [];
      for (const pr of record.prs) if ((await git(['merge-base', '--is-ancestor', pr.sha, running!], this.opts.appDir)).code !== 0) missing.push(pr);
      if (!missing.length) return { ...base, verdict: 'live' };
      return { ...base, verdict: 'old-code', message: `The office restarted, but ${prText(missing)} ${missing.length === 1 ? 'isn’t' : 'aren’t'} in what it runs.`, details: `Running ${running}` };
    }
    let message = 'The office restarted, but it’s still running the old version: the new build wasn’t switched in.';
    if (since?.state === 'skipped') message = 'The office restarted, but on its old build: the app folder changed after the build. Build again, then restart.';
    if (since?.state === 'failed') message = 'The office restarted, but couldn’t switch to the new build. If a program has the app folder open (like VS Code), close it, then restart again.';
    return { ...base, verdict: 'old-code', message, details: [since?.error, `Expected ${record.expect}, running ${running ?? 'an unknown build'}.`].filter(Boolean).join('\n') };
  }

  /** Everything the walkthrough shows. */
  async state(floors: OfficeFloor[], admin: boolean, fresh = false): Promise<OfficeUpdateState | undefined> {
    const dir = this.opts.appDir;
    const top = await gitOut(['rev-parse', '--show-toplevel'], dir);
    if (!top || path.resolve(top).toLowerCase() !== path.resolve(dir).toLowerCase()) return undefined;
    await this.fetch(dir, fresh);
    const [{ branch, upstream, upstreamRef }, head, dirty, originUrl] = await Promise.all([this.tracking(), gitOut(['rev-parse', '--verify', '--quiet', 'HEAD'], dir), this.dirtyFiles(dir), gitOut(['remote', 'get-url', 'origin'], dir)]);
    const target = upstreamRef ? await gitOut(['rev-parse', '--verify', '--quiet', upstreamRef], dir) : undefined;
    const counts = upstreamRef ? await this.counts(dir, 'HEAD', upstreamRef) : { ahead: 0, behind: 0 };
    const key = target ?? head;
    if (key !== this.outcomesFor) {
      this.outcomesFor = key;
      this.outcomes = {};
      this.skipped.clear();
    }
    const [floorsNow, found, distCommit] = await Promise.all([this.floorCopies(floors, fresh), mergedPrs(dir, this.running() ?? this.opts.startupHead, target ?? head), this.distCommit(head)]);
    this.lastFloors = floors;
    this.lastPrs = found.prs;
    const pc = packageCheck(dir);
    const packagesStaged = this.stagedPackages(head);
    const ready = this.ready(head);
    const running = this.running();
    const steps: Record<UpdateStepId, UpdateStepState> = {
      floor: floorsNow.every((f) => f.behind === 0) ? 'done' : this.skipped.has('floor') ? 'skipped' : 'todo',
      app: counts.behind === 0 ? 'done' : 'todo',
      packages: counts.behind > 0 ? 'todo' : !pc.needed ? 'skipped' : packagesStaged ? 'done' : 'todo',
      build: counts.behind === 0 && (running === head || !!ready || (distCommit === head && !pc.needed)) ? 'done' : 'todo',
      restart: counts.behind === 0 && !!running && running === head ? 'done' : 'todo',
    };
    const job = this.job;
    const build: OfficeUpdateState['build'] = job && !job.finishedAt
      ? { state: job.kind === 'packages' ? 'packages' : 'building', phase: job.phase, startedAt: job.startedAt, commit: job.commit, tail: clean(job.lines.slice(-12).join('\n')) }
      : ready
        ? { state: 'ready', commit: ready.commit, finishedAt: ready.builtAt }
        : job && !job.ok && job.commit === head
          ? { state: 'failed', commit: job.commit, startedAt: job.startedAt, finishedAt: job.finishedAt }
          : { state: 'idle' };
    const restart = this.restartInfo();
    if (this.waiter) restart.waiting = this.waiter.since;
    if (this.pending) restart.pending = true;
    if (!restart.available && ready?.packages) restart.needsPackagesByHand = true;
    return {
      appDir: dir,
      branch,
      upstream,
      target,
      github: originUrl && /github\.com[/:]/i.test(originUrl) ? normalizeRepo(originUrl) : undefined,
      admin,
      prs: found.prs,
      otherCommits: found.other,
      floors: floorsNow,
      app: { ...counts, dirty: dirty.slice(0, 200), head },
      packages: { ...pc, staged: packagesStaged },
      build,
      running: { commit: running, startedAt: this.opts.startedAt },
      restart,
      busy: this.busy(floors),
      steps,
      outcomes: this.outcomes,
      last: await this.lastRestart(floors),
    };
  }

  private note(step: UpdateStepId, o: UpdateOutcome): UpdateOutcome {
    this.outcomes[step] = o;
    return o;
  }

  /** One thing at a time: a pull, the packages, a build. */
  private busyNow(): string | undefined {
    if (this.job && !this.job.finishedAt) return this.job.kind === 'packages' ? 'Hold on: the new packages are still installing.' : 'Hold on: the build is still running.';
    if (this.busyWith) return `Hold on: still ${this.busyWith}.`;
    return undefined;
  }

  // ---- 1. The floor ------------------------------------------------------------------------------

  async pullFloors(floors: OfficeFloor[]): Promise<UpdateOutcome> {
    const wait = this.busyNow();
    if (wait) return outcome(false, wait);
    this.busyWith = 'pulling the floor';
    try {
      const copies = (await this.floorCopies(floors, true)).filter((f) => f.behind > 0);
      if (!copies.length) return this.note('floor', outcome(true, 'The floor already has the latest code.'));
      const problems: string[] = [];
      const details: string[] = [];
      for (const f of copies) {
        const err = await gitPull(f.dir, '.');
        details.push(`${f.name} (${f.dir}): ${err ? redact(err) : 'pulled'}`);
        if (err) problems.push(floorProblem(err));
      }
      const after = await this.floorCopies(floors, false);
      const still = after.filter((f) => copies.some((c) => c.dir === f.dir) && f.behind > 0);
      const names = list(copies.map((f) => f.name));
      if (!problems.length && !still.length) return this.note('floor', outcome(true, `Pulled. The ${names} floor ${copies.length === 1 ? 'is' : 'are'} up to date, so new workers start from the latest code.`, { details: details.join('\n') }));
      const why = problems[0] ?? 'GitHub still has changes the floor doesn’t.';
      return this.note('floor', outcome(false, `Couldn’t pull the ${names} floor. ${why} Nothing was changed there. Ask Claude to “update the agent-office floor”, or skip this step: the office doesn’t need it to update.`, { details: details.join('\n') }));
    } finally {
      this.busyWith = undefined;
    }
  }

  skip(step: UpdateStepId) {
    if (step === 'floor') this.skipped.add(step);
  }

  // ---- 2. The app folder ---------------------------------------------------------------------------

  async pullApp(): Promise<UpdateOutcome> {
    const wait = this.busyNow();
    if (wait) return outcome(false, wait);
    this.busyWith = 'pulling the app folder';
    try {
      return this.note('app', await this.mergeApp());
    } catch (err) {
      return this.note('app', outcome(false, 'Couldn’t pull the app folder. Nothing was changed.', { details: String((err as Error).message ?? err) }));
    } finally {
      this.busyWith = undefined;
    }
  }

  private async mergeApp(): Promise<UpdateOutcome> {
    const dir = this.opts.appDir;
    const { branch, upstreamRef, upstream } = await this.tracking();
    if (!branch) return outcome(false, 'The app folder isn’t on a branch, so there’s nothing to pull into. Ask Claude to “put the app folder back on the personal branch”.');
    if (!upstreamRef) return outcome(false, `The app folder’s branch (${branch}) doesn’t follow a branch on GitHub, so there’s nothing to pull from.`);
    const remote = upstream!.split('/')[0];
    const fetched = await git(['fetch', '--quiet', remote], dir, 120_000);
    if (fetched.code !== 0) return outcome(false, 'Couldn’t reach GitHub, so nothing was pulled. Check the internet connection and try again.', { details: fetched.err || fetched.out });
    this.fetchedAt.set(dir.toLowerCase(), Date.now());

    const dirty = await this.dirtyFiles(dir);
    if (dirty.length) {
      return outcome(false, `Stopped: someone’s unfinished work is in the app folder (${plural(dirty.length, 'file')}), so nothing was pulled. Ask Claude to “finish or commit the work in the app folder”, then try again.`, {
        details: `Uncommitted files in ${dir}:\n${dirty.join('\n')}`,
      });
    }
    const before = await gitOut(['rev-parse', 'HEAD'], dir);
    const target = await gitOut(['rev-parse', upstreamRef], dir);
    const { prs } = await mergedPrs(dir, this.running() ?? this.opts.startupHead, target);
    const { ahead, behind } = await this.counts(dir, 'HEAD', upstreamRef);
    const aheadNote = (n: number) => (n > 0 ? [`The app folder also has ${plural(n, 'commit')} that ${n === 1 ? 'isn’t' : 'aren’t'} on GitHub yet. That’s fine: ${n === 1 ? 'it stays' : 'they stay'}. When you’re ready, ⬆️ Push uploads ${n === 1 ? 'it' : 'them'}.`] : []);
    if (behind === 0) return outcome(true, 'The app folder already has the latest code.', { notes: aheadNote(ahead) });

    // A merge, not a rebase: commits made in this folder stay as they are. --ff makes it a plain
    // fast-forward when the folder has none. Local changes are never stashed.
    const merged = await git(['merge', '--ff', '--no-edit', '--no-autostash', upstreamRef], dir, 180_000, { GIT_MERGE_AUTOEDIT: 'no' });
    const mergeLog = `$ git merge --ff --no-edit ${upstream}\n${merged.out}${merged.err}`;
    if (merged.code !== 0) return this.undoMerge(before, mergeLog);

    const now = await gitOut(['rev-parse', 'HEAD'], dir);
    const after = await this.counts(dir, 'HEAD', upstreamRef);
    const hasTarget = !!target && (await git(['merge-base', '--is-ancestor', target, 'HEAD'], dir)).code === 0;
    const missing: UpdatePr[] = [];
    for (const pr of prs) if ((await git(['merge-base', '--is-ancestor', pr.sha, 'HEAD'], dir)).code !== 0) missing.push(pr);
    const details = `${mergeLog}\nBefore: ${before}\nNow:    ${now}`;
    if (after.behind > 0 || !hasTarget || missing.length) return outcome(false, 'Pulled, but GitHub already has even newer changes. Press the button again.', { details });
    const what = prs.length ? `${prText(prs)} ${prs.length === 1 ? 'is' : 'are'} now in the app folder.` : 'The app folder has the latest code.';
    return outcome(true, `Pulled. ${what}`, { notes: aheadNote(after.ahead), details });
  }

  /** A merge that stopped: undone at once, then checked that the folder is exactly as it was. */
  private async undoMerge(before: string | undefined, mergeLog: string): Promise<UpdateOutcome> {
    const dir = this.opts.appDir;
    const unmerged = ((await gitOut(['diff', '--name-only', '--diff-filter=U'], dir)) ?? '').split('\n').filter(Boolean);
    const clashes = unmerged.length ? unmerged : [...mergeLog.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/g)].map((m) => m[1]);
    const merging = await gitOut(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir);
    let log = mergeLog;
    if (merging) {
      const abort = await git(['merge', '--abort'], dir, 60_000);
      log += `\n$ git merge --abort\n${abort.out}${abort.err}${abort.code === 0 ? 'done' : `failed (exit ${abort.code})`}`;
    }
    const head = await gitOut(['rev-parse', 'HEAD'], dir);
    const dirty = await this.dirtyFiles(dir);
    const stillMerging = await gitOut(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir);
    const restored = head === before && !dirty.length && !stillMerging;
    if (!restored) {
      return outcome(false, 'The pull stopped halfway and couldn’t be undone by itself. Don’t restart the office. Ask Claude to “fix the app folder after a failed pull”.', {
        details: `${log}\nThe folder was at ${before}, it is at ${head}.${dirty.length ? `\nChanged files:\n${dirty.join('\n')}` : ''}`,
      });
    }
    log += `\nThe folder is back as it was, at ${before}.`;
    if (clashes.length) {
      return outcome(false, `Nothing changed. These files clash: ${list(clashes.slice(0, 8))}${clashes.length > 8 ? ` and ${clashes.length - 8} more` : ''}. Ask Claude to “update the app folder”.`, { details: log });
    }
    const identity = /tell me who you are|empty ident|user\.email/i.test(mergeLog);
    return outcome(false, identity ? 'Nothing changed. Git doesn’t know a name and email for commits in the app folder, so it couldn’t save the pull. Ask Claude to “set up git’s name and email in the app folder”.' : 'Nothing changed. Git couldn’t finish the pull. Ask Claude to “update the app folder”.', { details: log });
  }

  // ---- 3 and 4. Packages and the build, in the staging copy ---------------------------------------

  private startJob(kind: Job['kind'], commit: string, work: (job: Job) => Promise<UpdateOutcome>) {
    const job: Job = { kind, commit, startedAt: Date.now(), phase: 'Getting ready…', lines: [] };
    this.job = job;
    const step: UpdateStepId = kind === 'packages' ? 'packages' : 'build';
    delete this.outcomes[step];
    void work(job)
      .then((o) => {
        job.ok = o.ok;
        this.note(step, o);
      })
      .catch((err) => {
        job.ok = false;
        this.note(step, outcome(false, kind === 'packages' ? 'Couldn’t get the new packages. The running office is untouched.' : 'The build failed. The running office is untouched.', { details: `${String((err as Error).message ?? err)}\n\n${job.lines.slice(-TAIL_LINES).join('\n')}` }));
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
  }

  /** A fresh copy of the commit's files in the staging folder: the app folder's own index is left alone. */
  private async copyCommit(commit: string) {
    const dir = this.opts.appDir;
    const { stage, next } = this.paths;
    await clearStaged(dir);
    rmSync(this.paths.ready, { force: true });
    mkdirSync(next, { recursive: true });
    const index = path.join(stage, `index-${process.pid}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      const read = await git(['read-tree', commit], dir, 60_000, env);
      if (read.code !== 0) throw new Error(`git read-tree: ${read.err || read.out}`);
      const prefix = `${path.relative(dir, next).split(path.sep).join('/')}/`;
      const out = await git(['checkout-index', '-a', '-f', `--prefix=${prefix}`], dir, 300_000, env);
      if (out.code !== 0) throw new Error(`git checkout-index: ${out.err || out.out}`);
    } finally {
      rmSync(index, { force: true });
    }
  }

  private npm(job: Job, args: string[], cwd: string, timeout: number, phaseOf: (line: string) => string | undefined): Promise<void> {
    const { file, args: pre } = npmCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...pre, ...args], {
        cwd,
        windowsHide: true,
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let partial = '';
      const take = (chunk: Buffer) => {
        const text = partial + chunk.toString('utf8');
        const parts = text.split(/\r?\n/);
        partial = parts.pop() ?? '';
        for (const raw of parts) {
          const line = clean(raw);
          if (!line) continue;
          job.lines.push(line);
          if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
          const phase = phaseOf(line);
          if (phase) job.phase = phase;
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGKILL');
        reject(new Error(`npm ${args[0]} took more than ${Math.round(timeout / 60_000)} minutes and was stopped`));
      }, timeout);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('npm wasn’t found next to Node on the office’s computer') : err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (partial.trim()) job.lines.push(clean(partial));
        if (code === 0) resolve();
        else reject(new Error(`npm ${args.join(' ')} failed (exit ${code})`));
      });
    });
  }

  /** Step 3: the new packages, installed into the staging copy with npm ci (the running office's node_modules is left alone). */
  startPackages(): string | undefined {
    const wait = this.busyNow();
    if (wait) return wait;
    const head = headOf(this.opts.appDir);
    if (!head) return 'Couldn’t read the app folder’s commit.';
    if (!packageCheck(this.opts.appDir).needed) return 'No new packages are needed.';
    this.startJob('packages', head, async (job) => {
      job.phase = 'Copying the code to the staging folder…';
      await this.copyCommit(head);
      const next = this.paths.next;
      // npm ci empties node_modules first: never let that be a link to the app folder's own.
      if (existsSync(path.join(next, 'node_modules')) || isLink(path.join(next, 'node_modules'))) throw new Error('the staging copy already has a node_modules');
      job.phase = 'Installing the packages… (this can take a few minutes)';
      try {
        await this.npm(job, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], next, PACKAGES_TIMEOUT, (l) => (/^added \d+ packages?/.test(l) ? 'Packages installed' : undefined));
      } catch (err) {
        const tail = job.lines.slice(-TAIL_LINES).join('\n');
        const why = summarize(tail);
        return outcome(false, 'Couldn’t get the new packages. The running office is untouched. Ask Claude to “install the new packages for the app folder”.', { details: `${why ? `The problem: ${why}\n\n` : ''}${(err as Error).message}\n\n${tail}` });
      }
      writeJson(path.join(next, '.stage.json'), { commit: head, packages: true });
      return outcome(true, 'The new packages are ready. They switch in when the office restarts.', { details: job.lines.slice(-TAIL_LINES).join('\n') });
    });
    return undefined;
  }

  /** Step 4: `npm run build` in the staging copy, then checked and marked ready for the restart. */
  startBuild(): string | undefined {
    const wait = this.busyNow();
    if (wait) return wait;
    const dir = this.opts.appDir;
    const head = headOf(dir);
    if (!head) return 'Couldn’t read the app folder’s commit.';
    const needed = packageCheck(dir).needed;
    const staged = readJson<{ commit: string; packages: boolean }>(path.join(this.paths.next, '.stage.json'));
    const reuse = staged?.commit === head && existsSync(path.join(this.paths.next, 'package.json'));
    if (needed && !(reuse && staged?.packages)) return 'Get the new packages first (step 3).';
    if (!needed && !existsSync(path.join(dir, 'node_modules'))) return 'The app folder has no node_modules to build with.';
    this.startJob('build', head, async (job) => {
      const next = this.paths.next;
      if (!reuse) {
        job.phase = 'Copying the code to the staging folder…';
        await this.copyCommit(head);
        writeJson(path.join(next, '.stage.json'), { commit: head, packages: false });
      }
      rmSync(this.paths.ready, { force: true });
      rmSync(path.join(next, 'dist'), { recursive: true, force: true });
      const packages = !!(reuse && staged?.packages);
      // Same packages as the running office: the copy uses the app folder's node_modules, linked (read only).
      if (!packages && !existsSync(path.join(next, 'node_modules'))) symlinkSync(path.join(dir, 'node_modules'), path.join(next, 'node_modules'), 'junction');
      job.phase = 'Building…';
      try {
        await this.npm(job, ['run', 'build'], next, BUILD_TIMEOUT, (l) => (/build:client/.test(l) ? 'Building the screens…' : /build:server/.test(l) ? 'Building the server…' : undefined));
        for (const f of ['dist/server/server/cli.js', 'dist/public/index.html']) if (!existsSync(path.join(next, f))) throw new Error(`the build didn’t make ${f}`);
        writeBuildInfo(path.join(next, 'dist'), head);
      } catch (err) {
        const tail = job.lines.slice(-TAIL_LINES).join('\n');
        const why = summarize(tail);
        return outcome(false, 'The build failed. The running office is untouched. Ask Claude to “fix the build in the app folder”.', { details: `${why ? `The problem: ${why}\n\n` : ''}${(err as Error).message}\n\n${tail}` });
      }
      writeJson(this.paths.ready, { commit: head, builtAt: Date.now(), packages } satisfies StagedBuild);
      this.hookExitSwap();
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      return outcome(true, `Built in ${secs < 90 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`}. It switches in when the office restarts.`, { details: job.lines.slice(-TAIL_LINES).join('\n') });
    });
    return undefined;
  }

  // ---- 5. Restart --------------------------------------------------------------------------------

  /**
   * `now`: restart, once `confirm`ed when it would interrupt busy workers. `idle`: as soon as nobody
   * is working. `cancel`: stop waiting.
   */
  async requestRestart(floors: OfficeFloor[], mode: 'now' | 'idle' | 'cancel', confirm: boolean, by: string): Promise<{ confirm?: UpdateWorker[]; restarting?: boolean; waiting?: boolean } | string> {
    if (mode === 'cancel') {
      this.stopWaiting();
      return {};
    }
    if (!this.launcher()) return 'This office can’t restart itself. The window shows how to restart it by hand.';
    const wait = this.busyNow();
    if (wait) return wait;
    if (this.pending) return 'The office is already restarting.';
    if (mode === 'idle') {
      this.stopWaiting();
      if (!this.busy(floors, blocksIdleRestart).length) {
        await this.restartNow(floors, by);
        return { restarting: true };
      }
      const tick = () => {
        if (this.busy(floors, blocksIdleRestart).length || this.busyNow()) return;
        this.stopWaiting();
        void this.restartNow(floors, by);
      };
      this.waiter = { since: Date.now(), timer: setInterval(tick, IDLE_CHECK_MS) };
      return { waiting: true };
    }
    const busy = this.busy(floors);
    if (busy.length && !confirm) return { confirm: busy };
    this.stopWaiting();
    await this.restartNow(floors, by);
    return { restarting: true };
  }

  private stopWaiting() {
    if (this.waiter) clearInterval(this.waiter.timer);
    this.waiter = undefined;
  }

  /** Saves who was busy and what should be running afterwards, then asks the launcher for a restart. */
  private async restartNow(floors: OfficeFloor[], by: string) {
    const dir = this.opts.appDir;
    const head = headOf(dir);
    const { upstreamRef } = await this.tracking();
    const target = upstreamRef ? await gitOut(['rev-parse', upstreamRef], dir) : undefined;
    const { prs } = await mergedPrs(dir, this.running() ?? this.opts.startupHead, target ?? head);
    const record: UpdateRestartRecord = { at: Date.now(), by, expect: head ?? '', prs, busy: this.busy(floors) };
    writeJson(this.paths.restart, record);
    this.pending = true;
    // A moment for the answer to reach the page first (the route answers at once, see routeOfficeUpdate).
    setTimeout(() => this.launcher()?.restart(), 1500);
  }

  /** The walkthrough's "Close" after a restart: the update bar goes away until the next merge. */
  acknowledge() {
    const record = this.record();
    if (record) writeJson(this.paths.restart, { ...record, acknowledged: true });
  }
}

function floorProblem(err: string): string {
  if (/Hold on/.test(err)) return err;
  if (/not possible to fast-forward|diverg|non-fast-forward|reconcile/i.test(err)) return 'It has commits of its own that aren’t on GitHub, so it can’t be pulled with one click.';
  if (/would be overwritten|local changes/i.test(err)) return 'It has unfinished changes in files this update touches.';
  if (/could not resolve host|unable to access|could not read from remote/i.test(err)) return 'Couldn’t reach GitHub. Check the internet connection and try again.';
  return 'Git couldn’t pull it.';
}

/**
 * What the office was started on, taken once as the server starts: the build's own record (written
 * by step 4), else the app folder's commit when its build is newer than its last change.
 */
function startupSnapshot(appDir: string | undefined): Pick<UpdaterOptions, 'running' | 'startupHead'> {
  if (!appDir) return {};
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const head = headOf(appDir);
  const info = readBuildInfo(dist);
  if (info) return { running: info.commit, startupHead: head };
  const built = Math.min(mtime(path.join(dist, 'public', 'index.html')) ?? NaN, mtime(path.join(dist, 'server', 'server', 'server.js')) ?? NaN);
  let changed: number | undefined;
  try {
    const gitDir = path.join(appDir, '.git');
    changed = mtime(path.join(statSync(gitDir).isDirectory() ? gitDir : appDir, 'logs', 'HEAD'));
  } catch {
    changed = undefined;
  }
  const running = head && !Number.isNaN(built) && (changed === undefined || built >= changed) ? head : undefined;
  return { running, startupHead: head };
}

const APP_DIR = officeRoot();
const STARTUP = { ...startupSnapshot(APP_DIR), startedAt: Date.now() - process.uptime() * 1000 };
let updater: OfficeUpdater | undefined;

/** The office's own updater, when it runs from a checkout of its code. */
export function officeUpdater(): OfficeUpdater | undefined {
  if (!APP_DIR) return undefined;
  updater ??= new OfficeUpdater({ appDir: APP_DIR, ...STARTUP });
  return updater;
}

// A build staged before this start is still waiting: be ready to switch it in on the way out.
if (APP_DIR && existsSync(stagePaths(APP_DIR).ready)) officeUpdater();

const STEP_IDS = new Set<UpdateStepId>(['floor', 'app', 'packages', 'build', 'restart']);

/** /api/git/office/update/…: GET the walkthrough's state; POST a step (admins only). */
export async function routeOfficeUpdate(p: string, method: string, q: URLSearchParams, body: Record<string, unknown>, floors: OfficeFloor[], who: { admin: boolean; name: string }, u = officeUpdater()): Promise<[number, unknown]> {
  if (!u) return [200, { state: null }];
  const reply = async (extra: Record<string, unknown> = {}): Promise<[number, unknown]> => [200, { ...extra, state: (await u.state(floors, who.admin)) ?? null }];
  if (method === 'GET' && p === '/api/git/office/update') return [200, { state: (await u.state(floors, who.admin, q.get('fresh') === '1')) ?? null }];
  if (method !== 'POST') return [404, { error: 'Not found' }];
  if (!who.admin) return [403, { error: 'Only an admin can update the office' }];
  switch (p) {
    case '/api/git/office/update/pull-floors':
      return reply({ outcome: await u.pullFloors(floors) });
    case '/api/git/office/update/pull-app':
      return reply({ outcome: await u.pullApp() });
    case '/api/git/office/update/packages': {
      const error = u.startPackages();
      return error ? reply({ error }) : reply();
    }
    case '/api/git/office/update/build': {
      const error = u.startBuild();
      return error ? reply({ error }) : reply();
    }
    case '/api/git/office/update/restart': {
      const mode = body.mode === 'idle' || body.mode === 'cancel' ? body.mode : 'now';
      const r = await u.requestRestart(floors, mode, body.confirm === true, who.name);
      // Restarting: answer now, before the office goes, rather than after reading everything again.
      if (typeof r === 'object' && r.restarting) return [200, { restarting: true }];
      return typeof r === 'string' ? reply({ error: r }) : reply(r);
    }
    case '/api/git/office/update/skip': {
      if (typeof body.step === 'string' && STEP_IDS.has(body.step as UpdateStepId)) u.skip(body.step as UpdateStepId);
      return reply();
    }
    case '/api/git/office/update/done':
      u.acknowledge();
      return reply();
  }
  return [404, { error: 'Not found' }];
}
