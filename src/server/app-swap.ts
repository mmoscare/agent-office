import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import path from 'node:path';

// A build of the office staged for its next start (office-update.ts builds it in
// <app folder>/.agent-office/app-update/next, beside the running one), switched in while the office
// is stopped: by the Windows launcher's host.mjs just before it starts the office, or on the way out
// when nothing else will. The previous build is kept, so a new version that doesn't start is put back.
// Only ever renames inside the app folder, and only removes its own staging folders.

export const STAGE_DIR = path.join('.agent-office', 'app-update');

/** A finished build waiting for the restart (ready.json). */
export interface StagedBuild {
  commit: string;
  builtAt: number;
  /** It comes with its own node_modules (new packages), not the running office's. */
  packages: boolean;
}

/** What a build is of (dist/build-info.json), valid while the files it was written with are unchanged. */
export interface BuildInfo {
  commit: string;
  builtAt: number;
  stamp: { index: number; server: number };
}

/** What the last start did with a staged build (applied.json). */
export interface Applied {
  commit: string;
  at: number;
  packages: boolean;
  state: 'applied' | 'skipped' | 'rolled-back' | 'failed';
  /** The staging folder holding the build it replaced. */
  backup?: string;
  /** Why it was skipped, failed or put back. */
  error?: string;
  /** The office started on it. */
  confirmed?: boolean;
}

export function stagePaths(appDir: string) {
  const stage = path.join(appDir, STAGE_DIR);
  return {
    stage,
    next: path.join(stage, 'next'),
    ready: path.join(stage, 'ready.json'),
    applied: path.join(stage, 'applied.json'),
    rollback: path.join(stage, 'rollback.json'),
    restart: path.join(stage, 'restart.json'),
  };
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function removeFile(file: string) {
  rmSync(file, { force: true });
}

function mtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The two files every build writes afresh, so a later build in place shows up as a different stamp. */
function distStamp(dist: string): BuildInfo['stamp'] | undefined {
  const index = mtime(path.join(dist, 'public', 'index.html'));
  const server = mtime(path.join(dist, 'server', 'server', 'server.js'));
  return index === undefined || server === undefined ? undefined : { index, server };
}

export function writeBuildInfo(dist: string, commit: string) {
  const stamp = distStamp(dist);
  if (!stamp) throw new Error('the build is missing dist/public/index.html or dist/server/server/server.js');
  writeJson(path.join(dist, 'build-info.json'), { commit, builtAt: Date.now(), stamp } satisfies BuildInfo);
}

/** The commit a dist folder was built from, unless it has been rebuilt in place since. */
export function readBuildInfo(dist: string): BuildInfo | undefined {
  const info = readJson<BuildInfo>(path.join(dist, 'build-info.json'));
  const stamp = distStamp(dist);
  if (!info || !stamp || typeof info.commit !== 'string') return undefined;
  return info.stamp?.index === stamp.index && info.stamp?.server === stamp.server ? info : undefined;
}

export function headOf(appDir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: appDir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function checkInside(stage: string, target: string) {
  const rel = path.relative(stage, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to remove ${target}: it is not inside ${stage}`);
}

/** Removes one of the staging folders. A linked node_modules goes first, as a link: never what it points to. */
export function removeStaged(stage: string, target: string) {
  checkInside(stage, target);
  const modules = path.join(target, 'node_modules');
  if (isLink(modules)) unlinkSync(modules);
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** removeStaged without holding up the running office (an old node_modules takes a while to delete). */
export async function removeStagedAsync(stage: string, target: string) {
  checkInside(stage, target);
  const modules = path.join(target, 'node_modules');
  if (isLink(modules)) await unlink(modules);
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** The previous and failed builds kept in the staging folder, and the staging copy itself. */
export function staged(appDir: string): string[] {
  const { stage, next } = stagePaths(appDir);
  if (!existsSync(stage)) return [];
  const found = readdirSync(stage).filter((name) => /^(previous|failed)-\d+$/.test(name)).map((name) => path.join(stage, name));
  return existsSync(next) || isLink(next) ? [...found, next] : found;
}

export async function clearStaged(appDir: string) {
  const { stage } = stagePaths(appDir);
  for (const target of staged(appDir)) await removeStagedAsync(stage, target);
}

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A rename, retried for a moment while Windows (an antivirus scan, an indexer) still holds a file in it. */
function rename(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      pause(200);
    }
  }
}

/** Renames in order; if one fails, the ones done are undone and the error is thrown. */
export function moveAll(moves: [string, string][]) {
  const done: [string, string][] = [];
  try {
    for (const [from, to] of moves) {
      rename(from, to);
      done.push([from, to]);
    }
  } catch (err) {
    for (const [from, to] of done.reverse()) {
      try {
        rename(to, from);
      } catch {
        // Nothing more to be done here: the error below says what went wrong first.
      }
    }
    throw err;
  }
}

function why(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') return `a program is still using files in the app folder (${e.code}${e.path ? `: ${e.path}` : ''})`;
  return e.message ?? String(err);
}

/**
 * Switches the staged build in: the running office's dist (and node_modules, when the build brought
 * new packages) move to a previous-<time> folder and the staged ones take their place.
 */
function swap(appDir: string, ready: StagedBuild): string {
  const { stage, next } = stagePaths(appDir);
  const backup = path.join(stage, `previous-${Date.now()}`);
  mkdirSync(backup, { recursive: true });
  const moves: [string, string][] = [];
  const dist = path.join(appDir, 'dist');
  if (existsSync(dist)) moves.push([dist, path.join(backup, 'dist')]);
  moves.push([path.join(next, 'dist'), dist]);
  if (ready.packages) {
    const modules = path.join(next, 'node_modules');
    if (!existsSync(modules) || isLink(modules)) throw new Error('the staged build has no packages of its own');
    const live = path.join(appDir, 'node_modules');
    if (existsSync(live)) moves.push([live, path.join(backup, 'node_modules')]);
    moves.push([modules, live]);
  }
  moveAll(moves);
  return path.basename(backup);
}

export interface StartResult {
  /** A staged build was switched in for this start. */
  swapped: boolean;
  /** Something to say in the office's log. */
  message?: string;
}

/**
 * Before the office starts (the launcher's host.mjs, with nothing of the app loaded yet): put the
 * previous build back if the new one failed to start, else switch in a staged build that's still
 * of the checked-out commit.
 */
export function beforeStart(appDir: string): StartResult {
  const p = stagePaths(appDir);
  if (existsSync(p.rollback)) return rollBack(appDir);
  const ready = readJson<StagedBuild>(p.ready);
  if (!ready) return { swapped: false };
  const record = (state: Applied['state'], error?: string, backup?: string) => {
    writeJson(p.applied, { commit: ready.commit, at: Date.now(), packages: !!ready.packages, state, error, backup } satisfies Applied);
    removeFile(p.ready);
  };
  const head = headOf(appDir);
  if (head !== ready.commit) {
    record('skipped', head ? `the app folder moved on to ${head.slice(0, 7)} after the build of ${ready.commit.slice(0, 7)}` : "couldn't read the app folder's commit");
    return { swapped: false, message: 'The staged build is out of date, so the office starts on its current build.' };
  }
  if (!existsSync(path.join(p.next, 'dist', 'server', 'server', 'cli.js'))) {
    record('failed', 'the staged build is incomplete');
    return { swapped: false, message: 'The staged build is incomplete, so the office starts on its current build.' };
  }
  try {
    record('applied', undefined, swap(appDir, ready));
    return { swapped: true, message: `Switched to the new build of ${ready.commit.slice(0, 7)}.` };
  } catch (err) {
    record('failed', why(err));
    return { swapped: false, message: `Couldn't switch to the new build (${why(err)}), so the office starts on its current build.` };
  }
}

/**
 * On the office's way out when no launcher will switch the build in (Ctrl+C in PowerShell, or a
 * launcher from before this): the build's dist goes in now, so starting again runs it. New packages
 * can't: the running office holds node_modules open, so those wait for the launcher or `npm ci`.
 */
export function swapDistOnExit(appDir: string) {
  const p = stagePaths(appDir);
  const ready = readJson<StagedBuild>(p.ready);
  if (!ready || ready.packages || existsSync(p.rollback)) return;
  if (headOf(appDir) !== ready.commit) return;
  try {
    const backup = swap(appDir, ready);
    writeJson(p.applied, { commit: ready.commit, at: Date.now(), packages: false, state: 'applied', backup } satisfies Applied);
    removeFile(p.ready);
  } catch (err) {
    console.error(`agent-office: couldn't switch to the new build on the way out: ${why(err)}`);
  }
}

/** The office didn't start on the build just switched in: put the previous one back at the next start. */
export function startFailed(appDir: string, error: string): boolean {
  const p = stagePaths(appDir);
  const applied = readJson<Applied>(p.applied);
  if (applied?.state !== 'applied' || applied.confirmed || !applied.backup) return false;
  writeJson(p.rollback, { at: Date.now(), error: error.slice(0, 4000) });
  return true;
}

/** The office is up on the build just switched in. */
export function startSucceeded(appDir: string) {
  const p = stagePaths(appDir);
  const applied = readJson<Applied>(p.applied);
  if (applied?.state === 'applied' && !applied.confirmed) writeJson(p.applied, { ...applied, confirmed: true });
}

function rollBack(appDir: string): StartResult {
  const p = stagePaths(appDir);
  const failure = readJson<{ error?: string }>(p.rollback);
  const applied = readJson<Applied>(p.applied);
  const backup = applied?.backup ? path.join(p.stage, applied.backup) : undefined;
  const error = failure?.error ?? 'the new version stopped while starting';
  if (!applied || !backup || !existsSync(path.join(backup, 'dist'))) {
    if (applied) writeJson(p.applied, { ...applied, state: 'failed', error: `${error} (and there was no previous build to go back to)` });
    removeFile(p.rollback);
    return { swapped: false, message: "The new version didn't start, and there's no previous build to go back to." };
  }
  const failed = path.join(p.stage, `failed-${Date.now()}`);
  mkdirSync(failed, { recursive: true });
  const moves: [string, string][] = [
    [path.join(appDir, 'dist'), path.join(failed, 'dist')],
    [path.join(backup, 'dist'), path.join(appDir, 'dist')],
  ];
  if (applied.packages && existsSync(path.join(backup, 'node_modules'))) {
    moves.push([path.join(appDir, 'node_modules'), path.join(failed, 'node_modules')], [path.join(backup, 'node_modules'), path.join(appDir, 'node_modules')]);
  }
  try {
    moveAll(moves.filter(([from]) => existsSync(from)));
  } catch (err) {
    writeJson(p.applied, { ...applied, state: 'failed', error: `${error}; putting the previous build back failed too: ${why(err)}` });
    removeFile(p.rollback);
    return { swapped: false, message: `The new version didn't start, and putting the previous one back failed: ${why(err)}` };
  }
  writeJson(p.applied, { ...applied, state: 'rolled-back', error });
  removeFile(p.rollback);
  return { swapped: false, message: "The new version didn't start, so the office went back to the previous one." };
}
