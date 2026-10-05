import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The VP's verify (see vp.ts): the exact result of merging a pull request, checked the way the repo
// checks itself, away from the live app. `git merge-tree --write-tree` gives the merge result's tree;
// `git archive` puts that tree in a short throwaway folder under the temp directory (not a git worktree,
// and never linked to the running office's node_modules); dependencies come from a cache keyed by the
// lock file, installed with --ignore-scripts; then the repo's recipe runs, one step at a time, each
// with a timeout, at below-normal priority, and only while the machine isn't under pressure. One
// verify runs at a time in the whole building (every floor's VP is in this one office process).

/** One command of a recipe. `npm`: npm <args>; `bin`: a package's bin with node; `node`: node <args>; `tests: 'related'`: the node:test files related to the change. */
export type RecipeStep = {
  name: string;
  /** Minutes before it's stopped: a timed-out step is "not verified", never a pass. */
  timeoutMin?: number;
  /** When it fails, run it on the base tree too and count only failures the base doesn't have. */
  baseline?: boolean;
} & ({ npm: string[] } | { bin: [pkg: string, bin: string]; args: string[] } | { node: string[] } | { tests: 'related'; exclude?: string[] });

export interface Recipe {
  /** Where it came from: the office's built-in one for agent-office, or detected from package.json. */
  source: 'agent-office' | 'detected' | 'saved';
  /** Install dependencies into the cache (npm ci, or npm install without a lock file) first. */
  install: boolean;
  steps: RecipeStep[];
  /** No step at all is still a pass (the owner said so in the saved recipe): otherwise it's "no checks". */
  allowNoChecks?: boolean;
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  /** The end of what it printed, when it failed. */
  detail?: string;
  timedOut?: boolean;
  /** Tests that failed on the base tree as well, so they don't count. */
  baseline?: string[];
  skipped?: string;
}

export interface VerifyOutcome {
  /** Passed every step on this exact tree. */
  ok: boolean;
  /** Why it isn't verified, when it isn't. */
  reason?: string;
  /** 'conflict': it doesn't merge; 'failed': a check failed; 'timeout': a step ran out of time; 'pressure': the machine never calmed down; 'error': something else went wrong. */
  kind?: 'conflict' | 'failed' | 'timeout' | 'pressure' | 'error';
  base: string;
  head: string;
  tree?: string;
  conflicts?: string[];
  steps: StepResult[];
  startedAt: number;
  ms: number;
}

export interface VerifyEnv {
  /** Why the machine is under pressure right now, or undefined (see machine.ts). */
  pressure(): string | undefined;
  /** Where the throwaway folders and the node_modules cache go: short, under the temp directory. */
  tmpRoot?: string;
  log?(line: string): void;
  /** How often to look again while the machine is under pressure, and for how long at most. */
  pressurePollMs?: number;
  pressureMaxMs?: number;
}

const MIN = 60_000;
const DEFAULT_TIMEOUT_MIN = 20;
const INSTALL_TIMEOUT_MIN = 20;
/** How much of a failed step's output is kept for the record. */
const DETAIL_MAX = 4000;
/** Node caches kept (one per lock file); the oldest go. */
const KEEP_CACHES = 3;
/** The tests that never exit on Windows (a headless ConPTY stays open): never part of a verify. */
export const NEVER_TESTS = ['tests/console-shell.test.ts'];

export function vpTmpRoot(): string {
  return path.join(os.tmpdir(), 'aovp');
}

// ---- One verify at a time, building-wide ------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
let holder: string | undefined;
let waiting = 0;

/** Who holds the building's verify slot now, and how many wait for it. */
export function verifySlot(): { holder?: string; waiting: number } {
  return { holder, waiting };
}

/** Runs `fn` once nothing else is verifying anywhere in the office. */
export function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
  waiting++;
  const run = chain.then(async () => {
    waiting--;
    holder = label;
    try {
      return await fn();
    } finally {
      holder = undefined;
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

// ---- Running commands -----------------------------------------------------------------------

export interface RunResult {
  code: number;
  out: string;
  timedOut: boolean;
  ms: number;
}

/** Stops a process and everything it started. */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** The office's environment, minus what would change how a child's own test runner behaves. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Set by an outer node --test: an inner one would then report to it instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Runs a command at below-normal priority, keeping the end of its output; stops it (and its children) at `timeoutMs`. */
export function runLow(file: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = baseEnv(), input?: NodeJS.ReadableStream): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    let child;
    try {
      child = spawn(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, out: (err as Error).message, timedOut: false, ms: Date.now() - started });
      return;
    }
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // not allowed here: it runs at normal priority
    }
    let inputError: Error | undefined;
    if (input && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // BSD tar may stop after the archive end marker before Git writes its padding.
        // A closed pipe (EPIPE; EOF on Windows) is decided by the child's exit status; other input failures fail the step.
        if (err.code !== 'EPIPE' && err.code !== 'EOF') inputError = err;
        input.unpipe(child.stdin!);
        input.resume();
      });
      input.pipe(child.stdin);
    }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\n${err.message}`, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: inputError ? -1 : code ?? -1, out: inputError ? `${out}\n${inputError.message}` : out, timedOut, ms: Date.now() - started });
    });
  });
}

function git(args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, out: stdout ?? '', err: stderr || (err ? err.message : '') });
    });
  });
}

/** npm's own CLI script beside this node, so npm runs without a shell (Windows won't spawn npm.cmd directly). */
function npmCommand(): { file: string; pre: string[]; shell: boolean } {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) candidates.unshift(process.env.npm_execpath);
  const cli = candidates.find((c) => existsSync(c));
  if (cli) return { file: process.execPath, pre: [cli], shell: false };
  return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', pre: [], shell: process.platform === 'win32' };
}

/** A package's bin script, from its package.json, to run with node. */
function binScript(dir: string, pkg: string, bin: string): string | undefined {
  try {
    const json = JSON.parse(readFileSync(path.join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof json.bin === 'string' ? json.bin : json.bin?.[bin];
    return rel ? path.join(dir, 'node_modules', pkg, rel) : undefined;
  } catch {
    return undefined;
  }
}

/** Children see a CI machine: no watch modes, no prompts, no colour codes in the record. */
function stepEnv(): NodeJS.ProcessEnv {
  return { ...baseEnv(), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
}

// ---- The machine ----------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits while the machine is under pressure; resolves to why it gave up, or undefined once it's calm. */
export async function waitForCalm(env: VerifyEnv, what: string): Promise<string | undefined> {
  const poll = env.pressurePollMs ?? 15_000;
  const max = env.pressureMaxMs ?? 30 * MIN;
  const started = Date.now();
  let told = false;
  for (;;) {
    const why = env.pressure();
    if (!why) return undefined;
    if (Date.now() - started >= max) return `the machine stayed under pressure (${why}) for ${Math.round(max / MIN)} minutes`;
    if (!told) env.log?.(`⏸ Waiting before ${what}: ${why}`);
    told = true;
    await sleep(poll);
  }
}

// ---- The merge result -----------------------------------------------------------------------

/** The tree of merging `head` into `base` (both commits in `repoDir`), or the files that conflict. */
export async function mergeTree(repoDir: string, base: string, head: string): Promise<{ tree: string } | { conflicts: string[] } | { error: string }> {
  const r = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], repoDir);
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(lines[0] ?? '')) return { tree: lines[0] };
  if (r.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0] ?? '')) return { conflicts: [...new Set(lines.slice(1))] };
  return { error: (r.err || r.out).trim().split('\n').pop() || `git merge-tree exited ${r.code}` };
}

/** Puts `tree` of `repoDir` in `dest` (made empty first): git archive into tar. */
export async function extractTree(repoDir: string, tree: string, dest: string): Promise<string | undefined> {
  mkdirSync(dest, { recursive: true });
  const archive = spawn('git', ['archive', '--format=tar', tree], { cwd: repoDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let archiveErr = '';
  archive.stderr.on('data', (c: Buffer) => (archiveErr += c.toString()));
  const archiveDone = new Promise<number>((resolve) => {
    archive.on('error', () => resolve(-1));
    archive.on('close', (code) => resolve(code ?? -1));
  });
  const untar = await runLow('tar', ['-x', '-f', '-', '-C', dest], dest, 10 * MIN, process.env, archive.stdout);
  const code = await archiveDone;
  if (code !== 0) return `git archive failed: ${archiveErr.trim() || `exit ${code}`}`;
  if (untar.code !== 0) return `tar failed: ${untar.out.trim().slice(-300) || `exit ${untar.code}`}`;
  return undefined;
}

/** Removes a throwaway folder without following its node_modules link into the cache. */
export function removeTree(dir: string) {
  const nm = path.join(dir, 'node_modules');
  try {
    if (lstatSync(nm).isSymbolicLink()) unlinkLink(nm);
  } catch {
    // no link
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a file still held open (Windows): the next verify's cleanup gets it
  }
}

function unlinkLink(p: string) {
  try {
    unlinkSync(p);
  } catch {
    rmSync(p, { recursive: false, force: true });
  }
}

// ---- Dependencies ---------------------------------------------------------------------------

/** The cache key for a tree's dependencies: its lock file (or package.json) and this node's version. */
export function modulesKey(dir: string): { key: string; lock: boolean } | undefined {
  const lock = path.join(dir, 'package-lock.json');
  const pkg = path.join(dir, 'package.json');
  const file = existsSync(lock) ? lock : existsSync(pkg) ? pkg : undefined;
  if (!file) return undefined;
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return { key: createHash('sha256').update(`${process.version}\n${text}`).digest('hex').slice(0, 16), lock: file === lock };
}

/** Makes `dir/node_modules` a link to the dependency cache for its lock file, installing it there first when it's new. */
export async function linkModules(dir: string, tmpRoot: string, env: VerifyEnv): Promise<StepResult> {
  const started = Date.now();
  const k = modulesKey(dir);
  if (!k) return { name: 'install', ok: true, ms: 0, skipped: 'no package.json' };
  const cacheDir = path.join(tmpRoot, 'nm', k.key);
  const done = path.join(cacheDir, '.installed');
  if (!existsSync(done)) {
    const calm = await waitForCalm(env, 'installing dependencies');
    if (calm) return { name: 'install', ok: false, ms: Date.now() - started, detail: calm };
    rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(cacheDir, { recursive: true });
    copyFileSync(path.join(dir, 'package.json'), path.join(cacheDir, 'package.json'));
    if (k.lock) copyFileSync(path.join(dir, 'package-lock.json'), path.join(cacheDir, 'package-lock.json'));
    for (const rc of ['.npmrc']) if (existsSync(path.join(dir, rc))) copyFileSync(path.join(dir, rc), path.join(cacheDir, rc));
    env.log?.(`📦 Installing dependencies into the cache (${k.key})`);
    const npm = npmCommand();
    const args = k.lock ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
    const r = npm.shell ? await runShell(npm.file, args, cacheDir, INSTALL_TIMEOUT_MIN * MIN) : await runLow(npm.file, [...npm.pre, ...args], cacheDir, INSTALL_TIMEOUT_MIN * MIN, stepEnv());
    if (r.code !== 0) {
      rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 });
      return { name: 'install', ok: false, ms: Date.now() - started, timedOut: r.timedOut, detail: tail(r.out) };
    }
    writeFileSync(done, new Date().toISOString());
    pruneCaches(path.join(tmpRoot, 'nm'), k.key);
  }
  const link = path.join(dir, 'node_modules');
  if (existsSync(link)) removeTree(link);
  symlinkSync(path.join(cacheDir, 'node_modules'), link, process.platform === 'win32' ? 'junction' : 'dir');
  return { name: 'install', ok: true, ms: Date.now() - started };
}

/** npm through the shell, only where npm-cli.js can't be found: its arguments here are fixed words. */
function runShell(file: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const cmd = process.env.ComSpec || 'cmd.exe';
  return runLow(cmd, ['/d', '/s', '/c', [file, ...args].join(' ')], cwd, timeoutMs, stepEnv());
}

function pruneCaches(root: string, keep: string) {
  try {
    const dirs = readdirSync(root)
      .map((name) => ({ name, at: statSync(path.join(root, name)).mtimeMs }))
      .filter((d) => d.name !== keep)
      .sort((a, b) => b.at - a.at);
    for (const d of dirs.slice(KEEP_CACHES - 1)) rmSync(path.join(root, d.name), { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // nothing to prune
  }
}

// ---- Recipes --------------------------------------------------------------------------------

/** The office's own checks, for agent-office: both typechecks, the related tests (new failures only) and the build. */
export function agentOfficeRecipe(): Recipe {
  return {
    source: 'agent-office',
    install: true,
    steps: [
      { name: 'typecheck (server)', bin: ['typescript', 'tsc'], args: ['-p', 'tsconfig.server.json', '--noEmit'], timeoutMin: 15 },
      { name: 'typecheck (client)', bin: ['typescript', 'tsc'], args: ['-p', 'tsconfig.client.json', '--noEmit'], timeoutMin: 15 },
      { name: 'related tests', tests: 'related', exclude: NEVER_TESTS, baseline: true, timeoutMin: 25 },
      { name: 'build', npm: ['run', 'build'], timeoutMin: 20 },
    ],
  };
}

/** What a repository's package.json says it can check: its typecheck, lint, test and build scripts. */
export function detectRecipe(dir: string): Recipe {
  let pkg: { name?: string; scripts?: Record<string, string> } | undefined;
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    pkg = undefined;
  }
  if (pkg?.name === 'agent-office') return agentOfficeRecipe();
  const scripts = pkg?.scripts ?? {};
  const steps: RecipeStep[] = [];
  const typecheck = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s]);
  if (typecheck) steps.push({ name: typecheck, npm: ['run', typecheck] });
  if (scripts.lint) steps.push({ name: 'lint', npm: ['run', 'lint'] });
  if (scripts.test && !/no test specified/i.test(scripts.test)) steps.push({ name: 'test', npm: ['test'], baseline: true, timeoutMin: 25 });
  if (scripts.build) steps.push({ name: 'build', npm: ['run', 'build'] });
  return { source: 'detected', install: !!pkg, steps };
}

// ---- Tests ----------------------------------------------------------------------------------

/**
 * The node:test files related to what changed: changed test files, the test named after each changed
 * source file, and the tests that import one. Never the ones in `exclude`.
 */
export function relatedTests(dir: string, changed: string[], exclude: string[] = NEVER_TESTS): string[] {
  const testsDir = path.join(dir, 'tests');
  let all: string[];
  try {
    all = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
  } catch {
    return [];
  }
  const skip = new Set(exclude.map((e) => e.replace(/\\/g, '/')));
  const out = new Set<string>();
  const names = new Set<string>();
  for (const raw of changed) {
    const file = raw.replace(/\\/g, '/');
    if (/^tests\/.+\.test\.ts$/.test(file) && all.includes(file)) out.add(file);
    const m = /^(?:src\/.+\/|bin\/)([^/]+)\.(?:ts|js|mjs)$/.exec(file);
    if (m) names.add(m[1]);
  }
  for (const name of names) {
    const own = `tests/${name}.test.ts`;
    if (all.includes(own)) out.add(own);
    const needle = new RegExp(`[/'"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js|\\.ts)?['"]`);
    for (const t of all) {
      if (out.has(t)) continue;
      try {
        if (needle.test(readFileSync(path.join(dir, t), 'utf8'))) out.add(t);
      } catch {
        // unreadable: skip it
      }
    }
  }
  return [...out].filter((t) => !skip.has(t)).sort();
}

/**
 * The tests that failed, from node's TAP output: each "not ok" with the names it's nested under
 * (and its file, where the diagnostics say), so a base run's failures can be told apart.
 */
export function tapFailures(out: string): string[] {
  const lines = out.split(/\r?\n/);
  const stack: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(lines[i]);
    if (sub) {
      const depth = Math.floor(sub[1].length / 4);
      stack.length = depth;
      stack[depth] = sub[2].trim();
      continue;
    }
    const bad = /^(\s*)not ok \d+ - (.*?)(?:\s+#.*)?$/.exec(lines[i]);
    if (!bad) continue;
    const depth = Math.floor(bad[1].length / 4);
    let file = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
      const loc = /location: '(.+?)(?::\d+:\d+)?'/.exec(lines[j]);
      if (loc) {
        file = path.basename(loc[1].replace(/\\\\/g, '\\'));
        break;
      }
      if (/^\s*(?:not )?ok \d+ /.test(lines[j]) || /^\s*# Subtest:/.test(lines[j])) break;
    }
    const names = [...stack.slice(0, depth), bad[2].trim()];
    failed.push(`${file ? `${file} › ` : ''}${names.join(' › ')}`);
  }
  return [...new Set(failed)];
}

function tail(out: string): string {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return clean.length > DETAIL_MAX ? `…${clean.slice(-DETAIL_MAX)}` : clean;
}

// ---- A step ---------------------------------------------------------------------------------

interface StepRun {
  result: RunResult;
  /** The test files it ran, for a related-tests step. */
  files?: string[];
  skipped?: string;
}

/** Runs one step in `dir`. A tests step runs `files` when given (the base run takes the merge result's list). */
async function runStep(step: RecipeStep, dir: string, changed: string[], files?: string[]): Promise<StepRun> {
  const timeout = (step.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * MIN;
  const env = stepEnv();
  if ('tests' in step) {
    files ??= relatedTests(dir, changed, step.exclude);
    if (!files.length) return { result: { code: 0, out: '', timedOut: false, ms: 0 }, skipped: 'no related tests', files };
    const args = ['--import', 'tsx', '--test', '--test-force-exit', '--test-timeout=120000', '--test-reporter=tap', ...files];
    return { result: await runLow(process.execPath, args, dir, timeout, env), files };
  }
  if ('bin' in step) {
    const script = binScript(dir, step.bin[0], step.bin[1]);
    if (!script) return { result: { code: -1, out: `${step.bin[0]} isn't installed (no ${step.bin[1]} in node_modules/${step.bin[0]})`, timedOut: false, ms: 0 } };
    return { result: await runLow(process.execPath, [script, ...step.args], dir, timeout, env) };
  }
  if ('node' in step) return { result: await runLow(process.execPath, step.node, dir, timeout, env) };
  const npm = npmCommand();
  return { result: npm.shell ? await runShell(npm.file, step.npm, dir, timeout) : await runLow(npm.file, [...npm.pre, ...step.npm], dir, timeout, env) };
}

// ---- The verify -----------------------------------------------------------------------------

export interface VerifyRequest {
  /** The repository's checkout (the floor's, or one in a floor that's a folder of them), with base and head fetched. */
  repoDir: string;
  /** Commits: the base branch's tip and the PR's head, as fetched. */
  base: string;
  head: string;
  recipe: Recipe;
  /** For the log and the building's verify slot: "PR #12". */
  label: string;
}

/**
 * Verifies the exact result of merging `head` into `base`: in a throwaway folder, with the recipe's
 * steps. Waits its turn for the building's one verify slot.
 */
export function verifyMerge(req: VerifyRequest, env: VerifyEnv): Promise<VerifyOutcome> {
  return exclusive(req.label, () => verifyNow(req, env));
}

async function verifyNow(req: VerifyRequest, env: VerifyEnv): Promise<VerifyOutcome> {
  const startedAt = Date.now();
  const out: VerifyOutcome = { ok: false, base: req.base, head: req.head, steps: [], startedAt, ms: 0 };
  const finish = (o: Partial<VerifyOutcome>): VerifyOutcome => Object.assign(out, o, { ms: Date.now() - startedAt });
  const merged = await mergeTree(req.repoDir, req.base, req.head);
  if ('error' in merged) return finish({ kind: 'error', reason: `git merge-tree: ${merged.error}` });
  if ('conflicts' in merged) return finish({ kind: 'conflict', conflicts: merged.conflicts, reason: `conflicts with the base in ${merged.conflicts.length} file${merged.conflicts.length === 1 ? '' : 's'}` });
  out.tree = merged.tree;
  const recipe = req.recipe;
  if (!recipe.steps.length && !recipe.allowNoChecks) return finish({ kind: 'failed', reason: 'no checks are known for this repository (add a recipe in .agent-office/vp-recipes.json)' });
  const root = env.tmpRoot ?? vpTmpRoot();
  const work = path.join(root, randomBytes(3).toString('hex'));
  let baseDir: string | undefined;
  try {
    env.log?.(`🔎 ${req.label}: merge result ${merged.tree.slice(0, 10)} → ${work}`);
    const put = await extractTree(req.repoDir, merged.tree, work);
    if (put) return finish({ kind: 'error', reason: put });
    const diff = await git(['diff', '--name-only', `${req.base}...${req.head}`], req.repoDir);
    const changed = diff.out.split(/\r?\n/).filter(Boolean);
    if (recipe.install) {
      const installed = await linkModules(work, root, env);
      out.steps.push(installed);
      if (!installed.ok) return finish({ kind: installed.timedOut ? 'timeout' : /pressure/.test(installed.detail ?? '') ? 'pressure' : 'failed', reason: `installing dependencies failed` });
    }
    for (const step of recipe.steps) {
      const calm = await waitForCalm(env, step.name);
      if (calm) {
        out.steps.push({ name: step.name, ok: false, ms: 0, detail: calm });
        return finish({ kind: 'pressure', reason: `not verified: ${calm}` });
      }
      env.log?.(`▶ ${req.label}: ${step.name}`);
      const ran = await runStep(step, work, changed);
      const r = ran.result;
      const result: StepResult = { name: step.name, ok: r.code === 0 && !r.timedOut, ms: r.ms, ...(ran.skipped ? { skipped: ran.skipped } : {}) };
      if (r.timedOut) {
        out.steps.push({ ...result, ok: false, timedOut: true, detail: tail(r.out) });
        return finish({ kind: 'timeout', reason: `${step.name} took longer than ${step.timeoutMin ?? DEFAULT_TIMEOUT_MIN} minutes: not verified` });
      }
      if (!result.ok && step.baseline) {
        // Failures the base branch has too aren't this PR's.
        baseDir ??= path.join(root, randomBytes(3).toString('hex'));
        const judged = await judgeAgainstBase(step, r, ran.files, req, changed, baseDir, root, env);
        Object.assign(result, judged);
      }
      if (!result.ok) result.detail = tail(r.out);
      out.steps.push(result);
      if (!result.ok) return finish({ kind: 'failed', reason: `${step.name} failed` });
    }
    return finish({ ok: true });
  } catch (err) {
    return finish({ kind: 'error', reason: (err as Error).message });
  } finally {
    removeTree(work);
    if (baseDir) removeTree(baseDir);
  }
}

/**
 * Runs a failed step on the base tree: ok when every failure is one the base has too. A tests step
 * runs the same files there (those the base has: failures in a test the PR adds are always new).
 */
async function judgeAgainstBase(step: RecipeStep, merged: RunResult, files: string[] | undefined, req: VerifyRequest, changed: string[], baseDir: string, root: string, env: VerifyEnv): Promise<Partial<StepResult>> {
  const mine = tapFailures(merged.out);
  // Output it can't read (Jest, Vitest, a crash) can't show the failures are the base's own: it stays failed.
  if (!mine.length) return {};
  const baseTree = await git(['rev-parse', `${req.base}^{tree}`], req.repoDir);
  if (baseTree.code !== 0) return {};
  if (!existsSync(baseDir)) {
    const put = await extractTree(req.repoDir, baseTree.out.trim(), baseDir);
    if (put) return {};
    if (req.recipe.install) {
      const installed = await linkModules(baseDir, root, env);
      if (!installed.ok) return {};
    }
  }
  const calm = await waitForCalm(env, `${step.name} on the base`);
  if (calm) return {};
  env.log?.(`▶ ${req.label}: ${step.name} on the base, to tell new failures from old ones`);
  const same = files?.filter((f) => existsSync(path.join(baseDir, f)));
  if (files && !same?.length) return {};
  const ran = await runStep(step, baseDir, changed, same);
  if (ran.result.timedOut) return {};
  const theirs = tapFailures(ran.result.out);
  const fresh = mine.filter((f) => !theirs.includes(f));
  return fresh.length ? { baseline: theirs.filter((f) => mine.includes(f)) } : { ok: true, baseline: mine };
}
