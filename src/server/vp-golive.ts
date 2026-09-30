import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { floorRepos, originRepo, type FloorRepo, type PrLine, type SweepResult } from './vp-sweep.js';
import { postComment, repoFacts, type Gh } from './vp-github.js';
import { verifyMerge, type Recipe, type VerifyEnv } from './vp-verify.js';
import type { OfficeLauncher } from './vp-launch.js';

// "Go live" (office-vp go-live): the owner's go-ahead for this one run to merge, push, build, deploy
// and, with the checks below, restart. First a plan (read-only), then the run: a sweep in go-live
// mode (the same five rules), the floor checkouts brought up to date (local-only commits pushed only
// as a plain fast-forward after the checks pass), each repository deployed by its recipe (detected the
// first time, confirmed by the owner, kept in .agent-office/go-live.json), and, for the office's own
// code, the app folder updated and the office restarted through its launcher when it has one. A
// restart saves a record first: the office that comes back picks it up, checks it runs the new code,
// tells the workers who were busy "continue", and posts the report. Without a launcher, the owner
// gets the exact steps. Credentials, logins and 2FA are always the owner's steps.

export type DeployKind = 'agent-office' | 'vercel-git' | 'vercel-cli' | 'actions' | 'docker' | 'npm' | 'none';

export interface DeployRecipe {
  kind: DeployKind;
  /** The branch whose push deploys it. */
  branch: string;
  detail: string;
  /** For 'actions': the workflow file that deploys. */
  workflow?: string;
  /** What the owner does, for a deploy the VP can't do (logins, secrets, other machines). */
  steps?: string[];
  /** The owner said this is right (office-vp go-live --confirm-recipe owner/name). */
  confirmed: boolean;
  detectedAt: number;
}

export interface CheckoutPlan {
  branch?: string;
  dirty: number;
  ahead: number;
  behind: number;
  action: 'pull' | 'push' | 'none' | 'blocked';
  why: string;
}

export interface AppPlan {
  dir: string;
  branch?: string;
  dirty: number;
  behind: number;
  /** package.json or package-lock.json changes between the app folder and GitHub. */
  packages: boolean;
  how: 'launcher' | 'manual';
}

export interface RepoPlan {
  repo: string;
  rel: string;
  base: string;
  prs: PrLine[];
  checkout: CheckoutPlan;
  deploy: DeployRecipe;
  app?: AppPlan;
}

export interface GoLivePlan {
  at: number;
  repos: RepoPlan[];
  restart: { needed: boolean; how: 'launcher' | 'manual' | 'none'; busy: string[] };
  text: string;
}

export interface WorkerRef {
  id: string;
  name: string;
  floor: string;
  seat: string;
}

/** What a go-live run leaves behind, and what the office that comes back after its restart finishes. */
export interface GoLiveRecord {
  id: string;
  at: number;
  by: string;
  phase: 'running' | 'restarting' | 'waiting-restart' | 'done';
  merged: { repo: string; pr: number; title: string; url: string; mergeCommit?: string }[];
  deployed: string[];
  skipped: string[];
  owner: string[];
  busy: WorkerRef[];
  /** Where the report goes: the last merged PR. */
  thread?: { repo: string; pr: number; dir: string };
  report?: string;
  finishedAt?: number;
}

export interface GoLiveDeps {
  floorDir: string;
  dataDir: string;
  gh: Gh;
  /** A sweep on this floor: the dry run for the plan, the real one for the run. */
  sweep(opts: { dryRun?: boolean; via: string }): Promise<SweepResult>;
  verifyEnv: VerifyEnv;
  recipe(dir: string, repo: string): Recipe;
  /** The branch PRs merge into, per repository (the VP's `bases`, else the default). */
  base(repo: string, fallback: string): string;
  /** Fast-forwards a floor checkout (the Git board's pull). */
  pull(rel: string): Promise<string | undefined>;
  /** Every worker in the building, for who a restart would interrupt. */
  everyone(): { floor: string; worker: WorkerInfo; seat: string }[];
  launcher(): Promise<OfficeLauncher | undefined>;
  /** The running office's checkout and the commit it started from (null when unknown). */
  office: { dir: string; head: string } | null;
  log(line: string): void;
  now(): number;
  /** How long to watch a deployment, and how often to look. */
  watchMs?: number;
  pollMs?: number;
}

const RECORD = 'vp-go-live.json';
const RECIPES = 'go-live.json';

function git(args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, out: (stdout ?? '').trim(), err: (stderr || (err ? err.message : '')).trim() });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Deploy recipes ----------------------------------------------------------------------------

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown) {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // disk issues shouldn't take the office down
  }
}

/** How a repository goes live, worked out from its files (and, for Vercel, whether GitHub shows its deployments). */
export async function detectDeploy(dir: string, repo: string, base: string, gh: Gh, isOffice: boolean, now: number): Promise<DeployRecipe> {
  const r = (kind: DeployKind, detail: string, extra: Partial<DeployRecipe> = {}): DeployRecipe => ({ kind, branch: base, detail, confirmed: false, detectedAt: now, ...extra });
  if (isOffice) return r('agent-office', "the running office's own code: the app folder is pulled, built and the office restarted");
  if (existsSync(path.join(dir, 'vercel.json')) || existsSync(path.join(dir, '.vercel', 'project.json'))) {
    let git = false;
    try {
      const deployments = JSON.parse(await gh(['api', `repos/${repo}/deployments?per_page=10`], dir, 60_000)) as { creator?: { login?: string } }[];
      git = deployments.some((d) => /vercel/i.test(d.creator?.login ?? ''));
    } catch {
      git = false;
    }
    return git
      ? r('vercel-git', `Vercel, connected to GitHub: pushing ${base} deploys it`)
      : r('vercel-cli', 'Vercel, not connected to GitHub: deployed from the command line', { steps: [`In ${dir}: vercel --prod (signed in to Vercel as you)`] });
  }
  const wf = path.join(dir, '.github', 'workflows');
  let files: string[] = [];
  try {
    files = readdirSync(wf).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    files = [];
  }
  for (const f of files) {
    const text = readFileSync(path.join(wf, f), 'utf8');
    const onPush = /\bpush\b/.test(text);
    if (onPush && /actions\/deploy-pages|github-pages|\bpages\b/i.test(text)) return r('actions', `GitHub Pages, by the ${f} workflow on a push to ${base}`, { workflow: f });
    if (onPush && /deploy/i.test(`${f}\n${text}`)) return r('actions', `the ${f} workflow deploys it on a push to ${base}`, { workflow: f });
  }
  if (existsSync(path.join(dir, 'Dockerfile'))) return r('docker', 'a Docker image', { steps: [`In ${dir}: docker build -t <image> . and push or run it where it lives (your registry and servers: your credentials)`] });
  const pkg = readJson<{ name?: string; version?: string; private?: boolean; publishConfig?: unknown }>(path.join(dir, 'package.json'));
  if (pkg?.name && pkg.version && pkg.private !== true && pkg.publishConfig) return r('npm', `the npm package ${pkg.name}`, { steps: [`In ${dir}: npm version <patch|minor> && npm publish (needs your npm login and 2FA)`] });
  return r('none', 'nothing to deploy: merging is the release');
}

/** The recipes as saved (the owner can edit and confirm them), with any new repository's detected and saved. */
async function recipes(deps: GoLiveDeps, repos: FloorRepo[], bases: Map<string, string>, officeRepo: string | undefined): Promise<Record<string, DeployRecipe>> {
  const file = path.join(deps.dataDir, RECIPES);
  const saved = readJson<Record<string, DeployRecipe>>(file) ?? {};
  let changed = false;
  for (const r of repos) {
    const key = r.repo.toLowerCase();
    if (saved[key]?.kind) continue;
    saved[key] = await detectDeploy(r.dir, r.repo, bases.get(key)!, deps.gh, key === officeRepo?.toLowerCase(), deps.now());
    changed = true;
  }
  if (changed) writeJson(file, saved);
  return saved;
}

/** The owner confirms a detected recipe (office-vp go-live --confirm-recipe owner/name). */
export function confirmRecipe(dataDir: string, repo: string): string | undefined {
  const file = path.join(dataDir, RECIPES);
  const saved = readJson<Record<string, DeployRecipe>>(file) ?? {};
  const mine = saved[repo.toLowerCase()];
  if (!mine) return `No go-live recipe for ${repo} yet: office-vp go-live --plan detects it`;
  mine.confirmed = true;
  writeJson(file, saved);
  return undefined;
}

// ---- The plan --------------------------------------------------------------------------------

async function checkoutPlan(r: FloorRepo, base: string, mainOfFork: boolean): Promise<CheckoutPlan> {
  const branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], r.dir, 10_000)).out || undefined;
  const dirty = (await git(['status', '--porcelain=v1', '-unormal'], r.dir, 30_000)).out.split('\n').filter(Boolean).length;
  const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${base}`], r.dir, 30_000)).out.split(/\s+/).map(Number);
  const [ahead, behind] = [counts[0] || 0, counts[1] || 0];
  const plan = (action: CheckoutPlan['action'], why: string): CheckoutPlan => ({ branch, dirty, ahead, behind, action, why });
  if (branch !== base) return plan('none', `on ${branch ?? 'a detached HEAD'}, not ${base}: left alone`);
  if (dirty) return plan('blocked', `${dirty} uncommitted file${dirty === 1 ? '' : 's'}: someone's work, so it's not pulled or pushed`);
  if (ahead && behind) return plan('blocked', `${ahead} local and ${behind} GitHub commits apart: the owner decides how to bring them together`);
  if (ahead && mainOfFork) return plan('blocked', `${ahead} local commit${ahead === 1 ? '' : 's'} on ${base}, the fork's mirror of its parent: never pushed by the VP`);
  if (ahead) return plan('push', `${ahead} local commit${ahead === 1 ? '' : 's'} not on GitHub: pushed as a plain fast-forward once the checks pass`);
  if (behind) return plan('pull', `fast-forward ${behind} commit${behind === 1 ? '' : 's'}`);
  return plan('none', 'up to date');
}

async function appPlan(office: { dir: string }, launcher: OfficeLauncher | undefined): Promise<AppPlan> {
  const dir = office.dir;
  await git(['fetch', '--quiet', 'origin'], dir, 120_000);
  const branch = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], dir, 10_000)).out || undefined;
  const dirty = (await git(['status', '--porcelain=v1', '-unormal'], dir, 30_000)).out.split('\n').filter(Boolean).length;
  const behind = Number((await git(['rev-list', '--count', 'HEAD..@{u}'], dir, 30_000)).out) || 0;
  const changed = (await git(['diff', '--name-only', 'HEAD', '@{u}', '--', 'package.json', 'package-lock.json'], dir, 30_000)).out;
  return { dir, branch, dirty, behind, packages: !!changed, how: launcher ? 'launcher' : 'manual' };
}

/** What go-live would do, without doing any of it. */
export async function planGoLive(deps: GoLiveDeps): Promise<GoLivePlan> {
  const dry = await deps.sweep({ dryRun: true, via: 'go-live' });
  const repos = await floorRepos(deps.floorDir);
  const officeRepo = deps.office ? await originRepo(deps.office.dir) : undefined;
  const bases = new Map<string, string>();
  const forks = new Map<string, boolean>();
  for (const r of repos) {
    const facts = await repoFacts(deps.gh, r.dir, r.repo);
    const base = deps.base(r.repo, facts.defaultBranch);
    bases.set(r.repo.toLowerCase(), base);
    forks.set(r.repo.toLowerCase(), facts.fork && base === 'main');
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], r.dir, 180_000);
  }
  const saved = await recipes(deps, repos, bases, officeRepo);
  const launcher = await deps.launcher();
  const out: RepoPlan[] = [];
  for (const r of repos) {
    const key = r.repo.toLowerCase();
    const base = bases.get(key)!;
    const plan: RepoPlan = { repo: r.repo, rel: r.rel, base, prs: dry.prs.filter((p) => p.repo.toLowerCase() === key), checkout: await checkoutPlan(r, base, forks.get(key)!), deploy: saved[key] };
    if (plan.deploy.kind === 'agent-office' && deps.office) plan.app = await appPlan(deps.office, launcher);
    out.push(plan);
  }
  const office = out.find((p) => p.app);
  const willMerge = (p: RepoPlan) => p.prs.some((x) => x.group === 'ready');
  const needed = !!office && (willMerge(office) || (office.app?.behind ?? 0) > 0);
  const busy = deps.everyone().filter((e) => isBusy(e.worker.status)).map((e) => `${e.seat} on ${e.floor} (${e.worker.status})`);
  const plan: GoLivePlan = { at: deps.now(), repos: out, restart: { needed, how: needed ? (launcher ? 'launcher' : 'manual') : 'none', busy }, text: '' };
  plan.text = planText(plan);
  return plan;
}

export function planText(plan: GoLivePlan): string {
  const lines: string[] = ['GO-LIVE PLAN (nothing has been done yet)'];
  for (const r of plan.repos) {
    lines.push('', `${r.repo} → ${r.base}`);
    const ready = r.prs.filter((p) => p.group === 'ready');
    const fixing = r.prs.filter((p) => p.group === 'fixing');
    const left = r.prs.filter((p) => p.group !== 'ready' && p.group !== 'fixing');
    lines.push(ready.length ? `  Merge after verifying (one at a time): ${ready.map((p) => `#${p.number} ${p.title}`).join('; ')}` : '  Nothing ready to merge.');
    if (fixing.length) lines.push(`  Needs a fix first (one fix task each, not merged in this run): ${fixing.map((p) => `#${p.number} (${p.why})`).join('; ')}`);
    for (const p of left) lines.push(`  Left out: #${p.number} ${p.title} — ${p.why}`);
    lines.push(`  Floor checkout: ${r.checkout.why}`);
    lines.push(`  Deploy: ${r.deploy.detail}${r.deploy.confirmed ? '' : ' (detected; confirm with office-vp go-live --confirm-recipe ' + r.repo + ')'}`);
    if (r.deploy.steps?.length) lines.push(...r.deploy.steps.map((s) => `    owner: ${s}`));
    if (r.app) {
      const a = r.app;
      lines.push(`  App folder ${a.dir}: ${a.dirty ? `${a.dirty} uncommitted files: STOP, someone's work` : `${a.behind} commit${a.behind === 1 ? '' : 's'} to pull`}${a.packages ? '; new packages' : ''}`);
      lines.push(a.how === 'launcher' ? '  Build and restart through the launcher (staged, the live build untouched)' : '  No launcher that can restart the office: the build and restart are the owner\'s steps');
    }
  }
  const rs = plan.restart;
  lines.push('', rs.needed ? `Restart: needed (${rs.how === 'launcher' ? 'by the launcher' : 'by the owner'}).` : 'Restart: not needed.');
  if (rs.needed && rs.busy.length) lines.push(`  Busy now, and a restart stops them: ${rs.busy.join('; ')}. Default: restart as soon as everyone is idle (--restart idle); --restart now --confirm-restart only if the owner says so.`);
  return lines.join('\n');
}

// ---- The run ---------------------------------------------------------------------------------

export function loadRecord(dataDir: string): GoLiveRecord | undefined {
  return readJson<GoLiveRecord>(path.join(dataDir, RECORD));
}

function saveRecord(dataDir: string, rec: GoLiveRecord) {
  writeJson(path.join(dataDir, RECORD), rec);
}

/** Watches the deployment of `sha` (Vercel through GitHub's deployments, or the workflow run) until it's done or the watch ends. */
async function watchDeploy(deps: GoLiveDeps, r: FloorRepo, d: DeployRecipe, sha: string): Promise<string> {
  const end = deps.now() + (deps.watchMs ?? 10 * 60_000);
  const poll = deps.pollMs ?? 15_000;
  let last = 'not started yet';
  for (;;) {
    try {
      if (d.kind === 'vercel-git') {
        const ds = JSON.parse(await deps.gh(['api', `repos/${r.repo}/deployments?sha=${sha}&per_page=10`], r.dir, 60_000)) as { id: number; environment?: string }[];
        const dep = ds[0];
        if (dep) {
          const st = (JSON.parse(await deps.gh(['api', `repos/${r.repo}/deployments/${dep.id}/statuses?per_page=5`], r.dir, 60_000)) as { state: string; environment_url?: string; target_url?: string; log_url?: string }[])[0];
          const url = st?.environment_url || st?.target_url || st?.log_url || '';
          if (st?.state === 'success') return `deployed (${dep.environment ?? 'production'}): ${url}`;
          if (st && (st.state === 'failure' || st.state === 'error')) return `the deployment FAILED: ${url}`;
          last = `${st?.state ?? 'queued'}${url ? `: ${url}` : ''}`;
        }
      } else if (d.kind === 'actions') {
        const runs = (JSON.parse(await deps.gh(['api', `repos/${r.repo}/actions/runs?head_sha=${sha}&per_page=20`], r.dir, 60_000)) as { workflow_runs?: { path?: string; status: string; conclusion?: string; html_url: string }[] }).workflow_runs ?? [];
        const run = runs.find((x) => !d.workflow || (x.path ?? '').endsWith(d.workflow));
        if (run) {
          if (run.status === 'completed') return run.conclusion === 'success' ? `deployed by the workflow: ${run.html_url}` : `the workflow ended "${run.conclusion}": ${run.html_url}`;
          last = `${run.status}: ${run.html_url}`;
        }
      }
    } catch (err) {
      last = `couldn't ask GitHub: ${(err as Error).message}`;
    }
    if (deps.now() >= end) return `still ${last} when the watch ended`;
    await sleep(poll);
  }
}

/** Pulls the app folder with a normal merge (never reset or stash); why it didn't, if it didn't. */
async function pullApp(dir: string): Promise<string | undefined> {
  const dirty = (await git(['status', '--porcelain=v1', '-unormal'], dir, 30_000)).out;
  if (dirty) return `the app folder has uncommitted files (someone's work): not pulled`;
  const r = await git(['pull', '--no-rebase', '--no-edit'], dir, 300_000);
  if (r.code === 0) return undefined;
  await git(['merge', '--abort'], dir, 60_000);
  return `git pull stopped: ${r.err.split('\n').pop() || r.out.split('\n').pop()}. Nothing was changed`;
}

export interface GoLiveOptions {
  /** 'idle': restart as soon as nobody's working (the default); 'now': restart now (needs `confirm` when someone's busy); 'no': leave the restart to the owner. */
  restart: 'idle' | 'now' | 'no';
  confirm: boolean;
  by: string;
}

/** The run: merges, checkouts, deploys and (for the office itself) the restart. Resolves to the report. */
export async function runGoLive(deps: GoLiveDeps, opts: GoLiveOptions): Promise<GoLiveRecord> {
  const rec: GoLiveRecord = { id: `${deps.now()}`, at: deps.now(), by: opts.by, phase: 'running', merged: [], deployed: [], skipped: [], owner: [], busy: [] };
  const plan = await planGoLive(deps);
  deps.log('📋 Plan made: running it');
  const res = await deps.sweep({ via: 'go-live' });
  for (const m of res.merged) rec.merged.push({ repo: m.repo, pr: m.pr, title: m.title, url: m.url, mergeCommit: m.mergeCommit });
  for (const p of res.prs) if (p.group !== 'merged') rec.skipped.push(`#${p.number} ${p.title} (${p.repo}): ${p.why}`);
  rec.owner.push(...res.escalations);
  for (const e of res.errors) rec.skipped.push(`error: ${e}`);
  const repos = await floorRepos(deps.floorDir);
  let officeTouched = false;
  for (const rp of plan.repos) {
    const r = repos.find((x) => x.repo === rp.repo);
    if (!r) continue;
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${rp.base}:refs/remotes/origin/${rp.base}`], r.dir, 180_000);
    const mainOfFork = rp.checkout.why.includes("fork's mirror");
    const now = await checkoutPlan(r, rp.base, mainOfFork);
    let pushed = false;
    if (now.action === 'pull') {
      const err = await deps.pull(r.rel);
      rec.deployed.push(err ? `${r.repo}: couldn't fast-forward the floor checkout: ${err}` : `${r.repo}: floor checkout fast-forwarded to ${rp.base}`);
    } else if (now.action === 'push') {
      // Local-only commits: checked like a PR (the fast-forward's tree), then pushed plainly.
      const head = (await git(['rev-parse', 'HEAD'], r.dir, 10_000)).out;
      const baseSha = (await git(['rev-parse', `refs/remotes/origin/${rp.base}`], r.dir, 10_000)).out;
      const v = await verifyMerge({ repoDir: r.dir, base: baseSha, head, recipe: deps.recipe(r.dir, r.repo), label: `${r.repo} local ${rp.base}` }, deps.verifyEnv);
      if (!v.ok) rec.skipped.push(`${r.repo}: ${now.ahead} local commit(s) on ${rp.base} not pushed: ${v.reason}`);
      else {
        const p = await git(['push', 'origin', `HEAD:refs/heads/${rp.base}`], r.dir, 180_000);
        pushed = p.code === 0;
        rec.deployed.push(pushed ? `${r.repo}: pushed ${now.ahead} local commit(s) to ${rp.base} (checked first)` : `${r.repo}: the push was refused: ${p.err.split('\n').pop()}`);
      }
    } else if (now.action === 'blocked') rec.skipped.push(`${r.repo} floor checkout: ${now.why}`);
    const changed = res.merged.some((m) => m.repo === r.repo) || pushed;
    const d = rp.deploy;
    if (!d.confirmed) rec.owner.push(`Confirm how ${r.repo} goes live: ${d.detail} (office-vp go-live --confirm-recipe ${r.repo}), or edit ${path.join(deps.dataDir, RECIPES)}`);
    if (d.kind === 'agent-office') {
      officeTouched = changed || (rp.app?.behind ?? 0) > 0;
      continue;
    }
    if (!changed) continue;
    if (d.kind === 'vercel-git' || d.kind === 'actions') {
      const sha = (await git(['rev-parse', `refs/remotes/origin/${rp.base}`], r.dir, 10_000)).out;
      deps.log(`👀 Watching ${r.repo}'s deployment of ${sha.slice(0, 7)}`);
      rec.deployed.push(`${r.repo}: ${await watchDeploy(deps, r, d, sha)}`);
    } else if (d.steps?.length) rec.owner.push(...d.steps.map((s) => `${r.repo}: ${s}`));
  }
  const last = rec.merged.at(-1);
  if (last) {
    const r = repos.find((x) => x.repo === last.repo);
    if (r) rec.thread = { repo: last.repo, pr: last.pr, dir: r.dir };
  }
  if (officeTouched && deps.office) await goLiveOffice(deps, opts, rec);
  rec.report = reportText(rec);
  if (rec.phase === 'running') rec.phase = 'done';
  if (rec.phase === 'done') rec.finishedAt = deps.now();
  saveRecord(deps.dataDir, rec);
  if (rec.thread) await postComment(deps.gh, rec.thread.dir, rec.thread.repo, rec.thread.pr, rec.report);
  return rec;
}

/** The office's own code: the app folder, the build and the restart. */
async function goLiveOffice(deps: GoLiveDeps, opts: GoLiveOptions, rec: GoLiveRecord) {
  const office = deps.office!;
  const launcher = await deps.launcher();
  rec.busy = deps.everyone().filter((e) => isBusy(e.worker.status)).map((e) => ({ id: e.worker.id, name: e.worker.name, floor: e.floor, seat: e.seat }));
  if (!launcher) {
    const before = (await git(['rev-parse', 'HEAD'], office.dir, 10_000)).out;
    const err = await pullApp(office.dir);
    if (err) {
      rec.owner.push(`The app folder (${office.dir}): ${err}. Look at it, then follow the manual's "Merging an agent-office PR, step by step" from step 4.`);
      return;
    }
    const after = (await git(['rev-parse', 'HEAD'], office.dir, 10_000)).out;
    const packages = before !== after && !!(await git(['diff', '--name-only', before, after, '--', 'package.json', 'package-lock.json'], office.dir, 30_000)).out;
    rec.deployed.push(`App folder pulled (${before.slice(0, 7)} → ${after.slice(0, 7)}), not built: the running office serves its build, so the build waits for the restart`);
    if (packages) rec.owner.push(`New packages: with the office stopped (tray icon → Exit, or Ctrl+C in its window), run npm ci in ${office.dir}. Never while it runs.`);
    rec.owner.push(`Build: npm run build, in ${office.dir}`, 'Restart the office: tray icon near the clock → Restart Agent Office, or Ctrl+C in its window and start it again', 'Open http://localhost:4600 and press Ctrl+F5. The VP finishes this report once the office is back, and tells the workers who were busy "continue".');
    rec.phase = 'waiting-restart';
    return;
  }
  const prepared = await launcher.prepare(deps.log);
  if (!prepared.ok) {
    rec.owner.push(`Updating the office stopped: ${prepared.message}. Open ☰ → Update the office to see where it got to.`);
    return;
  }
  rec.deployed.push(`App folder: ${prepared.message}`);
  if (opts.restart === 'no') {
    rec.owner.push('Restart the office when it suits you: office-vp go-live --restart idle (or ☰ → Update the office → Restart)');
    return;
  }
  // Saved before the restart: the VP stops with the office, and the one that comes back finishes this.
  rec.phase = 'restarting';
  rec.report = reportText(rec);
  saveRecord(deps.dataDir, rec);
  const r = await launcher.restart(opts.restart, opts.confirm, opts.by);
  if (typeof r === 'string') {
    rec.phase = 'done';
    rec.owner.push(`The restart didn't happen: ${r}`);
  } else if (r.confirm) {
    rec.phase = 'done';
    rec.owner.push(`Restarting now would stop these busy workers: ${r.confirm.map((w) => `${w.name} on ${w.floor} (${w.status})`).join('; ')}. Say so and the VP restarts anyway (office-vp go-live --restart now --confirm-restart), or let him restart as soon as everyone is idle (--restart idle).`);
  } else if (r.waiting) rec.deployed.push('The office restarts as soon as every worker is idle');
  else rec.deployed.push('The office is restarting now');
}

export function reportText(rec: GoLiveRecord): string {
  const lines = ['### 🚀 Go-live report', `By ${rec.by}, ${new Date(rec.at).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ''];
  lines.push('**Live now**');
  if (rec.merged.length) lines.push(...rec.merged.map((m) => `- #${m.pr} ${m.title} (${m.url})`));
  else lines.push('- No PRs merged in this run.');
  if (rec.deployed.length) lines.push(...rec.deployed.map((d) => `- ${d}`));
  if (rec.skipped.length) lines.push('', '**Left out, and why**', ...rec.skipped.map((s) => `- ${s}`));
  lines.push('', '**What you need to do**');
  if (rec.owner.length) lines.push(...rec.owner.map((o, i) => `${i + 1}. ${o}`));
  else lines.push('Nothing.');
  if (rec.phase === 'restarting' || rec.phase === 'waiting-restart') lines.push('', '_The office restarts next; the VP finishes this report once it is back._');
  return lines.join('\n');
}

// ---- After the restart -----------------------------------------------------------------------

export interface FinishDeps {
  dataDir: string;
  gh: Gh;
  /** The running office's checkout and the commit it started from. */
  office: { dir: string; head: string } | null;
  /** When this office process started. */
  startedAt: number;
  /** Every worker in the building now. */
  everyone(): { floor: string; worker: WorkerInfo; seat: string }[];
  /** Tells a worker "continue" (prompt, or wake it if it's asleep). */
  carryOn(workerId: string): string | undefined;
  /** How the launcher's last restart went ('live', 'old-code', 'rolled-back'), when there is one. */
  verdict?(): Promise<string | undefined>;
  log(line: string): void;
  now(): number;
}

/**
 * The office that came back after a go-live restart finishes it: checks it runs the merged code,
 * tells the workers who were busy "continue", and posts the report. Resolves to the record, or
 * undefined when there's nothing to finish.
 */
export async function finishGoLive(deps: FinishDeps): Promise<GoLiveRecord | undefined> {
  const rec = loadRecord(deps.dataDir);
  if (!rec || (rec.phase !== 'restarting' && rec.phase !== 'waiting-restart')) return undefined;
  // Still the office that saved it: the restart hasn't happened yet.
  if (deps.startedAt <= rec.at) return undefined;
  const lines: string[] = ['', '**After the restart**'];
  const office = deps.office;
  const missing: string[] = [];
  if (office) {
    for (const m of rec.merged) {
      if (!m.mergeCommit) continue;
      const r = await git(['merge-base', '--is-ancestor', m.mergeCommit, office.head], office.dir, 30_000);
      if (r.code !== 0) missing.push(`#${m.pr}`);
    }
  }
  const verdict = await deps.verdict?.().catch(() => undefined);
  if (verdict === 'rolled-back') lines.push('- ⚠️ The new build didn\'t start, and the launcher put the previous one back. The owner looks at why (☰ → Update the office).');
  else if (missing.length) lines.push(`- ⚠️ The office came back without ${missing.join(', ')}: it isn't running the new code yet. Build and restart it again (manual: "Merging an agent-office PR, step by step").`);
  else lines.push(`- ✅ The office is running ${office?.head.slice(0, 7) ?? 'the new code'}, with every merged PR in it.`);
  const told: string[] = [];
  for (const b of rec.busy) {
    const now = deps.everyone().find((e) => e.worker.id === b.id);
    if (!now || isBusy(now.worker.status)) continue;
    if (!deps.carryOn(b.id)) told.push(b.seat);
  }
  lines.push(told.length ? `- Told the workers who were busy "continue": ${told.join('; ')}.` : '- No workers needed telling to continue.');
  rec.phase = 'done';
  rec.finishedAt = deps.now();
  rec.report = `${(rec.report ?? reportText(rec)).replace(/\n\n_The office restarts next; the VP finishes this report once it is back._$/, '')}\n${lines.join('\n')}`;
  saveRecord(deps.dataDir, rec);
  if (rec.thread) await postComment(deps.gh, rec.thread.dir, rec.thread.repo, rec.thread.pr, rec.report);
  deps.log('🚀 Go-live finished after the restart');
  return rec;
}
