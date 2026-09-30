import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweep, type SweepDeps, FIX_MARKER, MERGE_MARKER } from '../src/server/vp-sweep.js';
import { VpStore } from '../src/server/vp-state.js';
import { mergesSince } from '../src/server/vp.js';
import { gitPull } from '../src/server/git-board.js';
import type { Recipe } from '../src/server/vp-verify.js';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol.js';

// The VP's sweep against fixture repositories: a local bare repository stands in for GitHub (the
// checkout's origin says https://github.com/test/x.git, but url.insteadOf and pushurl send every fetch
// and push to the bare one, so nothing reaches GitHub), and a fake gh answers the REST calls.

const REPO = 'test/x';
const URL_ = 'https://github.com/test/x.git';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The fixture's check: logs where and when it ran (VPT_LOG), can take a while (VPT_SLEEP), and fails when broken.txt is in the tree. */
const CHECK = `const fs = require('fs');
const path = require('path');
const log = (o) => process.env.VPT_LOG && fs.appendFileSync(process.env.VPT_LOG, JSON.stringify({ cwd: process.cwd(), git: fs.existsSync(path.join(process.cwd(), '.git')), ...o }) + '\\n');
log({ start: Date.now() });
const ms = Number(process.env.VPT_SLEEP || 0);
if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
log({ end: Date.now() });
if (fs.existsSync(path.join(process.cwd(), 'broken.txt'))) { console.error('broken.txt says the build is broken'); process.exit(1); }
`;

const RECIPE: Recipe = { source: 'saved', install: false, steps: [{ name: 'check', node: ['check.js'] }] };

interface Pull {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: { login: string };
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string };
  created_at: string;
  state: 'open' | 'closed';
  merged_at: string | null;
}

/** GitHub, as far as the VP asks it: pulls, comments, reviews, checks, and merges done for real into the bare repository. */
class FakeGitHub {
  pulls = new Map<number, Pull>();
  issueComments = new Map<number, { id: number; html_url: string; user: { login: string }; body: string; created_at: string }[]>();
  reviewComments = new Map<number, unknown[]>();
  reviews = new Map<number, unknown[]>();
  checks = new Map<string, { check_runs: unknown[]; statuses: unknown[] }>();
  merges: { n: number; sha: string }[] = [];
  posted: { n: number; body: string }[] = [];
  /** A head GitHub reports for the PR once it's asked about it alone (just before a merge). */
  headLater = new Map<number, string>();
  graphqlLimited = true;
  private ids = 1000;

  constructor(private seed: string) {}

  gh = async (args: string[]): Promise<string> => {
    if (args[0] === 'pr' && args[1] === 'merge') return this.merge(Number(args[2]), args[args.indexOf('--match-head-commit') + 1]);
    if (args[0] !== 'api') throw new Error(`fake gh: ${args.join(' ')}`);
    let method = 'GET';
    const fields: Record<string, string> = {};
    let p = '';
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--method') method = args[++i];
      else if (a === '-f' || a === '-F') {
        const v = args[++i];
        fields[v.slice(0, v.indexOf('='))] = v.slice(v.indexOf('=') + 1);
      } else if (a === '--jq' || a === '--hostname') i++;
      else if (!a.startsWith('-')) p = a;
    }
    if (p === 'graphql') {
      if (this.graphqlLimited) throw new Error('GraphQL: API rate limit exceeded for user ID 1.');
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    const [route, query = ''] = p.split('?');
    const page = Number(/(?:^|&)page=(\d+)/.exec(query)?.[1] ?? '1');
    const list = (items: unknown[]) => JSON.stringify(page === 1 ? items : []);
    if (route === 'user') return JSON.stringify({ login: 'owner' });
    if (route === `repos/${REPO}`) return JSON.stringify({ default_branch: 'personal', fork: false, allow_merge_commit: true });
    if (route === `repos/${REPO}/pulls`) return list([...this.pulls.values()].filter((x) => x.state === 'open'));
    let m = new RegExp(`^repos/${REPO}/pulls/(\\d+)$`).exec(route);
    if (m) {
      const pull = this.pulls.get(Number(m[1]))!;
      const later = this.headLater.get(pull.number);
      return JSON.stringify(later ? { ...pull, head: { ...pull.head, sha: later } } : pull);
    }
    m = new RegExp(`^repos/${REPO}/pulls/(\\d+)/comments$`).exec(route);
    if (m) return list(this.reviewComments.get(Number(m[1])) ?? []);
    m = new RegExp(`^repos/${REPO}/pulls/(\\d+)/reviews$`).exec(route);
    if (m) return list(this.reviews.get(Number(m[1])) ?? []);
    m = new RegExp(`^repos/${REPO}/issues/(\\d+)/comments$`).exec(route);
    if (m && method === 'POST') {
      const n = Number(m[1]);
      this.posted.push({ n, body: fields.body });
      const all = this.issueComments.get(n) ?? [];
      all.push({ id: this.ids++, html_url: `https://github.com/${REPO}/pull/${n}#issuecomment-${this.ids}`, user: { login: 'owner' }, body: fields.body, created_at: new Date().toISOString() });
      this.issueComments.set(n, all);
      return '{}';
    }
    if (m) return list(this.issueComments.get(Number(m[1])) ?? []);
    m = new RegExp(`^repos/${REPO}/commits/(\\w+)/check-runs$`).exec(route);
    if (m) return JSON.stringify({ check_runs: this.checks.get(m[1])?.check_runs ?? [] });
    m = new RegExp(`^repos/${REPO}/commits/(\\w+)/status$`).exec(route);
    if (m) return JSON.stringify({ statuses: this.checks.get(m[1])?.statuses ?? [] });
    throw new Error(`fake gh: no route for ${method} ${p}`);
  };

  /** A merge commit on the bare repository's personal, the way GitHub makes one. */
  private merge(n: number, sha: string): string {
    const pull = this.pulls.get(n)!;
    if (pull.head.sha !== sha) throw new Error('Head branch was modified. Review and try the merge again.');
    git(this.seed, 'fetch', '-q', 'origin');
    git(this.seed, 'checkout', '-q', '-B', 'personal', 'origin/personal');
    git(this.seed, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from test/${pull.head.ref}`, sha);
    git(this.seed, 'push', '-q', 'origin', 'personal');
    pull.state = 'closed';
    pull.merged_at = new Date().toISOString();
    this.merges.push({ n, sha });
    return '';
  }
}

interface World {
  root: string;
  bare: string;
  seed: string;
  floor: string;
  tmpRoot: string;
  log: string;
  fake: FakeGitHub;
  workers: WorkerInfo[];
  tasks: QueueTask[];
  /** A branch off personal with these files changed, pushed as PR `n` (by `author`, into `base`). */
  pr(n: number, branch: string, files: Record<string, string>, opts?: { author?: string; base?: string; draft?: boolean; from?: string }): string;
  runs(): { cwd: string; git: boolean; start?: number; end?: number }[];
}

function world(t: { after(fn: () => void): void }): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vpt-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const bare = path.join(root, 'o.git');
  git(root, 'init', '-q', '--bare', '-b', 'personal', bare);
  const seed = path.join(root, 's');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'personal');
  for (const [k, v] of [['user.name', 'VP Test'], ['user.email', 'vp-test@example.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(seed, 'config', k, v);
  writeFileSync(path.join(seed, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(seed, 'check.js'), CHECK);
  writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }));
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'Initial');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'personal');
  const floor = path.join(root, 'f');
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', '-b', 'personal', bare, floor);
  git(floor, 'config', 'remote.origin.url', URL_);
  git(floor, 'config', 'remote.origin.pushurl', bare);
  git(floor, 'config', `url.${bare}.insteadOf`, URL_);
  writeFileSync(path.join(floor, '.git', 'info', 'exclude'), '.agent-office/\n');
  mkdirSync(path.join(floor, '.agent-office'));
  const fake = new FakeGitHub(seed);
  const log = path.join(root, 'runs.log');
  const w: World = {
    root,
    bare,
    seed,
    floor,
    tmpRoot: path.join(root, 't'),
    log,
    fake,
    workers: [],
    tasks: [],
    pr(n, branch, files, opts = {}) {
      git(seed, 'checkout', '-q', '-B', branch, opts.from ?? 'personal');
      for (const [f, text] of Object.entries(files)) writeFileSync(path.join(seed, f), text);
      git(seed, 'add', '.');
      git(seed, 'commit', '-q', '-m', `Change for #${n}`);
      const sha = git(seed, 'rev-parse', 'HEAD');
      git(seed, 'push', '-q', '-f', 'origin', `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${n}/head`);
      git(seed, 'checkout', '-q', 'personal');
      fake.pulls.set(n, {
        number: n,
        title: `PR ${n}`,
        html_url: `https://github.com/${REPO}/pull/${n}`,
        draft: !!opts.draft,
        user: { login: opts.author ?? 'owner' },
        head: { ref: branch, sha, repo: { full_name: REPO } },
        base: { ref: opts.base ?? 'personal' },
        created_at: new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString(),
        state: 'open',
        merged_at: null,
      });
      return sha;
    },
    runs() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
  process.env.VPT_LOG = log;
  process.env.VPT_SLEEP = '0';
  return w;
}

interface Made {
  deps: SweepDeps;
  queued: { id: string; title: string; prompt: string }[];
  plans: string[];
  nudges: { id: string; text: string }[];
  logs: string[];
}

function made(w: World, over: Partial<SweepDeps> = {}): Made {
  const out: Made = { queued: [], plans: [], nudges: [], logs: [], deps: undefined as unknown as SweepDeps };
  out.deps = {
    floorDir: w.floor,
    gh: w.fake.gh,
    store: new VpStore(path.join(w.floor, '.agent-office')),
    workers: () => w.workers,
    tasks: () => w.tasks,
    queue: (title, prompt) => {
      const id = `task${w.tasks.length + 1}`;
      out.queued.push({ id, title, prompt });
      w.tasks.push({ id, title, prompt, status: 'queued', addedBy: 'VP', addedAt: Date.now() });
      return { id };
    },
    nudge: (id, text) => {
      out.nudges.push({ id, text });
      return undefined;
    },
    escalate: (text) => {
      out.plans.push(text);
      return undefined;
    },
    verifyEnv: { pressure: () => undefined, tmpRoot: path.join(w.tmpRoot), pressurePollMs: 20 },
    recipe: () => RECIPE,
    pull: (rel) => gitPull(w.floor, rel),
    log: (l) => out.logs.push(l),
    mergedBy: () => 'on duty since 2026-09-29 21:04 UTC, turned on by Michael',
    ...over,
  };
  return out;
}

function worker(over: Partial<WorkerInfo>): WorkerInfo {
  return { id: 'w1', kind: 'agent', provider: 'claude', deskId: 'desk-3', name: 'Pixel', color: '#fff', status: 'idle', acked: true, createdBy: 'me', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over } as WorkerInfo;
}

test('a ready PR is verified in a throwaway folder, merged on its verified head, recorded, and the floor fast-forwards; nothing restarts', async (t) => {
  const w = world(t);
  const start = git(w.floor, 'rev-parse', 'HEAD');
  const sha = w.pr(1, 'office/pixel-1', { 'feature.txt': 'new\n' });
  const m = made(w);
  const kills: unknown[] = [];
  const realKill = process.kill;
  process.kill = ((...a: unknown[]) => {
    kills.push(a);
    return true;
  }) as typeof process.kill;
  let res;
  try {
    res = await sweep(m.deps, { via: 'duty' });
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(kills, [], 'the sweep never signals any process (no restart)');
  assert.deepEqual(res.errors, []);
  assert.deepEqual(w.fake.merges, [{ n: 1, sha }], 'merged with --match-head-commit on the verified head');
  assert.equal(res.merged.length, 1);
  // Verified away from the floor and the app: a throwaway folder under the VP's temp root, not a git worktree.
  const runs = w.runs().filter((r) => r.start);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].cwd.startsWith(w.tmpRoot), `ran in ${runs[0].cwd}`);
  assert.ok(!runs[0].cwd.startsWith(w.floor));
  assert.equal(runs[0].git, false, 'not a git checkout or worktree');
  assert.ok(!existsSync(runs[0].cwd), 'the throwaway folder is gone afterwards');
  // The record on the PR.
  const record = w.fake.posted.find((c) => c.body.includes(MERGE_MARKER));
  assert.ok(record, 'a record comment');
  assert.match(record!.body, new RegExp(`head: \`${sha}\``));
  assert.match(record!.body, /base \(personal\): `[0-9a-f]{40}`/);
  assert.match(record!.body, /merge result \(tree\): `[0-9a-f]{40}`/);
  assert.match(record!.body, /✅ check: \d/);
  assert.match(record!.body, /on duty since 2026-09-29 21:04 UTC, turned on by Michael/);
  // The floor's checkout fast-forwarded to the merge.
  assert.equal(git(w.floor, 'rev-parse', 'HEAD'), git(w.bare, 'rev-parse', 'personal'));
  assert.match(res.pulled.join('\n'), /up to date with personal/);
  // One merge the running office (started at `start`) doesn't have yet.
  assert.equal(await mergesSince(w.floor, start, 'refs/remotes/origin/personal'), 1);
});

test("a busy worker's PR is skipped, and so is a PR with a VP fix task still on the queue", async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  w.pr(2, 'office/byte-2', { 'b.txt': 'b\n' });
  w.workers.push(worker({ id: 'w1', status: 'working', worktree: { path: '.agent-office/worktrees/pixel-1', branch: 'office/pixel-1', base: 'x' } }));
  const m = made(w);
  m.deps.store.state.fixes['test/x#2'] = { pr: 2, repo: REPO, taskId: 'fix2', kind: 'conflict', details: ['conflict:b.txt'], reason: 'conflicts', head: 'x', at: Date.now(), attempt: 1 };
  w.tasks.push({ id: 'fix2', title: 'VP: fix PR #2', prompt: 'p', status: 'queued', addedBy: 'VP', addedAt: Date.now() });
  const res = await sweep(m.deps, { via: 'sweep' });
  assert.deepEqual(w.fake.merges, []);
  assert.equal(w.runs().length, 0, 'nothing was verified');
  assert.equal(res.prs.find((p) => p.number === 1)?.group, 'working');
  assert.match(res.prs.find((p) => p.number === 1)!.why, /Pixel at Desk 3 \(office\/pixel-1\) is working/);
  assert.equal(res.prs.find((p) => p.number === 2)?.group, 'fixing');
  assert.equal(m.queued.length, 0);
});

test('when the head moves during the verify, nothing merges', async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  w.fake.headLater.set(1, 'f'.repeat(40));
  const m = made(w);
  const res = await sweep(m.deps, { via: 'sweep' });
  assert.equal(w.runs().filter((r) => r.start).length, 1, 'it was verified');
  assert.deepEqual(w.fake.merges, []);
  assert.match(res.prs[0].why, /head moved/);
});

test('a conflict gets exactly one fix task: not again on the next sweep, nor after a restart, nor when the office lost its record; the same conflict after it goes to the owner', async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'app.txt': 'one\nTWO from the PR\nthree\n' });
  // personal moves the same line.
  git(w.seed, 'checkout', '-q', 'personal');
  writeFileSync(path.join(w.seed, 'app.txt'), 'one\nTWO on personal\nthree\n');
  git(w.seed, 'commit', '-q', '-am', 'personal moves on');
  git(w.seed, 'push', '-q', 'origin', 'personal');
  const m = made(w);
  const first = await sweep(m.deps, { via: 'duty' });
  assert.equal(m.queued.length, 1);
  assert.match(m.queued[0].title, /^VP: fix PR #1 \(conflicts\)/);
  assert.match(m.queued[0].prompt, /Merge conflicts with personal in: app\.txt/);
  assert.match(m.queued[0].prompt, /gh pr checkout 1/);
  assert.match(m.queued[0].prompt, /Don't merge it/);
  assert.equal(first.prs[0].group, 'fixing');
  assert.ok(w.fake.posted.some((c) => c.body.includes(`${FIX_MARKER} task=task1`)), 'the fix task is recorded on the PR');
  // A second sweep while it waits.
  await sweep(m.deps, { via: 'duty' });
  assert.equal(m.queued.length, 1);
  // A restart: a new store read back from disk.
  const again = made(w);
  await sweep(again.deps, { via: 'duty' });
  assert.equal(again.queued.length, 0);
  // The office lost its file: the PR's own record still says there's one.
  rmSync(path.join(w.floor, '.agent-office', 'vp.json'));
  const lost = made(w);
  const r3 = await sweep(lost.deps, { via: 'duty' });
  assert.equal(lost.queued.length, 0);
  assert.equal(r3.prs[0].group, 'fixing');
  // The task finishes, and the conflict is still there: the owner hears, once; no second task.
  w.tasks[0].status = 'done';
  w.tasks[0].outcome = 'done';
  const done = made(w);
  const r4 = await sweep(done.deps, { via: 'duty' });
  assert.equal(done.queued.length, 0);
  assert.equal(done.plans.length, 1);
  assert.match(done.plans[0], /^VP needs you: PR #1 .* still has conflicts after fix task task1/);
  assert.equal(r4.prs[0].group, 'owner');
  await sweep(done.deps, { via: 'duty' });
  assert.equal(done.plans.length, 1, 'escalated once');
  assert.deepEqual(w.fake.merges, []);
});

const codexComment = (id: number, line: number | null, createdAt = '2026-09-29T10:00:00Z') => ({
  id,
  html_url: `https://github.com/${REPO}/pull/1#discussion_r${id}`,
  user: { login: 'chatgpt-codex-connector[bot]' },
  body: '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Guard the empty list**\n\nThis crashes when the list is empty.',
  path: 'a.txt',
  line,
  created_at: createdAt,
});

test('an unresolved Codex P1 gets a fix task with its link; an outdated one someone answered is mergeable', async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  w.fake.reviewComments.set(1, [codexComment(501, 3)]);
  const m = made(w);
  await sweep(m.deps, { via: 'duty' });
  assert.equal(m.queued.length, 1);
  assert.match(m.queued[0].title, /1 Codex finding/);
  assert.match(m.queued[0].prompt, /\[P1\] Guard the empty list: https:\/\/github\.com\/test\/x\/pull\/1#discussion_r501/);
  assert.deepEqual(w.fake.merges, []);

  const w2 = world(t);
  w2.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  w2.fake.reviewComments.set(1, [codexComment(502, null), { id: 503, html_url: 'x', user: { login: 'owner' }, body: 'Fixed in the next commit.', path: 'a.txt', line: null, in_reply_to_id: 502, created_at: '2026-09-29T11:00:00Z' }]);
  const m2 = made(w2);
  const res = await sweep(m2.deps, { via: 'duty' });
  assert.equal(m2.queued.length, 0);
  assert.equal(w2.fake.merges.length, 1, res.prs.map((p) => p.why).join('; '));
});

test('a PR from outside the office, a PR into main and a draft are listed for the owner and never verified or merged', async (t) => {
  const w = world(t);
  git(w.seed, 'push', '-q', 'origin', 'personal:refs/heads/main');
  w.pr(1, 'feature/stranger', { 'a.txt': 'a\n' }, { author: 'stranger' });
  w.pr(2, 'office/pixel-2', { 'b.txt': 'b\n' }, { base: 'main' });
  w.pr(3, 'office/pixel-3', { 'c.txt': 'c\n' }, { draft: true });
  const m = made(w);
  const res = await sweep(m.deps, { via: 'duty' });
  assert.deepEqual(w.fake.merges, []);
  assert.equal(w.runs().length, 0);
  assert.deepEqual(res.prs.map((p) => p.group), ['listed', 'listed', 'listed']);
  assert.match(res.prs[1].why, /targets main, not personal/);
});

test('under CPU pressure the verify waits for calm; pressure that never lets up leaves it unverified and unmerged', async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  let asked = 0;
  const m = made(w);
  m.deps.verifyEnv = { pressure: () => (asked++ < 3 ? 'the CPU has been 97% busy for the last 30 seconds' : undefined), tmpRoot: w.tmpRoot, pressurePollMs: 20, log: (l) => m.logs.push(l) };
  const res = await sweep(m.deps, { via: 'duty' });
  assert.ok(asked >= 4, 'it looked until the pressure lifted');
  assert.ok(m.logs.some((l) => /Waiting before check: the CPU has been 97% busy/.test(l)));
  assert.equal(res.merged.length, 1);

  const w2 = world(t);
  w2.pr(1, 'office/pixel-1', { 'a.txt': 'a\n' });
  const m2 = made(w2);
  m2.deps.verifyEnv = { pressure: () => 'memory is 95% used', tmpRoot: w2.tmpRoot, pressurePollMs: 20, pressureMaxMs: 150 };
  const res2 = await sweep(m2.deps, { via: 'duty' });
  assert.deepEqual(w2.fake.merges, []);
  assert.equal(w2.runs().length, 0);
  assert.match(res2.prs[0].why, /not verified: the machine stayed under pressure/);
});

test('two floors sweeping at once verify one at a time', async (t) => {
  const a = world(t);
  const b = world(t);
  a.pr(1, 'office/a-1', { 'a.txt': 'a\n' });
  b.pr(1, 'office/b-1', { 'b.txt': 'b\n' });
  // Both floors log to one file, and each check takes a moment.
  const shared = path.join(a.root, 'both.log');
  process.env.VPT_LOG = shared;
  process.env.VPT_SLEEP = '400';
  try {
    await Promise.all([sweep(made(a).deps, { via: 'duty' }), sweep(made(b).deps, { via: 'duty' })]);
  } finally {
    process.env.VPT_SLEEP = '0';
  }
  const lines = readFileSync(shared, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spans = lines.filter((l) => l.start).map((s) => ({ start: s.start, end: lines.find((e) => e.end && e.cwd === s.cwd).end }));
  assert.equal(spans.length, 2);
  spans.sort((x, y) => x.start - y.start);
  assert.ok(spans[0].end <= spans[1].start, `the verifies overlapped: ${JSON.stringify(spans)}`);
  assert.equal(a.fake.merges.length + b.fake.merges.length, 2);
});

test('a failed verify gets one fix task naming the step; a dry run changes nothing; its own idle worker is asked first', async (t) => {
  const w = world(t);
  w.pr(1, 'office/pixel-1', { 'broken.txt': 'yes\n' });
  const dry = made(w);
  const d = await sweep(dry.deps, { via: 'sweep', dryRun: true });
  assert.equal(d.prs[0].group, 'ready');
  assert.equal(dry.queued.length + w.fake.posted.length + w.fake.merges.length, 0);
  assert.equal(w.runs().length, 0);

  const m = made(w);
  const res = await sweep(m.deps, { via: 'duty' });
  assert.equal(m.queued.length, 1);
  assert.match(m.queued[0].prompt, /failed at "check"/);
  assert.match(m.queued[0].prompt, /broken\.txt says the build is broken/);
  assert.equal(res.prs[0].group, 'fixing');

  const w2 = world(t);
  w2.pr(1, 'office/pixel-1', { 'broken.txt': 'yes\n' });
  w2.workers.push(worker({ id: 'pix', status: 'done', worktree: { path: '.agent-office/worktrees/pixel-1', branch: 'office/pixel-1', base: 'x' } }));
  const m2 = made(w2);
  await sweep(m2.deps, { via: 'duty' });
  assert.equal(m2.queued.length, 0);
  assert.equal(m2.nudges.length, 1, 'its own worker was asked to fix it');
  assert.equal(m2.nudges[0].id, 'pix');
  assert.equal(m2.deps.store.state.fixes['test/x#1'].workerId, 'pix');
});

test('stacked PRs merge base-first, and the restart count is the merges since the running office started', async (t) => {
  const w = world(t);
  const start = git(w.floor, 'rev-parse', 'HEAD');
  w.pr(2, 'office/pixel-2', { 'a.txt': 'a\n' });
  // #1 is newer by number but #2 was opened first; #3 is built on #2's branch.
  w.pr(3, 'office/pixel-3', { 'b.txt': 'b\n' }, { from: 'office/pixel-2' });
  w.fake.pulls.get(3)!.created_at = '2026-09-28T00:00:00Z';
  const m = made(w);
  const res = await sweep(m.deps, { via: 'duty' });
  assert.deepEqual(w.fake.merges.map((x) => x.n), [2, 3], res.prs.map((p) => `${p.number}: ${p.why}`).join('; '));
  assert.equal(await mergesSince(w.floor, start, 'refs/remotes/origin/personal'), 2);
});
