import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clockOut, clockOutBlock, listWorkers, type WorkersFloor } from '../src/server/office-workers.js';
import type { BranchPull } from '../src/server/github-rest.js';
import { Workspaces } from '../src/server/workspaces.js';
import { Worktrees } from '../src/server/worktrees.js';
import type { GhPull, QueueTask, WorkerInfo, WorktreeCleanup } from '../src/shared/protocol.js';
import type { WorkerWorkspace } from '../src/shared/workspaces.js';

// Every git here (the office's own included) commits as a test identity, with no per-repository config
// to write: git is slow on a busy Windows machine, and each call counts.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Office Workers Test',
  GIT_AUTHOR_EMAIL: 'office-workers-test@example.invalid',
  GIT_COMMITTER_NAME: 'Office Workers Test',
  GIT_COMMITTER_EMAIL: 'office-workers-test@example.invalid',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.autocrlf',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with a bare "GitHub" remote it has pushed its branch to. */
function repo(dir: string, remote: string, branch = 'personal') {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  writeFileSync(path.join(dir, 'app.txt'), 'one\n');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-office/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Initial');
  git(path.dirname(remote), 'init', '-q', '--bare', '-b', branch, remote);
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', branch);
}

let commits = 0;
/** Commits a new file, named uniquely: the tests share one repository, and what one merges the next starts from. */
function commit(dir: string, name: string) {
  const file = `${name}-${++commits}.txt`;
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `Add ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

const hasBranch = (dir: string, branch: string) => git(dir, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) === branch;

let shared: { tmp: string; root: string; hire(slug: string): { path: string; branch: string; base: string; from?: string; abs: string } } | undefined;
after(() => shared && rmSync(shared.tmp, { recursive: true, force: true }));
/** One floor for the whole file, each test hiring its own worktrees in it: making repositories is the slow part. */
function fixture() {
  if (shared) return shared;
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-workers-')));
  const root = path.join(tmp, 'app');
  repo(root, path.join(tmp, 'app.git'));
  const trees = new Worktrees(root);
  /** A worktree, as the office makes them for a worker it hires. */
  const hire = (slug: string) => {
    const wt = trees.create(slug);
    assert.notEqual(typeof wt, 'string', String(wt));
    const made = wt as { path: string; branch: string; base: string; from?: string };
    return { ...made, abs: path.join(root, made.path) };
  };
  shared = { tmp, root, hire };
  return shared;
}

let n = 0;
function worker(over: Partial<WorkerInfo> = {}): WorkerInfo {
  n++;
  return { id: `w${n}aaaaaaaaaa`.slice(0, 12), deskId: 'desk-1', kind: 'agent', provider: 'claude', name: 'Pixel', color: '#fff', status: 'done', acked: true, createdBy: 'x', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over } as WorkerInfo;
}

/** The floor as the office has it, with a WorkerManager that sends workers home the way it does. */
function office(root: string, workers: WorkerInfo[], opts: { tasks?: QueueTask[]; pulls?: Partial<GhPull>[]; fresh?: BranchPull[]; get?: (id: string) => WorkerInfo | undefined } = {}) {
  const killed: { id: string; cleanup?: WorktreeCleanup }[] = [];
  const asked: string[] = [];
  const floor: WorkersFloor = {
    dir: root,
    branch: 'personal',
    workers: {
      list: () => workers,
      get: opts.get ?? ((id) => workers.find((w) => w.id === id)),
      async kill(id, cleanup) {
        killed.push({ id, cleanup });
        const w = workers.splice(workers.findIndex((x) => x.id === id), 1)[0];
        if (!w.worktree || cleanup === 'keep') return { note: `Kept ${w.name}'s worktree and branch ${w.worktree?.branch}` };
        const error = await new Worktrees(root).remove(w.worktree, cleanup === 'all' ? 'all' : 'worktree');
        return error ? { error } : { note: `Deleted ${w.name}'s worktree and branch ${w.worktree.branch}` };
      },
    },
    tasks: () => opts.tasks ?? [],
    pulls: () => (opts.pulls ?? []) as GhPull[],
    async branchPulls(branch) {
      asked.push(branch);
      return opts.fresh ?? [];
    },
  };
  return { floor, killed, asked };
}

const refused = (r: Awaited<ReturnType<typeof clockOut>>) => (r.ok ? assert.fail('expected a refusal') : r);

test('never a board agent, the meeting table, a shell, or a worker mid-turn: each with a plain reason', () => {
  const cases: [Partial<WorkerInfo>, RegExp][] = [
    [{ name: 'PR agent', deskId: 'station-pulls' }, /^PR agent is a board agent: only a person clocks those out$/],
    [{ deskId: 'meeting-1', meeting: 'm1' }, /at the meeting table/],
    [{ kind: 'shell', name: 'Pixel 🐚' }, /is a shell someone opened/],
    [{ prOpening: true }, /pull request is being opened: wait for that to finish/],
    [{ status: 'working' }, /^Pixel is working$/],
    [{ status: 'starting' }, /^Pixel is working$/],
    [{ status: 'needs_input' }, /^Pixel needs input: a person has to answer it first$/],
    [{ status: 'paused' }, /stopped partway through a turn \(paused\)/],
    [{ status: 'interrupted' }, /stopped partway through a turn \(interrupted\)/],
    [{ viewers: ['Michael', 'Michael'] }, /^Michael has Pixel's terminal open$/],
    [{ viewers: ['Ada', 'Michael'] }, /^Ada and Michael have Pixel's terminal open$/],
  ];
  for (const [over, reason] of cases) assert.match(clockOutBlock(worker(over), []) ?? '', reason, JSON.stringify(over));
  for (const status of ['done', 'idle', 'exited', 'offline'] as const) assert.equal(clockOutBlock(worker({ status }), []), undefined, status);
  // Its queue task is still running: the queue says when that's done.
  const w = worker();
  const task = { id: 't1', title: 'Fix login', status: 'running', workerId: w.id } as QueueTask;
  assert.match(clockOutBlock(w, [task]) ?? '', /queue task “Fix login” \(t1\) is still running: the queue says when it's done/);
  assert.equal(clockOutBlock(w, [{ ...task, status: 'done' }]), undefined);
});

test('the office refuses those before touching git, and sends nobody home', async () => {
  const f = fixture();
  const busy = worker({ status: 'working', worktree: f.hire('pixel-0001') });
  const board = worker({ name: 'PR agent', deskId: 'station-pulls' });
  const queued = worker({ name: 'Byte' });
  const { floor, killed } = office(f.root, [busy, board, queued], { tasks: [{ id: 't9', title: 'Dark mode', status: 'running', workerId: queued.id } as QueueTask] });
  for (const [w, reason] of [[busy, /Pixel is working/], [board, /board agent/], [queued, /queue task “Dark mode”/]] as const) {
    const r = refused(await clockOut(floor, w.id, true));
    assert.equal(r.status, 409);
    assert.match(r.error, reason);
  }
  assert.deepEqual(killed, []);
});

test('takes an id, not a name, and only a worker on its own floor', async () => {
  const f = fixture();
  const pixel = worker({ worktree: f.hire('pixel-0002') });
  const { floor, killed } = office(f.root, [pixel]);
  const byName = refused(await clockOut(floor, 'pixel', false));
  assert.equal(byName.status, 400);
  assert.equal(byName.error, `Give the worker's id, not its name, since names are reused: Pixel is ${pixel.id}`);
  // A worker on another floor isn't in this floor's list at all.
  const elsewhere = refused(await clockOut(floor, 'fffff0000000', false));
  assert.equal(elsewhere.status, 404);
  assert.equal(elsewhere.error, "There's no worker fffff0000000 on this floor (see office-workers list)");
  assert.deepEqual(killed, []);
});

test('never a worker with uncommitted changes or commits no remote has: the reason says what would be left', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0003');
  const pixel = worker({ worktree: wt });
  const { floor, killed } = office(f.root, [pixel]);

  writeFileSync(path.join(wt.abs, 'draft.txt'), 'half done\n');
  const dirty = refused(await clockOut(floor, pixel.id, false));
  assert.equal(dirty.status, 409);
  assert.match(dirty.error, /^Pixel has 1 uncommitted change in \.agent-office[\\/]worktrees[\\/]pixel-0003: clocking it out would leave that work unshipped with nobody on it\. Name it for the owner instead$/);

  git(wt.abs, 'add', '.');
  git(wt.abs, 'commit', '-q', '-m', 'Draft');
  const unpushed = refused(await clockOut(floor, pixel.id, false));
  assert.match(unpushed.error, /^Pixel has 1 commit no remote has in \.agent-office[\\/]worktrees[\\/]pixel-0003:/);

  // Switched to another branch in its worktree: its own branch's commits still count.
  git(wt.abs, 'switch', '-q', '--detach', 'origin/personal');
  assert.match(refused(await clockOut(floor, pixel.id, false)).error, /1 commit no remote has/);
  git(wt.abs, 'switch', '-q', wt.branch);

  // The folder's gone, but the branch still holds the commit.
  rmSync(wt.abs, { recursive: true, force: true });
  git(f.root, 'worktree', 'prune');
  assert.match(refused(await clockOut(floor, pixel.id, false)).error, /1 commit no remote has/);
  assert.deepEqual(killed, []);
});

test('a clean, pushed worker is clocked out, keeping its worktree and branch by default', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0004');
  commit(wt.abs, 'login');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);
  const pixel = worker({ worktree: wt });
  const { floor, killed } = office(f.root, [pixel]);
  const r = await clockOut(floor, pixel.id, false);
  assert.ok(r.ok);
  assert.equal(r.worker.name, 'Pixel');
  assert.equal(r.cleanup, 'keep');
  assert.equal(r.kept, undefined);
  assert.deepEqual(await r.done, { note: "Kept Pixel's worktree and branch office/pixel-0004" });
  assert.deepEqual(killed, [{ id: pixel.id, cleanup: 'keep' }]);
  assert.ok(existsSync(wt.abs));
  assert.ok(hasBranch(f.root, wt.branch));
});

test('--remove-worktree deletes them once the branch has merged, and otherwise keeps them and says why', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0005');
  commit(wt.abs, 'login');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);

  const first = worker({ worktree: wt });
  const early = office(f.root, [first]);
  const kept = await clockOut(early.floor, first.id, true);
  assert.ok(kept.ok);
  assert.equal(kept.cleanup, 'keep');
  assert.equal(kept.kept, 'office/pixel-0005 has 1 commit not merged into personal');
  // GitHub was asked too, in case the board hadn't caught up with a merge.
  assert.deepEqual(early.asked, ['office/pixel-0005']);
  await kept.done;
  assert.ok(existsSync(wt.abs));

  // Merged into personal (on GitHub, fetched here): now they go.
  git(f.root, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #5', wt.branch);
  git(f.root, 'push', '-q', 'origin', 'personal');
  const again = worker({ worktree: wt });
  const late = office(f.root, [again]);
  const gone = await clockOut(late.floor, again.id, true);
  assert.ok(gone.ok);
  assert.equal(gone.cleanup, 'all');
  assert.equal(gone.kept, undefined);
  assert.deepEqual(await gone.done, { note: "Deleted Pixel's worktree and branch office/pixel-0005" });
  assert.deepEqual(late.killed, [{ id: again.id, cleanup: 'all' }]);
  assert.equal(existsSync(wt.abs), false);
  assert.equal(hasBranch(f.root, wt.branch), false);
});

test('a worker that only answered a question has nothing to merge, so its worktree can go', async () => {
  const f = fixture();
  const wt = f.hire('pip-0006');
  const pip = worker({ name: 'Pip', worktree: wt });
  const { floor, asked } = office(f.root, [pip]);
  const r = await clockOut(floor, pip.id, true);
  assert.ok(r.ok);
  assert.equal(r.cleanup, 'all');
  assert.deepEqual(asked, []);
  await r.done;
  assert.equal(existsSync(wt.abs), false);
});

test('a squash merge GitHub reports counts as merged, even before the board catches up', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0007');
  const head = commit(wt.abs, 'login');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);
  const pixel = worker({ worktree: wt });
  const { floor, asked } = office(f.root, [pixel], {
    pulls: [{ number: 7, state: 'OPEN', headRefName: wt.branch, headRefOid: head }],
    fresh: [{ number: 7, url: 'https://github.com/me/app/pull/7', state: 'MERGED', headRefName: wt.branch, headRefOid: head }],
  });
  const r = await clockOut(floor, pixel.id, true);
  assert.ok(r.ok);
  assert.equal(r.cleanup, 'all');
  assert.deepEqual(asked, [wt.branch]);
  await r.done;
  assert.equal(existsSync(wt.abs), false);
});

test('commits its merged pull request delivered are not unpushed, even once GitHub deleted the branch', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0008');
  const head = commit(wt.abs, 'login');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);
  git(wt.abs, 'push', '-q', 'origin', '--delete', wt.branch);
  const pixel = worker({ worktree: wt });
  // The board doesn't know about a merge: that's a commit no remote has.
  assert.match(refused(await clockOut(office(f.root, [pixel]).floor, pixel.id, false)).error, /1 commit no remote has/);
  const merged = office(f.root, [pixel], { pulls: [{ number: 8, state: 'MERGED', headRefName: wt.branch, headRefOid: head }] });
  const r = await clockOut(merged.floor, pixel.id, true);
  assert.ok(r.ok);
  assert.equal(r.cleanup, 'all');
  await r.done;
});

test('checks again after asking git: a worker prompted meanwhile stays', async () => {
  const f = fixture();
  const pixel = worker({ worktree: f.hire('pixel-0009') });
  let calls = 0;
  const { floor, killed } = office(f.root, [pixel], { get: (id) => (id === pixel.id ? (++calls > 1 ? { ...pixel, status: 'working' } : pixel) : undefined) });
  const r = refused(await clockOut(floor, pixel.id, false));
  assert.equal(r.status, 409);
  assert.equal(r.error, 'Pixel is working');
  assert.deepEqual(killed, []);
});

test('a worker in the floor\'s own checkout: that checkout is checked, and there is no worktree to remove', async () => {
  const f = fixture();
  const pip = worker({ name: 'Pip' });
  const { floor } = office(f.root, [pip]);
  writeFileSync(path.join(f.root, 'app.txt'), 'edited\n');
  assert.match(refused(await clockOut(floor, pip.id, true)).error, /^Pip has 1 uncommitted change in the floor's checkout, which it works in:/);
  git(f.root, 'checkout', '--', 'app.txt');
  const r = await clockOut(floor, pip.id, true);
  assert.ok(r.ok);
  assert.equal(r.cleanup, 'keep');
  assert.equal(r.kept, "Pip works in the floor's own checkout, so there's no worktree to remove");
});

test('a multi-repository desk: every repository has to be clean and pushed, and merged before its worktrees go', async (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-workers-ws-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const floorDir = path.join(tmp, 'floor');
  repo(path.join(floorDir, 'frontend'), path.join(tmp, 'frontend.git'), 'main');
  repo(path.join(floorDir, 'backend'), path.join(tmp, 'backend.git'), 'main');
  const made = new Workspaces(floorDir).create('byte-ws01', { repositories: ['frontend', 'backend'], branch: 'feature/login' });
  assert.notEqual(typeof made, 'string', String(made));
  const workspace = made as WorkerWorkspace;
  const back = workspace.repositories.find((r) => r.repository === 'backend')!;
  const byte = worker({ name: 'Byte', workspace });
  const { floor } = office(floorDir, [byte]);

  writeFileSync(path.join(floorDir, back.path, 'api.txt'), 'wip\n');
  const r = refused(await clockOut(floor, byte.id, false));
  assert.match(r.error, /^Byte has 1 uncommitted change in \.agent-office[\\/]workspaces[\\/]byte-ws01[\\/]backend:/);

  // Committed and pushed in the backend: it can go, keeping the worktrees until the branch merges.
  git(path.join(floorDir, back.path), 'add', '.');
  git(path.join(floorDir, back.path), 'commit', '-q', '-m', 'API');
  git(path.join(floorDir, back.path), 'push', '-q', 'origin', 'feature/login');
  const rows = await listWorkers(floor);
  assert.equal(rows[0].blocked, undefined);
  assert.deepEqual(rows[0].work, { path: workspace.path, dirty: 0, unpushed: 0, commits: 1 });
  const ok = await clockOut(floor, byte.id, true);
  assert.ok(ok.ok);
  assert.equal(ok.cleanup, 'keep');
  assert.equal(ok.kept, 'feature/login has 1 commit not merged into main');
});

test('lists every worker: status, desk, agent, branch, PR, its queue task, its work, and whether it could go', async () => {
  const f = fixture();
  const wt = f.hire('pixel-0010');
  const head = commit(wt.abs, 'login');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);
  const pixel = worker({ worktree: wt, model: 'opus', runningModel: 'claude-opus-5-5', waitingSince: 1000, task: { name: 'Fix Login Redirect', summary: 'done' } });
  const dirtyWt = f.hire('byte-0010');
  writeFileSync(path.join(dirtyWt.abs, 'x.txt'), 'x\n');
  const byte = worker({ name: 'Byte', deskId: 'desk-2', status: 'working', worktree: dirtyWt });
  const agent = worker({ name: 'PR agent', deskId: 'station-pulls', status: 'idle' });
  const task = { id: 't1', title: 'Fix login', status: 'done', workerId: pixel.id } as QueueTask;
  const { floor } = office(f.root, [pixel, byte, agent], { tasks: [task], pulls: [{ number: 80, url: 'https://github.com/me/app/pull/80', state: 'MERGED', isDraft: false, headRefName: wt.branch, headRefOid: head }] });
  const [p, b, a] = await listWorkers(floor);
  assert.deepEqual(p, {
    id: pixel.id, name: 'Pixel', desk: 'Desk 1', kind: 'agent', provider: 'claude', model: 'claude-opus-5-5', status: 'done', since: 1000,
    task: 'Fix Login Redirect', branch: wt.branch, pr: { number: 80, state: 'merged', url: 'https://github.com/me/app/pull/80' },
    queued: { id: 't1', title: 'Fix login', status: 'done' }, work: { path: wt.path, dirty: 0, unpushed: 0, commits: 1 }, blocked: undefined,
  });
  assert.equal(b.status, 'working');
  assert.equal(b.desk, 'Desk 2');
  assert.deepEqual(b.work, { path: dirtyWt.path, dirty: 1, unpushed: 0, commits: 0 });
  assert.equal(b.blocked, 'Byte is working');
  assert.equal(a.board, true);
  assert.equal(a.desk, 'PR board');
  assert.equal(a.work, undefined);
  assert.match(a.blocked!, /board agent/);
});
