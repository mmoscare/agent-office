import test from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspaces, workspaceRepositories, workspaceGitHubRepo } from '../src/server/workspaces.js';
import { WorkspaceChanges } from '../src/server/workspace-changes.js';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import type { ChangesState, WorkerInfo } from '../src/shared/protocol.js';
import type { WorkerWorkspace } from '../src/shared/workspaces.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office workspaces '));
  const floor = path.join(root, 'project');
  mkdirSync(floor);
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(path.dirname(resolved), realpathSync(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('office workspaces '));
    rmSync(resolved, { recursive: true, force: true });
  });
  function repo(name: string) {
    const dir = path.join(floor, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Workspace Test');
    git(dir, 'config', 'user.email', 'workspace-test@example.invalid');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'app.txt'), `original ${name}\n`);
    writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Initial');
    return dir;
  }
  const frontend = repo('frontend');
  const backend = repo('backend');
  const manager = new Workspaces(floor);
  const make = (repos = ['frontend', 'backend'], branch = 'feature/login') => {
    const result = manager.create('test-worker', { repositories: repos, branch });
    assert.notEqual(typeof result, 'string', String(result));
    return result as WorkerWorkspace;
  };
  return { root, floor, frontend, backend, manager, repo, make };
}

function fakeWorkers(f: ReturnType<typeof fixture>, t: { after(fn: () => void): void }) {
  const data = path.join(f.floor, '.agent-office'); mkdirSync(data, { recursive: true });
  const invocations: { cwd: string; args: string[] }[] = [];
  const input: string[] = [];
  const workers = new WorkerManager(f.floor, data, 'codex', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  // Record the actual launch contract without starting a provider or spending API/subscription usage.
  (workers as any).host = {
    spawn(opts: { cwd: string; args: string[] }) { invocations.push(opts); return { pid: 12345, write(s: string) { input.push(s); }, kill() {}, resize() {}, onData() {}, onExit() {} }; },
    stop() {}, detach() {},
  };
  t.after(() => workers.shutdown());
  return { workers, invocations, input, data };
}

test('discovers local repos, including dirty checkouts, without following directory links or dependencies', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.frontend, 'uncommitted.txt'), 'keep');
  f.repo('node_modules/ignored');
  f.repo('group/service');
  symlinkSync(f.backend, path.join(f.floor, 'backend-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await workspaceRepositories(f.floor);
  assert.deepEqual(result.repositories.map(r => r.path), ['backend', 'frontend', 'group/service']);
  assert.equal(result.repositories.find(r => r.path === 'frontend')?.dirty, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual((await workspaceRepositories(f.frontend)).repositories.map(r => r.path), ['.']);
});

test('two worktrees share a workspace and branch name while preserving originals and ignored files', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.frontend, 'app.txt'), 'unfinished original work\n');
  writeFileSync(path.join(f.backend, '.env'), 'test fixture only');
  const ws = f.make();
  assert.equal(ws.repositories.length, 2);
  const front = path.join(f.floor, ws.repositories[0].path);
  const back = path.join(f.floor, ws.repositories[1].path);
  assert.equal(path.dirname(front), path.dirname(back));
  assert.equal(git(front, 'branch', '--show-current'), 'feature/login');
  assert.equal(git(back, 'branch', '--show-current'), 'feature/login');
  assert.equal(git(f.frontend, 'branch', '--show-current'), 'main');
  assert.equal(readFileSync(path.join(front, 'app.txt'), 'utf8'), 'original frontend\n');
  assert.equal(readFileSync(path.join(f.frontend, 'app.txt'), 'utf8'), 'unfinished original work\n');
  assert.equal(existsSync(path.join(back, '.env')), false);
  const brief = readFileSync(path.join(f.floor, ws.path, 'AGENTS.md'), 'utf8');
  assert.match(brief, /frontend/); assert.match(brief, /backend/); assert.match(brief, /NOT copied/);
  writeFileSync(path.join(back, 'app.txt'), 'backend change\n');
  const state = await f.manager.inspect(ws);
  assert.equal(state.error, undefined);
  assert.equal(state.dirty, 1);
  assert.equal(state.repositories?.find(r => r.repository === 'frontend')?.dirty, 0);
  assert.equal(state.repositories?.find(r => r.repository === 'backend')?.dirty, 1);
});

test('preflight refuses branch collisions, duplicates, invalid names, and paths outside the floor', t => {
  const f = fixture(t);
  git(f.backend, 'branch', 'feature/existing');
  assert.match(f.manager.create('collision', { repositories: ['frontend', 'backend'], branch: 'feature/existing' }) as string, /already has branch/);
  assert.equal(git(f.frontend, 'branch', '--list', 'feature/existing'), '');
  for (const request of [
    { repositories: ['../project/frontend'] }, { repositories: [f.frontend] },
    { repositories: ['frontend', 'frontend'] }, { repositories: ['frontend'], branch: '--bad' },
    { repositories: ['frontend'], branch: 'not a branch' }, { repositories: [] },
    { repositories: ['missing'] },
  ]) assert.equal(typeof f.manager.create('invalid', request), 'string');
  assert.equal(existsSync(path.join(f.floor, '.agent-office/workspaces/invalid')), false);
});

test('a failure creating the second repo rolls back the first without changing its original checkout', t => {
  const f = fixture(t);
  const original = cp.execFileSync;
  const mock = t.mock.method(cp, 'execFileSync', ((cmd: string, args: string[], opts: any) => {
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add' && opts.cwd === f.backend) throw new Error('fixture checkout failure');
    return original(cmd, args, opts);
  }) as typeof execFileSync);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const result = f.manager.create('rollback', { repositories: ['frontend', 'backend'], branch: 'feature/rollback' });
  assert.match(result as string, /fixture checkout failure/);
  assert.equal(git(f.frontend, 'branch', '--list', 'feature/rollback'), '');
  assert.equal(git(f.frontend, 'status', '--porcelain'), '');
});

test('adding a repo later preserves existing worktrees and updates the workspace instructions', async t => {
  const f = fixture(t);
  const first = f.make(['frontend']);
  const cwd = path.join(f.floor, first.repositories[0].path);
  writeFileSync(path.join(cwd, 'app.txt'), 'already working\n');
  const expanded = f.manager.add(first, { repositories: ['backend'] });
  assert.notEqual(typeof expanded, 'string', String(expanded));
  const ws = expanded as WorkerWorkspace;
  assert.equal(ws.repositories[1].branch, 'feature/login');
  assert.equal(readFileSync(path.join(cwd, 'app.txt'), 'utf8'), 'already working\n');
  assert.match(readFileSync(path.join(f.floor, ws.path, 'AGENTS.md'), 'utf8'), /backend/);
  assert.equal((await f.manager.inspect(ws)).dirty, 1);
});

test('missing, relocated or switched worktrees block Git actions rather than using original checkouts', t => {
  const f = fixture(t);
  const ws = f.make();
  const ref = ws.repositories[0];
  const cwd = path.join(f.floor, ref.path);
  git(cwd, 'switch', '-c', 'another-branch');
  assert.throws(() => f.manager.check(ws), /no longer on/);
  git(cwd, 'switch', ref.branch);
  git(f.frontend, 'worktree', 'remove', cwd);
  assert.throws(() => f.manager.check(ws), /missing/);
  symlinkSync(f.frontend, cwd, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.manager.check(ws), /outside the workspace/);
  assert.equal(git(f.frontend, 'branch', '--show-current'), 'main');
});

test('worker launch, restore, add-repo and safe default cleanup cover every repository', async t => {
  const f = fixture(t);
  const a = fakeWorkers(f, t);
  const result = a.workers.spawn('desk-1', 'Test', 'Fix login across frontend and backend', true, 'agent', 'codex', undefined, undefined, undefined, { repositories: ['frontend'], branch: 'feature/worker' });
  assert.notEqual(typeof result, 'string', String(result));
  const worker = result as WorkerInfo;
  assert.equal(a.invocations[0].cwd, path.join(f.floor, worker.workspace!.path));
  assert.match(a.invocations[0].args.at(-1)!, /frontend/);
  worker.status = 'idle';
  assert.equal(a.workers.addRepositories(worker.id, { repositories: ['backend'] }, 'Test'), undefined);
  assert.equal(worker.workspace!.repositories.length, 2);
  assert.match(a.input.join(''), /Re-read AGENTS/);
  const saved = JSON.parse(readFileSync(path.join(a.data, 'workers.json'), 'utf8'));
  assert.equal(saved[0].workspace.repositories.length, 2);
  a.workers.shutdown();
  const b = fakeWorkers(f, t);
  assert.equal(b.workers.get(worker.id)?.workspace?.repositories.length, 2);
  assert.equal(b.workers.resume(worker.id), undefined);
  assert.equal(b.invocations[0].cwd, a.invocations[0].cwd);
  assert.match(b.invocations[0].args.at(-1)!, /backend/);
  const back = path.join(f.floor, worker.workspace!.repositories[1].path);
  writeFileSync(path.join(back, 'app.txt'), 'work to keep\n');
  const sentHome = await b.workers.kill(worker.id);
  assert.match(sentHome.note!, /Kept/);
  for (const r of worker.workspace!.repositories) assert.equal(existsSync(path.join(f.floor, r.path)), true);
});

test('per-repository Changes sessions isolate same-named files and commit only the selected repository', async t => {
  const f = fixture(t);
  const ws = f.make();
  const front = path.join(f.floor, ws.repositories[0].path);
  const back = path.join(f.floor, ws.repositories[1].path);
  writeFileSync(path.join(front, 'app.txt'), 'front task\n');
  writeFileSync(path.join(back, 'app.txt'), 'back task\n');
  const worker = { id: 'worker', name: 'Test', workspace: ws } as WorkerInfo;
  const states: ChangesState[] = [];
  const readers = new WorkspaceChanges(f.floor, () => worker, { state(s) { states.push(s); }, toast() {}, refreshGitHub() {} });
  t.after(() => readers.stop());
  const a = readers.get('worker', 'frontend')!;
  const b = readers.get('worker', 'backend')!;
  assert.equal(readers.get('worker', '../frontend'), undefined);
  a.watch('worker', 'client-a'); b.watch('worker', 'client-b');
  const diffA = await a.diff('worker', 'app.txt');
  const diffB = await b.diff('worker', 'app.txt');
  assert.ok(typeof diffA !== 'string'); assert.ok(typeof diffB !== 'string');
  assert.match(diffA.diff, /front task/); assert.doesNotMatch(diffA.diff, /back task/);
  assert.match(diffB.diff, /back task/);
  assert.equal(await a.commit('worker', 'Frontend work', 'Test'), undefined);
  assert.equal(git(front, 'status', '--porcelain'), '');
  assert.match(git(back, 'status', '--porcelain'), /app.txt/);
  assert.equal(git(f.frontend, 'log', '-1', '--format=%s'), 'Initial');
  assert.ok(states.some(s => s.repository === 'frontend'));
  assert.ok(states.some(s => s.repository === 'backend'));
});

test('PR actions use the selected starting branches and each repo remote, with independent PRs', async t => {
  const f = fixture(t);
  const a = fakeWorkers(f, t);
  for (const name of ['frontend', 'backend']) {
    const dir = path.join(f.floor, name);
    const remote = path.join(f.root, `${name}.git`);
    mkdirSync(remote); git(remote, 'init', '--bare');
    git(dir, 'remote', 'add', 'origin', `https://github.com/test/${name}.git`);
    git(dir, 'remote', 'set-url', '--push', 'origin', remote);
    git(dir, 'push', '-u', 'origin', 'main');
    git(dir, 'branch', 'personal');
    git(dir, 'push', 'origin', 'personal');
  }
  const calls: { cwd: string; args: string[] }[] = [];
  const opened = new Map<string, { number: number; url: string }>();
  const original = cp.execFile;
  const mock = t.mock.method(cp, 'execFile', ((cmd: string, args: string[], opts: any, callback: any) => {
    if (cmd !== 'gh') return (original as any)(cmd, args, opts, callback);
    calls.push({ cwd: opts.cwd, args });
    const pr = { number: 1, url: `https://github.com/test/${path.basename(opts.cwd)}/pull/1` };
    // The open-PR lookup goes over REST (github-rest.ts); gh pr create prints the new PR's URL.
    const listed = opened.has(opts.cwd) ? [opened.get(opts.cwd)!] : [];
    const out = args[0] === 'api' ? JSON.stringify(listed.map(p => ({ number: p.number, html_url: p.url, state: 'open', merged_at: null, head: { ref: 'feature/pr', sha: 'abc' } }))) : `${pr.url}\n`;
    if (args[1] === 'create') opened.set(opts.cwd, pr);
    queueMicrotask(() => callback(null, out, ''));
    return {};
  }) as typeof cp.execFile);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const worker = a.workers.spawn('desk-1', 'Test', undefined, true, 'agent', 'codex', undefined, undefined, undefined, { repositories: ['frontend', 'backend'], branch: 'feature/pr', startRefs: { frontend: 'refs/heads/personal', backend: 'refs/remotes/origin/personal' } }) as WorkerInfo;
  worker.status = 'idle';
  for (const r of worker.workspace!.repositories) {
    const cwd = path.join(f.floor, r.path);
    writeFileSync(path.join(cwd, 'app.txt'), `${r.name} changed\n`);
    git(cwd, 'add', '.'); git(cwd, 'commit', '-m', `Change ${r.name}`);
    const result = await a.workers.openPr(worker.id, 'Test', r.repository);
    assert.notEqual(typeof result, 'string', String(result));
    assert.equal(r.pr?.number, 1);
    assert.equal(r.pr?.url, `https://github.com/test/${r.name}/pull/1`);
    assert.equal(git(path.join(f.root, `${r.name}.git`), 'rev-parse', 'feature/pr'), git(cwd, 'rev-parse', 'HEAD'));
  }
  assert.equal(worker.pr, undefined);
  assert.equal(calls.filter(c => c.args[1] === 'create').length, 2);
  for (const c of calls.filter(c => c.args[1] === 'create')) assert.equal(c.args[c.args.indexOf('--base') + 1], 'personal');
  for (const c of calls) {
    // Each repository by its own origin's name: --repo for gh, the REST path for the lookup.
    if (c.args[0] === 'api') assert.deepEqual(c.args, ['api', '-i', `repos/test/${path.basename(c.cwd)}/pulls?state=open&head=test:feature%2Fpr&per_page=100`]);
    else assert.equal(c.args[c.args.indexOf('--repo') + 1], `github.com/test/${path.basename(c.cwd)}`);
  }
  assert.equal(calls.filter(c => c.args[0] === 'api').length, 2);
  const saved = JSON.parse(readFileSync(path.join(a.data, 'workers.json'), 'utf8'));
  assert.equal(saved[0].workspace.repositories.filter((r: any) => r.pr).length, 2);
  await a.workers.kill(worker.id, 'keep');
});

test('PR targets use the selected repository for HTTPS and SSH without forwarding URL credentials', () => {
  assert.equal(workspaceGitHubRepo('https://github.com/owner/project.git'), 'github.com/owner/project');
  assert.equal(workspaceGitHubRepo('git@github.com:owner/project.git'), 'github.com/owner/project');
  assert.equal(workspaceGitHubRepo('ssh://git@github.example.com/owner/project.git'), 'github.example.com/owner/project');
  assert.equal(workspaceGitHubRepo('https://fixture-user:fixture-password@github.com/owner/project.git'), 'github.com/owner/project');
  assert.throws(() => workspaceGitHubRepo('/some/local/path'));
});

test('explicit cleanup removes the selected worktrees and keeps branches or deletes both as requested', async t => {
  const f = fixture(t);
  const ws = f.make();
  assert.equal(await f.manager.remove(ws, 'worktree'), undefined);
  for (const r of ws.repositories) {
    assert.equal(existsSync(path.join(f.floor, r.path)), false);
    assert.ok(git(path.join(f.floor, r.repository), 'branch', '--list', r.branch));
    assert.equal(git(path.join(f.floor, r.repository), 'branch', '--show-current'), 'main');
  }
  const next = f.manager.create('clean-worker', { repositories: ['frontend', 'backend'], branch: 'feature/clean' });
  assert.notEqual(typeof next, 'string');
  assert.equal(await f.manager.remove(next as WorkerWorkspace, 'all'), undefined);
  assert.equal(git(f.frontend, 'branch', '--list', 'feature/clean'), '');
  assert.equal(git(f.backend, 'branch', '--list', 'feature/clean'), '');
});
