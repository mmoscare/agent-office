import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspaces, workspaceRepositories } from '../src/server/workspaces.js';
import { workspaceStart } from '../src/server/workspace-branches.js';
import type { WorkerWorkspace, WorkspaceRequest } from '../src/shared/workspaces.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t: { after(fn: () => void): void }) {
  const floor = mkdtempSync(path.join(tmpdir(), 'office-start-branches-'));
  t.after(() => {
    const resolved = realpathSync(floor);
    assert.equal(path.dirname(resolved), realpathSync(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('office-start-branches-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  for (const name of ['frontend', 'backend']) {
    const dir = path.join(floor, name); mkdirSync(dir);
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Branch Test'); git(dir, 'config', 'user.email', 'branch-test@example.invalid');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.hooksPath', path.join(floor, 'no-hooks'));
    writeFileSync(path.join(dir, 'app.txt'), `${name} main\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Main');
    git(dir, 'switch', '-c', 'personal');
    writeFileSync(path.join(dir, 'app.txt'), `${name} personal\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Personal');
    git(dir, 'switch', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/test/project.git');
    git(dir, 'update-ref', 'refs/remotes/origin/development', git(dir, 'rev-parse', 'personal'));
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/development');
    git(dir, 'tag', 'release');
  }
  return { floor, frontend: path.join(floor, 'frontend'), backend: path.join(floor, 'backend'), manager: new Workspaces(floor) };
}

test('branch picker lists local and last-fetched remote branches, excluding tags and remote HEAD aliases', async t => {
  const f = fixture(t);
  const result = await workspaceRepositories(f.floor);
  for (const repo of result.repositories) {
    assert.equal(repo.branch, 'main');
    assert.deepEqual(repo.branches, [
      { ref: 'refs/heads/main', name: 'main', remote: false },
      { ref: 'refs/heads/personal', name: 'personal', remote: false },
      { ref: 'refs/remotes/origin/development', name: 'origin/development', remote: true },
    ]);
  }
});

test('each repository starts at its selected branch while original branches and unfinished edits stay intact', t => {
  const f = fixture(t);
  git(f.backend, 'branch', '-D', 'personal');
  for (const dir of [f.frontend, f.backend]) writeFileSync(path.join(dir, 'app.txt'), 'unfinished original edits\n');
  const result = f.manager.create('selected', {
    repositories: ['frontend', 'backend'], branch: 'feature/selected',
    startRefs: { frontend: 'refs/heads/personal', backend: 'refs/remotes/origin/development' },
  });
  assert.notEqual(typeof result, 'string', String(result));
  const ws = result as WorkerWorkspace;
  for (const repo of ws.repositories) {
    const original = path.join(f.floor, repo.repository);
    const worktree = path.join(f.floor, repo.path);
    assert.equal(git(worktree, 'branch', '--show-current'), 'feature/selected');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(original, 'rev-parse', repo.fromRef!));
    assert.equal(repo.base, git(worktree, 'rev-parse', 'HEAD'));
    assert.equal(readFileSync(path.join(worktree, 'app.txt'), 'utf8'), `${repo.name} personal\n`);
    assert.equal(git(original, 'branch', '--show-current'), 'main');
    assert.equal(readFileSync(path.join(original, 'app.txt'), 'utf8'), 'unfinished original edits\n');
    assert.equal(git(worktree, 'status', '--porcelain'), '');
  }
  assert.deepEqual(ws.repositories.map(r => r.from), ['personal', 'development']);
  assert.equal(git(f.backend, 'branch', '--list', 'development'), '', 'remote selection does not create a local source branch');
  const brief = readFileSync(path.join(f.floor, ws.path, 'AGENTS.md'), 'utf8');
  assert.match(brief, /source branch "personal"/);
  assert.match(brief, /source branch "origin\/development"/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.floor, ws.path, 'workspace.json'), 'utf8')), ws);
});

test('single-repository floors and repositories added later honor the chosen starting branch', t => {
  const f = fixture(t);
  const single = new Workspaces(f.frontend).create('root', { repositories: ['.'], startRefs: { '.': 'refs/heads/personal' } });
  assert.notEqual(typeof single, 'string', String(single));
  assert.equal((single as WorkerWorkspace).repositories[0].from, 'personal');
  const first = f.manager.create('expand', { repositories: ['frontend'], branch: 'feature/expand' }) as WorkerWorkspace;
  const front = path.join(f.floor, first.repositories[0].path);
  writeFileSync(path.join(front, 'app.txt'), 'existing worker edits\n');
  const added = f.manager.add(first, { repositories: ['backend'], startRefs: { backend: 'refs/remotes/origin/development' } });
  assert.notEqual(typeof added, 'string', String(added));
  const backend = (added as WorkerWorkspace).repositories[1];
  assert.equal(backend.branch, 'feature/expand');
  assert.equal(backend.from, 'development');
  assert.equal(readFileSync(path.join(f.floor, backend.path, 'app.txt'), 'utf8'), 'backend personal\n');
  assert.equal(readFileSync(path.join(front, 'app.txt'), 'utf8'), 'existing worker edits\n');
});

test('invalid or disappeared starting branches fail before any checkout or branch is created', t => {
  const f = fixture(t);
  for (const ref of ['HEAD', 'main', 'refs/tags/release', 'refs/heads/missing', 'refs/heads/personal~1', 'refs/remotes/origin/HEAD', '--help', '']) {
    const result = f.manager.create('invalid', {
      repositories: ['frontend', 'backend'], branch: 'feature/invalid',
      startRefs: { frontend: 'refs/heads/personal', backend: ref },
    });
    assert.equal(typeof result, 'string', ref);
    assert.equal(git(f.frontend, 'branch', '--list', 'feature/invalid'), '');
    assert.equal(existsSync(path.join(f.floor, '.agent-office/workspaces/invalid')), false);
  }
  for (const startRefs of [null, [], 'personal', { missing: 'refs/heads/main' }, { frontend: 1 }]) {
    assert.equal(typeof f.manager.create('bad-input', { repositories: ['frontend'], startRefs } as WorkspaceRequest), 'string');
  }
  git(f.backend, 'branch', '-D', 'personal');
  assert.equal(typeof f.manager.create('stale', { repositories: ['frontend', 'backend'], startRefs: { frontend: 'refs/heads/personal', backend: 'refs/heads/personal' } }), 'string');
  assert.equal(git(f.frontend, 'branch', '--list', 'office/stale'), '');
});

test('remote source branch names retain slashes for the pull request target', t => {
  const f = fixture(t);
  git(f.backend, 'remote', 'add', 'team/fork', 'https://example.invalid/team/project.git');
  git(f.backend, 'update-ref', 'refs/remotes/team/fork/feature/login', git(f.backend, 'rev-parse', 'personal'));
  assert.equal(workspaceStart(f.backend, 'refs/remotes/team/fork/feature/login').from, 'feature/login');
});
