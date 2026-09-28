import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workerBranches } from '../src/server/worker-branches.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-branches-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(path.dirname(resolved), realpathSync(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('office-branches-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  function repo(name: string, commit = true) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Branch Test');
    git(dir, 'config', 'user.email', 'branch-test@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    if (commit) git(dir, 'commit', '--allow-empty', '-m', 'Fixture');
    return dir;
  }
  return { root, repo };
}

test('branch display follows actual checkout switches and keeps a worker worktree separate', async t => {
  const f = fixture(t);
  const root = f.repo('project');
  assert.deepEqual(await workerBranches(root, {}), [{ branch: 'main' }]);
  git(root, 'switch', '-c', 'personal');
  assert.deepEqual(await workerBranches(root, {}), [{ branch: 'personal' }]);
  git(root, 'worktree', 'add', '-b', 'office/pixel', 'pixel');
  const worker = { worktree: { path: 'pixel', branch: 'office/pixel', base: 'HEAD' } };
  assert.deepEqual(await workerBranches(root, worker), [{ branch: 'office/pixel' }]);
  git(path.join(root, 'pixel'), 'switch', '-c', 'feature/changed');
  assert.deepEqual(await workerBranches(root, worker), [{ branch: 'feature/changed' }]);
  assert.deepEqual(await workerBranches(root, {}), [{ branch: 'personal' }]);
});

test('branch display handles unborn branches, detached HEAD, and non-Git folders', async t => {
  const f = fixture(t);
  assert.deepEqual(await workerBranches(f.repo('empty', false), {}), [{ branch: 'main' }]);
  const root = f.repo('detached');
  git(root, 'switch', '--detach');
  assert.deepEqual(await workerBranches(root, {}), [{ commit: git(root, 'rev-parse', '--short', 'HEAD') }]);
  assert.deepEqual(await workerBranches(f.root, {}), [{}]);
  assert.deepEqual(await workerBranches(path.join(f.root, 'missing'), {}), [{}]);
});

test('multi-repository workspaces read each current worktree branch instead of saved names', async t => {
  const f = fixture(t);
  const a = f.repo('frontend');
  const b = f.repo('backend');
  git(a, 'switch', '-c', 'feature/ui');
  git(b, 'switch', '-c', 'feature/api');
  const workspace = { path: '.', repositories: [
    { repository: 'frontend', name: 'frontend', path: 'frontend', branch: 'stale', base: 'HEAD' },
    { repository: 'backend', name: 'backend', path: 'backend', branch: 'stale', base: 'HEAD' },
  ] };
  assert.deepEqual(await workerBranches(f.root, { workspace }), [
    { repository: 'frontend', branch: 'feature/ui' },
    { repository: 'backend', branch: 'feature/api' },
  ]);
});
