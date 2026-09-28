import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BranchPulls, UnshippedWatch, recoveryTask, scanUnshipped } from '../src/server/unshipped.js';
import { Worktrees } from '../src/server/worktrees.js';
import { Workspaces } from '../src/server/workspaces.js';
import type { GhPull, GhState, QueueTask, WorkerInfo } from '../src/shared/protocol.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'personal');
  git(dir, 'config', 'user.name', 'Unshipped Test');
  git(dir, 'config', 'user.email', 'unshipped-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-office/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial');
}

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-unshipped-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(root);
  const trees = new Worktrees(root);
  /** A worker's worktree, as the office makes them. */
  const hire = (slug: string) => {
    const wt = trees.create(slug);
    assert.notEqual(typeof wt, 'string', String(wt));
    return { ...(wt as { path: string; branch: string; base: string }), abs: path.join(root, (wt as { path: string }).path) };
  };
  return { root, hire };
}

const board = (items: Partial<GhPull>[] = [], error?: string): (() => GhState<GhPull>) => () => ({ items: items as GhPull[], fetchedAt: 1, loading: false, error });
/** gh, answering "no PRs" for every branch, and counting how often it was asked. */
function noPrs() {
  const calls: string[][] = [];
  const query = async (args: string[]) => {
    calls.push(args);
    return '[]';
  };
  return { calls, query };
}

function worker(over: Partial<WorkerInfo>): WorkerInfo {
  return { id: 'w1', deskId: 'd1', kind: 'agent', name: 'Gizmo', color: '#fff', status: 'done', acked: false, createdBy: 'x', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over } as WorkerInfo;
}

async function scan(root: string, opts: { pulls?: BranchPulls; workers?: WorkerInfo[]; tasks?: QueueTask[] } = {}) {
  const pulls = opts.pulls ?? new BranchPulls(board(), noPrs().query);
  return scanUnshipped({ floorDir: root, workers: opts.workers ?? [], tasks: opts.tasks ?? [], pulls });
}

test('uncommitted changes in a worktree show as unshipped, a clean worktree does not', async (t) => {
  const f = fixture(t);
  const dirty = f.hire('nibble-aec2');
  f.hire('clean-0000');
  writeFileSync(path.join(dirty.abs, 'app.txt'), 'one\nTWO\nthree\n');
  writeFileSync(path.join(dirty.abs, 'new.txt'), 'hello\n');
  const found = await scan(f.root);
  assert.equal(found.length, 1);
  const it = found[0].item;
  assert.equal(it.branch, 'office/nibble-aec2');
  assert.equal(it.dirty, 2);
  assert.equal(it.commits, 0);
  assert.equal(it.base, 'personal');
  assert.equal(it.path, '.agent-office/worktrees/nibble-aec2');
  assert.equal(it.added, 1);
  assert.equal(it.deleted, 1);
  assert.equal(it.worker, 'gone');
  assert.equal(it.pr, 'none');
  assert.ok(it.modifiedAt && it.modifiedAt > Date.now() - 60_000);
});

test('an unpushed commit shows, with its worker and queue task', async (t) => {
  const f = fixture(t);
  const wt = f.hire('gizmo-bff0');
  writeFileSync(path.join(wt.abs, 'feature.txt'), 'x\n');
  git(wt.abs, 'add', '.');
  git(wt.abs, 'commit', '-m', 'Feature');
  const task = { id: 't1', title: 'Add the feature', branch: wt.branch, workerId: 'w1', workerName: 'Gizmo', status: 'done' } as QueueTask;
  const found = await scan(f.root, { workers: [worker({ worktree: { path: wt.path, branch: wt.branch, base: wt.base } })], tasks: [task] });
  assert.equal(found.length, 1);
  assert.deepEqual(
    { commits: found[0].item.commits, unpushed: found[0].item.unpushed, dirty: found[0].item.dirty, worker: found[0].item.worker, name: found[0].item.workerName, task: found[0].item.taskTitle },
    { commits: 1, unpushed: 1, dirty: 0, worker: 'idle', name: 'Gizmo', task: 'Add the feature' },
  );
  // Mid-turn it's still in progress, and there's no recovering it yet.
  const busy = await scan(f.root, { workers: [worker({ status: 'working', worktree: { path: wt.path, branch: wt.branch, base: wt.base } })] });
  assert.equal(busy[0].item.worker, 'active');
});

test('a branch only left, its worktree gone, still shows', async (t) => {
  const f = fixture(t);
  const wt = f.hire('lost-1111');
  writeFileSync(path.join(wt.abs, 'lost.txt'), 'x\n');
  git(wt.abs, 'add', '.');
  git(wt.abs, 'commit', '-m', 'Lost');
  git(f.root, 'worktree', 'remove', '--force', wt.abs);
  const found = await scan(f.root);
  assert.equal(found.length, 1);
  assert.equal(found[0].item.path, undefined);
  assert.equal(found[0].item.commits, 1);
});

test('commits already on the base, cherry-picked or squash-merged, count as shipped', async (t) => {
  const f = fixture(t);
  const picked = f.hire('picked-2222');
  writeFileSync(path.join(picked.abs, 'picked.txt'), 'x\n');
  git(picked.abs, 'add', '.');
  git(picked.abs, 'commit', '-m', 'Picked');
  const squashed = f.hire('squashed-3333');
  writeFileSync(path.join(squashed.abs, 'a.txt'), 'a\n');
  git(squashed.abs, 'add', '.');
  git(squashed.abs, 'commit', '-m', 'A');
  writeFileSync(path.join(squashed.abs, 'b.txt'), 'b\n');
  git(squashed.abs, 'add', '.');
  git(squashed.abs, 'commit', '-m', 'B');
  assert.equal((await scan(f.root)).length, 2);

  git(f.root, 'cherry-pick', picked.branch);
  git(f.root, 'merge', '--squash', squashed.branch);
  git(f.root, 'commit', '-m', 'Squashed A and B (#7)');
  // A later commit on the base doesn't make the squashed branch look unshipped again.
  writeFileSync(path.join(f.root, 'later.txt'), 'later\n');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'Later');
  assert.deepEqual(await scan(f.root), []);
});

test('an open or merged PR ships a branch; a closed one does not', async (t) => {
  const f = fixture(t);
  for (const slug of ['open-a', 'merged-b', 'closed-c', 'asked-d']) {
    const wt = f.hire(slug);
    writeFileSync(path.join(wt.abs, `${slug}.txt`), 'x\n');
  }
  const asked: string[] = [];
  const pulls = new BranchPulls(
    board([
      { headRefName: 'office/open-a', state: 'OPEN' },
      { headRefName: 'office/merged-b', state: 'MERGED' },
      { headRefName: 'office/closed-c', state: 'CLOSED' },
    ]),
    async (args) => {
      const branch = args[args.indexOf('--head') + 1];
      asked.push(branch);
      // Older than the board's list reaches: only gh for the branch itself knows.
      return JSON.stringify(branch === 'office/asked-d' ? [{ number: 3, state: 'MERGED', headRefName: branch }] : [{ number: 2, state: 'CLOSED', headRefName: branch }]);
    },
  );
  const found = await scan(f.root, { pulls });
  assert.deepEqual(found.map((x) => x.item.branch), ['office/closed-c']);
  assert.deepEqual(asked.sort(), ['office/asked-d', 'office/closed-c']);
  // Remembered: a second look doesn't ask GitHub again.
  await scan(f.root, { pulls });
  assert.equal(asked.length, 2);
});

test('rate-limited: local findings still show, PR status unknown, and GitHub is left alone for a while', async (t) => {
  const f = fixture(t);
  const wt = f.hire('limited-4444');
  writeFileSync(path.join(wt.abs, 'x.txt'), 'x\n');
  let calls = 0;
  const pulls = new BranchPulls(board([], 'API rate limit exceeded'), async () => {
    calls++;
    throw new Error('API rate limit exceeded for user');
  });
  const found = await scan(f.root, { pulls });
  assert.equal(found.length, 1);
  assert.equal(found[0].item.pr, 'unknown');
  assert.match(pulls.error ?? '', /rate limit/);
  await scan(f.root, { pulls });
  assert.equal(calls, 1);
});

test('multi-repository floors: workspace worktrees in each repository are looked at', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-unshipped-multi-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepo(path.join(root, 'frontend'));
  initRepo(path.join(root, 'backend'));
  const ws = new Workspaces(root).create('pixel-5555', { repositories: ['frontend', 'backend'] });
  assert.notEqual(typeof ws, 'string', String(ws));
  const front = (ws as Exclude<typeof ws, string>).repositories.find((r) => r.repository === 'frontend')!;
  writeFileSync(path.join(root, front.path, 'app.txt'), 'changed\n');
  // Its worker went home: the workspace manifest still says where the worktrees are.
  const found = await scan(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].item.repository, 'frontend');
  assert.equal(found[0].item.branch, 'office/pixel-5555');
  assert.equal(found[0].item.dirty, 1);
  assert.equal(found[0].item.path, front.path.split(path.sep).join('/'));
});

test('the recovery task copies the work without touching the original worktree', async (t) => {
  const f = fixture(t);
  const wt = f.hire('gizmo-bff0');
  writeFileSync(path.join(wt.abs, 'feature.txt'), 'x\n');
  git(wt.abs, 'add', '.');
  git(wt.abs, 'commit', '-m', 'Feature');
  writeFileSync(path.join(wt.abs, 'app.txt'), 'edited\n');
  const [found] = await scan(f.root, { tasks: [{ id: 't1', title: 'Add the feature', branch: wt.branch, workerName: 'Gizmo', status: 'done' } as QueueTask] });
  const sha = git(f.root, 'rev-parse', wt.branch);
  const r = await recoveryTask(found, true);
  assert.equal(r.title, 'Recover unshipped work from office/gizmo-bff0');
  assert.match(r.prompt, /Do NOT modify the source/);
  assert.ok(r.prompt.includes(`git cherry-pick ${sha}`));
  assert.ok(r.prompt.includes(`git -C "${wt.abs}" diff HEAD --binary`));
  assert.ok(r.prompt.includes('ls-files --others --exclude-standard'));
  assert.ok(r.prompt.includes('gh pr create --base personal'));
  assert.match(r.prompt, /Gizmo \(working on “Add the feature”\)/);
  // Without a worktree of its own (a floor of several repositories), it's told to make one.
  assert.match((await recoveryTask(found, false)).prompt, /worktree add -b recover\/gizmo-bff0/);
});

test('the watch hands finished tasks their branches, and refuses to recover an active worker', async (t) => {
  const f = fixture(t);
  const wt = f.hire('watch-6666');
  writeFileSync(path.join(wt.abs, 'x.txt'), 'x\n');
  let workers = [worker({ status: 'working', worktree: { path: wt.path, branch: wt.branch, base: wt.base } })];
  const given: Map<string, { dirty: number; commits: number }>[] = [];
  const watch = new UnshippedWatch(f.root, { workers: () => workers, tasks: () => [], board: board(), update() {}, branches: (m) => given.push(m) }, noPrs().query);
  t.after(() => watch.stop());
  await watch.scan(true);
  assert.deepEqual([...given[0]], [['office/watch-6666', { dirty: 1, commits: 0 }]]);
  const key = watch.state.items[0].key;
  assert.match(String(await watch.recover(key, true)), /still working/);
  workers = [];
  const r = await watch.recover(key, true);
  assert.equal(typeof r, 'object');
  assert.match(String(await watch.recover('nope', true)), /no longer/);
});
