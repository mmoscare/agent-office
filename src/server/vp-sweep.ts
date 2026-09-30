import { execFile } from 'node:child_process';
import path from 'node:path';
import { normalizeRepo } from '../shared/floors.js';
import { DESK_BY_ID } from '../shared/layout.js';
import type { QueueTask, WorkerInfo } from '../shared/protocol.js';
import { isBusy } from '../shared/status.js';
import { workspaceRepositories } from './workspaces.js';
import { mergeTree, verifyMerge, type Recipe, type VerifyEnv, type VerifyOutcome } from './vp-verify.js';
import { changesRequested, codexFindings, commitChecks, issueComments, mergePull, openPulls, postComment, pullNow, repoFacts, resolvedThreads, reviewComments, viewerLogin, type CodexFinding, type Gh, type VpPull } from './vp-github.js';
import { prKey, type FixRecord, type MergeRecord, type ProblemKind, type VerifiedRecord, type VpStore } from './vp-state.js';

// The VP's sweep: the owner's five rules in code (see vp.ts for who runs it, and when).
//  1. A PR whose worker is busy is skipped, and so is one with a VP fix still under way.
//  2. A ready PR is verified on its exact merge result (vp-verify.ts), then merged with a merge commit
//     while its head is still the one verified, and a record goes on it.
//  3. Conflicts, unfixed Codex findings, failing CI or a failed verify get one fix: a queue task, or
//     the PR's own idle worker nudged. Never two at once; the same problem again goes to the owner.
//  4. Nothing here restarts anything: the office says how many merges wait for a restart.
//  5. One verify at a time in the building, and only while the machine isn't under pressure.

/** How a PR stands after a sweep. */
export type PrGroup = 'ready' | 'verifying' | 'working' | 'fixing' | 'owner' | 'waiting' | 'merged' | 'listed';

export interface PrLine {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  group: PrGroup;
  why: string;
  /** The fix task under way, or the worker nudged. */
  fix?: string;
  /** Its worker, by seat and branch. */
  worker?: string;
}

export interface SweepResult {
  at: number;
  ms: number;
  dryRun: boolean;
  via: string;
  prs: PrLine[];
  merged: MergeRecord[];
  fixes: FixRecord[];
  escalations: string[];
  /** What became of each floor checkout after merges. */
  pulled: string[];
  errors: string[];
}

export interface SweepDeps {
  floorDir: string;
  gh: Gh;
  store: VpStore;
  workers(): WorkerInfo[];
  tasks(): QueueTask[];
  /** Adds a task to the floor's queue: its id, or why it couldn't. */
  queue(title: string, prompt: string): { id: string } | string;
  /** Types text into a worker's session. */
  nudge(workerId: string, text: string): string | undefined;
  /** Files a To Do Next item for the owner: its id, or why it couldn't. */
  escalate(text: string): string | undefined;
  verifyEnv: VerifyEnv;
  /** The checks for a repository: saved, else detected. */
  recipe(repoDir: string, repo: string): Recipe;
  /** Fast-forwards a floor checkout (the Git board's ⬇️ Pull): why it didn't, if it didn't. */
  pull(rel: string): Promise<string | undefined>;
  log(line: string): void;
  /** Words for the merge record: "on duty since …, turned on by …", or who asked. */
  mergedBy(): string;
  now?(): number;
}

export interface SweepOptions {
  dryRun?: boolean;
  /** Only this PR (office-vp verify / merge), of `repo` on a floor of several. */
  only?: { number: number; repo?: string };
  /** 'verify': stop once it's verified. */
  mode?: 'sweep' | 'verify' | 'merge';
  /** What started it, for the records: "duty", "sweep", "merge", "go-live". */
  via: string;
}

/** A nudged worker that hasn't started on it yet still counts as fixing it for this long. */
const NUDGE_GRACE_MS = 5 * 60_000;
/** Fixes a PR gets before it goes to the owner whatever the problem. */
const MAX_FIXES = 2;
/** Refs the VP fetches PR heads into: its own, so nothing prunes them mid-verify. */
const REF_NS = 'refs/agent-office/vp/pull';
export const FIX_MARKER = 'agent-office-vp:fix';
export const MERGE_MARKER = 'agent-office-vp:merged';
export const ESCALATE_MARKER = 'agent-office-vp:escalated';

function git(args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, out: (stdout ?? '').trim(), err: (stderr || (err ? err.message : '')).trim() });
    });
  });
}

/** owner/name of a checkout's origin as configured (not rewritten by url.insteadOf). */
export async function originRepo(dir: string): Promise<string | undefined> {
  const r = await git(['config', '--get', 'remote.origin.url'], dir, 10_000);
  return r.code === 0 ? normalizeRepo(r.out) : undefined;
}

export interface FloorRepo {
  /** Relative to the floor ('.' for a floor that's one repository). */
  rel: string;
  dir: string;
  repo: string;
}

/** The floor's GitHub repositories: the floor itself, or each checkout in a floor that's a folder of them. */
export async function floorRepos(floorDir: string): Promise<FloorRepo[]> {
  const found = await workspaceRepositories(floorDir);
  const out: FloorRepo[] = [];
  for (const r of found.repositories) {
    if (r.error) continue;
    const dir = r.path === '.' ? floorDir : path.join(floorDir, r.path);
    const repo = await originRepo(dir);
    if (repo && !out.some((o) => o.repo.toLowerCase() === repo.toLowerCase())) out.push({ rel: r.path, dir, repo });
  }
  return out;
}

/** The worker a PR comes from: its worktree's branch, its desk's PR or its queue task's. Never a board agent. */
export function workerFor(p: { number: number; headRef: string }, repo: string, workers: WorkerInfo[], tasks: QueueTask[]): WorkerInfo | undefined {
  const inRepo = (url?: string) => !url || url.toLowerCase().includes(`/${repo.toLowerCase()}/pull/`);
  return workers.find((w) => {
    if (w.kind !== 'agent' || DESK_BY_ID.get(w.deskId)?.station) return false;
    if (w.worktree?.branch === p.headRef) return true;
    if (w.workspace?.repositories.some((r) => r.branch === p.headRef || (r.pr?.number === p.number && inRepo(r.pr.url)))) return true;
    if (w.pr?.number === p.number && inRepo(w.pr.url)) return true;
    return tasks.some((t) => t.workerId === w.id && ((t.pr?.number === p.number && inRepo(t.pr.url)) || t.branch === p.headRef));
  });
}

/** A worker by seat and branch (names get reused, so a name alone isn't enough). */
export function seatOf(w: WorkerInfo): string {
  const seat = DESK_BY_ID.get(w.deskId)?.label ?? w.deskId;
  const branch = w.worktree?.branch ?? w.workspace?.repositories.map((r) => r.branch).join(', ');
  return `${w.name} at ${seat}${branch ? ` (${branch})` : ''}`;
}

/** Whether a fix is still under way: its task waits or runs (or its worker, stopped by a restart, still has it), or the nudged worker is on it. */
export function fixOpen(f: FixRecord, tasks: QueueTask[], workers: WorkerInfo[], now: number): boolean {
  if (f.taskId) {
    const t = tasks.find((x) => x.id === f.taskId);
    if (!t) return false;
    if (t.status !== 'done') return true;
    if (t.outcome === 'exited' && t.workerId) {
      const w = workers.find((x) => x.id === t.workerId);
      return !!w && w.status !== 'done';
    }
    return false;
  }
  if (f.workerId) {
    const w = workers.find((x) => x.id === f.workerId);
    if (!w) return false;
    return isBusy(w.status) || now - f.at < NUDGE_GRACE_MS;
  }
  return false;
}

interface Problem {
  kind: ProblemKind;
  /** What exactly, for comparing with the last fix: "conflict:src/a.ts", "codex:123", "ci:build". */
  details: string[];
  /** Lines for the fix task's prompt. */
  lines: string[];
  short: string;
}

function problemFromConflicts(files: string[], base: string): Problem {
  return { kind: 'conflict', details: files.map((f) => `conflict:${f}`), lines: [`- Merge conflicts with ${base} in: ${files.join(', ')}`], short: 'conflicts' };
}

function problemFromFindings(findings: CodexFinding[]): Problem {
  return {
    kind: 'codex',
    details: findings.map((f) => `codex:${f.id}`),
    lines: findings.map((f) => `- Codex finding [${f.priority}] ${f.title || '(no title)'}: ${f.url} (${f.path}; ${f.why})`),
    short: `${findings.length} Codex finding${findings.length === 1 ? '' : 's'}`,
  };
}

function problemFromChecks(failing: string[]): Problem {
  return { kind: 'ci', details: failing.map((c) => `ci:${c}`), lines: [`- CI failing: ${failing.join(', ')}`], short: 'CI failing' };
}

function problemFromVerify(v: VerifyOutcome): Problem {
  const failed = v.steps.filter((s) => !s.ok);
  const lines = failed.map((s) => `- The VP's check of the merge result failed at "${s.name}"${s.detail ? `:\n\n\`\`\`\n${s.detail.split('\n').slice(-40).join('\n')}\n\`\`\`` : ''}`);
  return { kind: 'verify', details: failed.map((s) => `verify:${s.name}`), lines: lines.length ? lines : [`- The VP's check of the merge result failed: ${v.reason}`], short: `${failed[0]?.name ?? 'verify'} failed` };
}

function mergeProblems(ps: Problem[]): Problem {
  return { kind: ps[0].kind, details: ps.flatMap((p) => p.details), lines: ps.flatMap((p) => p.lines), short: ps.map((p) => p.short).join(', ') };
}

const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`);

/** The record the VP leaves on a PR he merged. */
export function mergeRecordText(r: { head: string; base: string; baseRef: string; tree: string; steps: VerifiedRecord['steps'] }, by: string): string {
  return [
    `<!-- ${MERGE_MARKER} -->`,
    `✅ **Merged by the VP** (${by}).`,
    '',
    `- head: \`${r.head}\``,
    `- base (${r.baseRef}): \`${r.base}\``,
    `- merge result (tree): \`${r.tree}\``,
    '',
    'Checked on that exact tree, in a throwaway copy away from the live app:',
    ...r.steps.map((s) => `- ${s.skipped ? '➖' : s.ok ? '✅' : '❌'} ${s.name}${s.skipped ? ` (skipped: ${s.skipped})` : ''}${s.baseline ? ` (${s.baseline} failure${s.baseline === 1 ? '' : 's'} the base has too, not counted)` : ''}: ${minutes(s.ms)}`),
    '',
    'New code only runs in the office after it restarts; the VP never restarts it.',
  ].join('\n');
}

function recordOf(p: VpPull, repo: string, v: VerifyOutcome, now: number): VerifiedRecord {
  return {
    pr: p.number,
    repo,
    head: v.head,
    base: v.base,
    tree: v.tree ?? '',
    ok: v.ok,
    reason: v.reason,
    steps: v.steps.map((s) => ({ name: s.name, ok: s.ok, ms: s.ms, ...(s.skipped ? { skipped: s.skipped } : {}), ...(s.baseline?.length ? { baseline: s.baseline.length } : {}), ...(s.timedOut ? { timedOut: true } : {}) })),
    at: now,
    ms: v.ms,
  };
}

function fixPrompt(p: VpPull, repo: string, base: string, problem: Problem, agentOffice: boolean): string {
  const n = p.number;
  const b = p.headRef;
  return [
    `Fix pull request #${n} "${p.title}" in ${repo}: ${p.url}`,
    `Its branch is ${b}, into ${base}. The VP (the office's merge bot) can't merge it yet because:`,
    '',
    ...problem.lines,
    '',
    'Do this:',
    `1. Get onto the PR's branch in your worktree: \`gh pr checkout ${n}\`. If gh says GraphQL's rate limit is exceeded, use \`git fetch origin ${b} && git checkout -b ${b} --track origin/${b}\`. If the branch is checked out in another worktree, use \`git fetch origin ${b} && git checkout --detach FETCH_HEAD\` and push with \`git push origin HEAD:${b}\`.`,
    `2. Fix every problem above. Conflicts: \`git fetch origin ${base} && git merge origin/${base}\`, keeping both sides' intent (read the ${base} commits that touched the same code). A Codex finding: fix it; if it isn't a real problem, reply in its thread saying why. Failing checks: make them pass.`,
    `3. Run the checks this repository uses${agentOffice ? ': `npx tsc -p tsconfig.server.json --noEmit`, `npx tsc -p tsconfig.client.json --noEmit`, the related tests with `node --import tsx --test --test-force-exit --test-timeout=120000 <files>` (plain `npm test` hangs on Windows; leave out tests/console-shell.test.ts, which never exits), and `npm run build`' : ' (typecheck, lint, tests and build, as its package.json has them)'}.`,
    `4. Push only if the PR is still open and its head is still ${p.headSha.slice(0, 12)} (\`gh api repos/${repo}/pulls/${n} --jq ".state, .head.sha"\`). If someone pushed meanwhile, merge their commits in first.`,
    '5. Post a handoff comment on the PR: what you changed and the checks you ran, with a link to each Codex finding you addressed.',
    "6. Don't merge it: the VP merges it on a later sweep, once its own check of the merge result passes.",
  ].join('\n');
}

/**
 * One sweep of the floor's pull requests (or of one, for office-vp verify / merge). Never restarts
 * anything; never merges a PR it didn't verify on its current head and base.
 */
export async function sweep(deps: SweepDeps, opts: SweepOptions): Promise<SweepResult> {
  const now = () => deps.now?.() ?? Date.now();
  const started = now();
  const res: SweepResult = { at: started, ms: 0, dryRun: !!opts.dryRun, via: opts.via, prs: [], merged: [], fixes: [], escalations: [], pulled: [], errors: [] };
  const state = deps.store.state;
  let repos: FloorRepo[];
  try {
    repos = await floorRepos(deps.floorDir);
  } catch (err) {
    res.errors.push(`Couldn't list the floor's repositories: ${(err as Error).message}`);
    repos = [];
  }
  if (opts.only?.repo) repos = repos.filter((r) => r.repo.toLowerCase() === opts.only!.repo!.toLowerCase());
  else if (opts.only && repos.length > 1) {
    res.errors.push(`This floor holds several repositories: say which one (--repo owner/name): ${repos.map((r) => r.repo).join(', ')}`);
    repos = [];
  }
  const viewer = await viewerLogin(deps.gh, deps.floorDir);
  for (const r of repos) {
    try {
      await sweepRepo(deps, opts, r, viewer, res, now);
    } catch (err) {
      res.errors.push(`${r.repo}: ${(err as Error).message}`);
    }
  }
  res.ms = now() - started;
  state.lastSweep = { at: started, ms: res.ms, summary: summary(res) };
  deps.store.save();
  return res;
}

/** One line for the log and the status: what the sweep did. */
export function summary(res: SweepResult): string {
  const n = (g: PrGroup) => res.prs.filter((p) => p.group === g).length;
  const bits = [
    res.merged.length && `merged ${res.merged.length}`,
    n('ready') && `${n('ready')} ready`,
    res.fixes.length && `queued ${res.fixes.length} fix${res.fixes.length === 1 ? '' : 'es'}`,
    n('fixing') && `${n('fixing')} being fixed`,
    n('working') && `${n('working')} with a busy worker`,
    n('waiting') && `${n('waiting')} waiting`,
    n('owner') && `${n('owner')} need the owner`,
    res.errors.length && `${res.errors.length} error${res.errors.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return `${res.dryRun ? 'Dry run: ' : ''}${res.prs.length} open PR${res.prs.length === 1 ? '' : 's'}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

async function sweepRepo(deps: SweepDeps, opts: SweepOptions, r: FloorRepo, viewer: string | undefined, res: SweepResult, now: () => number) {
  const state = deps.store.state;
  const facts = await repoFacts(deps.gh, r.dir, r.repo);
  const base = state.bases?.[r.repo.toLowerCase()] ?? facts.defaultBranch;
  const owner = r.repo.split('/')[0].toLowerCase();
  if (!base) throw new Error("GitHub didn't say its default branch");
  const pulls = await openPulls(deps.gh, r.dir, r.repo);
  const mine = opts.only ? pulls.filter((p) => p.number === opts.only!.number) : pulls;
  if (opts.only && !mine.length) {
    res.errors.push(`${r.repo}: PR #${opts.only.number} isn't open`);
    return;
  }
  const line = (p: VpPull, group: PrGroup, why: string, extra: Partial<PrLine> = {}): PrLine => {
    const l: PrLine = { repo: r.repo, number: p.number, title: p.title, url: p.url, author: p.author, head: p.headRef, base: p.baseRef, group, why, ...extra };
    res.prs.push(l);
    return l;
  };
  // A fork's main mirrors its parent: the VP never merges into it.
  const mainOfFork = facts.fork && base === 'main';
  const eligible: VpPull[] = [];
  for (const p of mine) {
    if (mainOfFork) line(p, 'listed', `${r.repo} is a fork and its base would be main, which mirrors ${facts.parent ?? 'its parent'}: set the branch PRs merge into`);
    else if (p.baseRef !== base) line(p, 'listed', `targets ${p.baseRef}, not ${base}: never merged by the VP`);
    else if (p.draft) line(p, 'listed', 'a draft');
    else if (!(p.headRepo?.toLowerCase() === r.repo.toLowerCase() && p.headRef.startsWith('office/')) && !(p.author.toLowerCase() === owner || (viewer && p.author.toLowerCase() === viewer.toLowerCase()))) line(p, 'listed', "not from an office branch or the owner: it's the owner's to merge");
    else eligible.push(p);
  }
  if (!eligible.length) return;
  // The base and every eligible PR's head, into the VP's own refs.
  const fetched = await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, ...eligible.map((p) => `+refs/pull/${p.number}/head:${REF_NS}/${p.number}`)], r.dir, 180_000);
  if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.err.split('\n').pop()}`);
  const ordered = await order(eligible, r.dir);
  let merged = 0;
  for (const p of ordered) {
    const done = await sweepPull(deps, opts, r, base, p, line, res, now);
    if (done) merged++;
  }
  if (merged && !opts.dryRun) res.pulled.push(await pullFloor(deps, r, base));
}

/** Oldest first, but a PR built on another's branch after it. */
async function order(pulls: VpPull[], dir: string): Promise<VpPull[]> {
  const sorted = [...pulls].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  const out: VpPull[] = [];
  const placed = new Set<number>();
  const place = async (p: VpPull, depth = 0) => {
    if (placed.has(p.number)) return;
    if (depth < 5) {
      for (const q of sorted) {
        if (q === p || placed.has(q.number) || q.headSha === p.headSha) continue;
        const under = await git(['merge-base', '--is-ancestor', `${REF_NS}/${q.number}`, `${REF_NS}/${p.number}`], dir, 30_000);
        if (under.code === 0) await place(q, depth + 1);
      }
    }
    placed.add(p.number);
    out.push(p);
  };
  for (const p of sorted) await place(p);
  return out;
}

/** Sweeps one eligible PR; resolves to whether it merged. */
async function sweepPull(deps: SweepDeps, opts: SweepOptions, r: FloorRepo, base: string, p: VpPull, line: (p: VpPull, g: PrGroup, why: string, extra?: Partial<PrLine>) => PrLine, res: SweepResult, now: () => number): Promise<boolean> {
  const state = deps.store.state;
  const key = prKey(r.repo, p.number);
  const workers = deps.workers();
  const tasks = deps.tasks();
  // Rule 1: its worker is busy.
  const w = workerFor(p, r.repo, workers, tasks);
  const who = w ? seatOf(w) : undefined;
  if (w && isBusy(w.status)) {
    line(p, 'working', `${who} is ${w.status === 'needs_input' ? 'waiting on input' : w.status}`, { worker: who });
    return false;
  }
  // A fix under way (known here, or from the PR's own record should this office have lost its state).
  let fix: FixRecord | undefined = state.fixes[key];
  const comments = await issueComments(deps.gh, r.dir, r.repo, p.number);
  if (!fix) fix = adoptMarker(comments, r.repo, p, now());
  if (fix && !state.fixes[key]) {
    state.fixes[key] = fix;
    deps.store.save();
  }
  if (fix && fixOpen(fix, tasks, workers, now())) {
    line(p, 'fixing', fix.taskId ? `fix task ${fix.taskId} is ${tasks.find((t) => t.id === fix!.taskId)?.status ?? 'under way'}` : `${fix.worker ?? 'its worker'} was asked to fix it`, { fix: fix.taskId ?? fix.worker, worker: who });
    return false;
  }
  // The head as fetched must be the head GitHub says.
  const local = await git(['rev-parse', `${REF_NS}/${p.number}`], r.dir, 10_000);
  if (local.code !== 0 || local.out !== p.headSha) {
    line(p, 'waiting', 'its head moved while the sweep looked: next sweep');
    return false;
  }
  const baseSha = (await git(['rev-parse', `refs/remotes/origin/${base}`], r.dir, 10_000)).out;
  const problems: Problem[] = [];
  const merged = await mergeTree(r.dir, baseSha, p.headSha);
  if ('error' in merged) {
    line(p, 'waiting', `couldn't work out the merge: ${merged.error}`);
    return false;
  }
  if ('conflicts' in merged) problems.push(problemFromConflicts(merged.conflicts, base));
  const requested = await changesRequested(deps.gh, r.dir, r.repo, p.number);
  const review = await reviewComments(deps.gh, r.dir, r.repo, p.number);
  const codexRaw = review.some((c) => c.inReplyTo === undefined && /chatgpt-codex-connector/.test(c.author));
  const resolved = codexRaw ? await resolvedThreads(deps.gh, r.dir, r.repo, p.number) : undefined;
  const unfixed = codexFindings(review, comments, resolved).filter((f) => f.status === 'unfixed');
  if (unfixed.length) problems.push(problemFromFindings(unfixed));
  const checks = await commitChecks(deps.gh, r.dir, r.repo, p.headSha);
  if (checks.state === 'fail') problems.push(problemFromChecks(checks.failing));
  if (problems.length) return needsFix(deps, opts, r, base, p, mergeProblems(problems), fix, w, line, res, now);
  if (requested.length) {
    line(p, 'owner', `changes requested by ${requested.join(', ')}: a person decides`, { worker: who });
    return false;
  }
  if (checks.state === 'pending') {
    line(p, 'waiting', `CI still running: ${checks.pending.join(', ')}`, { worker: who });
    return false;
  }
  // Rule 2: verify the exact merge result, then merge.
  const tree = (merged as { tree: string }).tree;
  const cached = state.verified[key];
  const fresh = cached?.ok && cached.tree === tree && cached.head === p.headSha;
  if (opts.dryRun) {
    line(p, 'ready', fresh ? 'verified on this head and base: would merge' : 'ready: would verify the merge result, then merge', { worker: who });
    return false;
  }
  let record = fresh ? cached : undefined;
  for (let attempt = 0; ; attempt++) {
    if (!record) {
      const recipe = deps.recipe(r.dir, r.repo);
      deps.log(`🔎 Verifying ${r.repo}#${p.number} (${p.title})`);
      const outcome = await verifyMerge({ repoDir: r.dir, base: baseSha, head: p.headSha, recipe, label: `${r.repo}#${p.number}` }, deps.verifyEnv);
      record = recordOf(p, r.repo, outcome, now());
      state.verified[key] = record;
      deps.store.save();
      if (outcome.kind === 'conflict') return needsFix(deps, opts, r, base, p, problemFromConflicts(outcome.conflicts ?? [], base), fix, w, line, res, now);
      if (outcome.kind === 'failed' && !/no checks are known/.test(outcome.reason ?? '')) return needsFix(deps, opts, r, base, p, problemFromVerify(outcome), fix, w, line, res, now);
      if (!outcome.ok) {
        line(p, outcome.kind === 'failed' ? 'owner' : 'waiting', `not verified: ${outcome.reason}`, { worker: who });
        return false;
      }
    }
    if (opts.mode === 'verify') {
      line(p, 'ready', `verified on head ${p.headSha.slice(0, 7)} and ${base} ${baseSha.slice(0, 7)}: merge it with office-vp merge ${p.number}`, { worker: who });
      return false;
    }
    // Right before merging: still open, still the head that was verified, and the base still gives the verified tree.
    const now2 = await pullNow(deps.gh, r.dir, r.repo, p.number);
    if (now2.state !== 'open' || now2.merged) {
      line(p, 'waiting', 'it closed or merged while it was being verified');
      return false;
    }
    if (now2.headSha !== record.head) {
      line(p, 'waiting', `its head moved from ${record.head.slice(0, 7)} to ${now2.headSha.slice(0, 7)} during the verify: not merged, next sweep verifies the new head`);
      return false;
    }
    if (now2.baseRef !== base) {
      line(p, 'listed', `it was retargeted to ${now2.baseRef}`);
      return false;
    }
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], r.dir, 120_000);
    const baseNow = (await git(['rev-parse', `refs/remotes/origin/${base}`], r.dir, 10_000)).out;
    const again = baseNow === record.base ? { tree: record.tree } : await mergeTree(r.dir, baseNow, record.head);
    if (!('tree' in again) || again.tree !== record.tree) {
      if (attempt >= 1) {
        line(p, 'waiting', `${base} kept moving while it was verified: next sweep`);
        return false;
      }
      deps.log(`↻ ${base} moved during the verify of #${p.number}: verifying again`);
      record = undefined;
      continue;
    }
    const refused = await mergePull(deps.gh, r.dir, r.repo, p.number, record.head);
    if (refused) {
      line(p, 'owner', `the merge was refused: ${refused}. The VP doesn't try another way`, { worker: who });
      return false;
    }
    const m: MergeRecord = { pr: p.number, repo: r.repo, title: p.title, url: p.url, head: record.head, base: record.base, tree: record.tree, at: now(), via: opts.via };
    state.merges.push(m);
    delete state.fixes[key];
    deps.store.save();
    res.merged.push(m);
    const note = await postComment(deps.gh, r.dir, r.repo, p.number, mergeRecordText({ ...record, baseRef: base }, deps.mergedBy()));
    if (note) res.errors.push(`#${p.number} merged, but its record comment failed: ${note}`);
    line(p, 'merged', `merged ${record.head.slice(0, 7)} into ${base}`, { worker: who });
    deps.log(`✅ Merged ${r.repo}#${p.number}`);
    return true;
  }
}

/** The fix recorded on the PR itself (a marker comment), for an office that lost its own record. */
function adoptMarker(comments: { body: string; createdAt: string }[], repo: string, p: VpPull, now: number): FixRecord | undefined {
  const re = new RegExp(`<!-- ${FIX_MARKER} ([^>]*)-->`);
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = re.exec(comments[i].body);
    if (!m) continue;
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
    return {
      pr: p.number,
      repo,
      taskId: attrs.task,
      workerId: attrs.worker,
      kind: (attrs.kind as ProblemKind) || 'conflict',
      details: (attrs.details ?? '').split(',').filter(Boolean),
      reason: 'recorded on the PR',
      head: attrs.head ?? '',
      at: Date.parse(comments[i].createdAt) || now,
      attempt: Number(attrs.attempt) || 1,
    };
  }
  return undefined;
}

/** Rule 3: one fix per PR; the same problem after it goes to the owner. */
async function needsFix(deps: SweepDeps, opts: SweepOptions, r: FloorRepo, base: string, p: VpPull, problem: Problem, prev: FixRecord | undefined, w: WorkerInfo | undefined, line: (p: VpPull, g: PrGroup, why: string, extra?: Partial<PrLine>) => PrLine, res: SweepResult, now: () => number): Promise<boolean> {
  const state = deps.store.state;
  const key = prKey(r.repo, p.number);
  const who = w ? seatOf(w) : undefined;
  if (prev) {
    const same = prev.details.some((d) => problem.details.includes(d)) || (!prev.details.length && prev.kind === problem.kind);
    if (same || prev.attempt >= MAX_FIXES) {
      const ekey = `${key}:${problem.details.slice().sort().join(',')}`;
      const by = prev.taskId ? `fix task ${prev.taskId}` : `${prev.worker ?? 'its worker'} being asked to fix it`;
      const text = `VP needs you: PR #${p.number} "${p.title}" in ${r.repo} (${p.url}) still has ${problem.short} after ${by}. Options: fix it yourself or hand it to a worker; close the PR; or tell the VP to try once more (office-vp retry ${p.number}).`;
      if (!state.escalated[ekey] && !opts.dryRun) {
        const err = deps.escalate(text);
        if (err) res.errors.push(`Couldn't file "${text}": ${err}`);
        state.escalated[ekey] = now();
        deps.store.save();
        res.escalations.push(text);
        await postComment(deps.gh, r.dir, r.repo, p.number, `<!-- ${ESCALATE_MARKER} -->\n🙋 The VP handed this PR to the owner: it still has ${problem.short} after ${by}.\n\n${problem.lines.join('\n')}`);
      }
      line(p, 'owner', `still ${problem.short} after ${by}: the owner decides`, { worker: who });
      return false;
    }
  }
  // Its own worker, at rest at its desk with the branch checked out, fixes its own PR: that's the one
  // fix. Not one someone stopped on purpose (Esc), nor one that's asleep: a queue task does it then.
  const idle = !!w && (w.status === 'idle' || w.status === 'done' || w.status === 'paused');
  if (opts.dryRun) {
    line(p, 'fixing', `needs a fix (${problem.short}): would ${idle ? `ask ${who} to fix it` : 'queue one fix task'}`, { worker: who });
    return false;
  }
  const attempt = (prev?.attempt ?? 0) + 1;
  const agentOffice = /\/agent-office$/i.test(r.repo);
  const prompt = fixPrompt(p, r.repo, base, problem, agentOffice);
  const record: FixRecord = { pr: p.number, repo: r.repo, kind: problem.kind, details: problem.details, reason: problem.short, head: p.headSha, at: now(), attempt };
  if (w && idle && !deps.nudge(w.id, prompt)) {
    record.workerId = w.id;
    record.worker = who;
  } else {
    const q = deps.queue(`VP: fix PR #${p.number} (${problem.short})`.slice(0, 120), prompt);
    if (typeof q === 'string') {
      res.errors.push(`Couldn't queue a fix for #${p.number}: ${q}`);
      line(p, 'waiting', `needs a fix (${problem.short}), but queueing it failed: ${q}`, { worker: who });
      return false;
    }
    record.taskId = q.id;
  }
  state.fixes[key] = record;
  deps.store.save();
  res.fixes.push(record);
  const attrs = [record.taskId && `task=${record.taskId}`, record.workerId && `worker=${record.workerId}`, `kind=${record.kind}`, `head=${record.head}`, `attempt=${attempt}`, `details=${record.details.join(',').replace(/\s+/g, '_').replace(/-->/g, '')}`].filter(Boolean).join(' ');
  const said = record.taskId ? `queued fix task \`${record.taskId}\`` : `asked ${who} to fix it`;
  const note = await postComment(deps.gh, r.dir, r.repo, p.number, `<!-- ${FIX_MARKER} ${attrs} -->\n🧰 The VP ${said}: ${problem.short}.\n\n${problem.lines.join('\n')}\n\nThe VP merges this PR on a later sweep once its check of the merge result passes. It won't start a second fix while this one is under way.`);
  if (note) res.errors.push(`#${p.number}: the fix is under way, but its note on the PR failed: ${note}`);
  line(p, 'fixing', `${said} (${problem.short})`, { fix: record.taskId ?? who, worker: who });
  deps.log(`🧰 ${r.repo}#${p.number}: ${said} (${problem.short})`);
  return false;
}

/** After merges: the floor's checkout fast-forwards, only when it's clean and on the base branch. */
async function pullFloor(deps: SweepDeps, r: FloorRepo, base: string): Promise<string> {
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], r.dir, 10_000);
  if (branch.out !== base) return `${r.repo}: the floor's checkout is on ${branch.out || 'a detached HEAD'}, not ${base}: not pulled`;
  const dirty = await git(['status', '--porcelain=v1', '-unormal'], r.dir, 30_000);
  if (dirty.out) return `${r.repo}: the floor's checkout has uncommitted changes: not pulled (someone's work)`;
  const err = await deps.pull(r.rel);
  return err ? `${r.repo}: couldn't fast-forward the floor's checkout: ${err}` : `${r.repo}: the floor's checkout is up to date with ${base}`;
}
