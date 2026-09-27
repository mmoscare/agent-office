import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pullForBranch, pullRequestLabel } from '../src/shared/pulls.js';
import { findBranchPr } from '../src/server/github.js';
import { WorkerManager } from '../src/server/workers.js';
import { Changes } from '../src/server/changes.js';
import { Ledger } from '../src/server/usage.js';
import type { ChangesState, GhPull, PullRequestRef, WorkerInfo } from '../src/shared/protocol.js';

const branch = 'office/test';
const pull = (number: number, state: string, headRefName = branch): GhPull => ({
  number, state, headRefName, url: `https://github.com/example/project/pull/${number}`,
  title: `PR ${number}`, isDraft: false, author: 'tester', labels: [], reviewDecision: '',
  baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [],
});

function fixture(t: TestContext, savedPr?: PullRequestRef) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-pull-links-'));
  const data = path.join(root, '.agent-office');
  mkdirSync(data);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Initial');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', branch);
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([{
    id: 'worker', deskId: 'desk-1', kind: 'agent', provider: 'codex', name: 'Test',
    worktree: { path: '.', branch, base, from: 'main' }, pr: savedPr,
  }]));
  const updates: WorkerInfo[] = [];
  const managers: WorkerManager[] = [];
  const open = () => {
    const workers = new WorkerManager(root, data, process.execPath, [], { url: 'http://127.0.0.1:1', token: '' }, {
      update: (w) => updates.push({ ...w }), remove() {}, data() {}, screen() {}, toast() {},
    }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    managers.push(workers);
    return workers;
  };
  t.after(() => {
    managers.forEach((manager) => manager.shutdown());
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, data, base, git, open, updates };
}

test('branch matching retains completed PRs and prefers an open PR when a branch is reused', () => {
  const items = [pull(4, 'CLOSED'), pull(9, 'MERGED'), pull(11, 'MERGED', 'unrelated')];
  assert.equal(pullForBranch(items, branch)?.number, 9);
  assert.equal(pullForBranch([...items, pull(3, 'OPEN')], branch)?.number, 3);
  assert.equal(pullForBranch([...items, pull(3, 'OPEN'), pull(8, 'OPEN')], branch)?.number, 8);
  assert.equal(pullForBranch(items, 'missing'), undefined);
  assert.equal(pullRequestLabel(pull(9, 'MERGED')), 'Merged PR #9');
  assert.equal(pullRequestLabel(pull(4, 'CLOSED')), 'Closed PR #4');
  assert.equal(pullRequestLabel({ number: 3, url: '' }), 'PR #3');
});

test('pre-creation lookup checks all PR states and propagates failed lookups', async () => {
  const found = await findBranchPr(branch, '/project', async (args, cwd) => {
    assert.equal(cwd, '/project');
    assert.equal(args[args.indexOf('--state') + 1], 'all');
    assert.equal(args[args.indexOf('--head') + 1], branch);
    return JSON.stringify([pull(1, 'MERGED')]);
  });
  assert.equal(found?.state, 'MERGED');
  await assert.rejects(findBranchPr(branch, '/project', async () => { throw new Error('GitHub unavailable'); }), /GitHub unavailable/);
});

test('external PRs attach to desks, update through merge, and persist across restarts', (t) => {
  const f = fixture(t);
  const workers = f.open();
  workers.onPulls([pull(1, 'OPEN'), pull(2, 'OPEN', 'unrelated')]);
  assert.equal(workers.get('worker')?.pr?.number, 1);
  assert.equal(f.updates.length, 1);
  workers.onPulls([pull(1, 'OPEN')]);
  assert.equal(f.updates.length, 1, 'unchanged polls must not broadcast redundant worker updates');
  workers.onPulls([pull(1, 'MERGED')]);
  assert.equal(workers.get('worker')?.pr?.state, 'MERGED');
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8'));
  assert.equal(saved[0].pr.state, 'MERGED');
  assert.equal(f.open().get('worker')?.pr?.state, 'MERGED');
  workers.onPulls([]);
  assert.equal(workers.get('worker')?.pr?.number, 1, 'bounded board history must not erase the saved PR');
});

test('workers recognize a PR first discovered after merge and upgrade legacy links', (t) => {
  const f = fixture(t, { number: 1, url: pull(1, 'MERGED').url });
  const workers = f.open();
  assert.equal(workers.get('worker')?.pr?.state, undefined);
  workers.onPulls([pull(1, 'MERGED')]);
  assert.equal(workers.get('worker')?.pr?.state, 'MERGED');
  workers.onPulls([pull(2, 'OPEN'), pull(1, 'MERGED')]);
  assert.equal(workers.get('worker')?.pr?.number, 2);
});

test('opening a worker PR reuses its merged link even with no new commits or remote', async (t) => {
  const f = fixture(t);
  const workers = f.open();
  workers.onPulls([pull(1, 'MERGED')]);
  const result = await workers.openPr('worker', 'Tester');
  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;
  assert.equal(result.existed, true);
  assert.equal(result.url, pull(1, 'MERGED').url);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
  assert.equal(f.git('remote'), '');
});

test('Changes retains merged state and refuses a duplicate PR before attempting a push', async (t) => {
  const f = fixture(t);
  let pr = pullForBranch([pull(1, 'OPEN')], branch);
  const states: ChangesState[] = [];
  let refreshes = 0;
  const changes = new Changes(f.root, 'main', () => ({ name: 'Test', cwd: f.root, rel: '.', worktreeBase: f.base }), () => pr, {
    state: (state) => states.push(state), toast() {}, refreshGitHub: () => refreshes++,
  });
  t.after(() => changes.stop());
  changes.watch('worker', 'client');
  for (let i = 0; i < 100 && !states.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(states.at(-1)?.pr?.state, 'OPEN');
  pr = pullForBranch([pull(1, 'MERGED')], branch);
  const result = await changes.pullRequest('worker', 'Duplicate', '', 'Tester');
  assert.match(result ?? '', /Merged PR #1 already exists/);
  assert.equal(states.at(-1)?.pr?.state, 'MERGED');
  assert.equal(refreshes, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});
