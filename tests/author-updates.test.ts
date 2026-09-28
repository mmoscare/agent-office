import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthorUpdateMonitor } from '../src/server/author-updates.js';
import { authorUpdatePrompt } from '../src/shared/author-updates.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'office-author-updates-')));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('office-author-updates-'));
    assert.equal(path.dirname(root), realpathSync(os.tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'personal floor');
  mkdirSync(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Update test']);
  git(dir, ['config', 'user.email', 'updates@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(dir, 'app.txt'), 'original\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'Original']);
  git(dir, ['branch', 'personal']);
  const remote = path.join(root, 'author.git');
  git(root, ['clone', '--bare', dir, remote]);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/mmoscare/agent-office.git']);
  git(dir, ['remote', 'add', 'upstream', 'https://github.com/AgentSystemLabs/agent-office.git']);
  git(dir, ['switch', 'personal']);
  const calls: string[][] = [];
  let failFetch = false;
  let now = 100_000;
  const monitor = new AuthorUpdateMonitor(async (cwd, args) => {
    calls.push(args);
    if (args[0] === 'fetch') {
      if (failFetch) throw new Error('Offline');
      // All Git operations are real; replace only network transport with the local author mirror.
      assert.deepEqual(args.slice(1), ['--quiet', '--no-tags', '--no-write-fetch-head', 'upstream', 'refs/heads/main:refs/remotes/upstream/main']);
      return git(cwd, args.map(a => a === 'upstream' ? remote : a));
    }
    return git(cwd, args);
  }, () => now);
  const update = () => {
    git(dir, ['switch', 'main']);
    writeFileSync(path.join(dir, 'app.txt'), 'author improvement\n');
    git(dir, ['commit', '-qam', 'Author improvement']);
    git(dir, ['push', remote, 'main']);
    git(dir, ['switch', 'personal']);
  };
  return { root, dir, monitor, calls, update, offline: () => { failFetch = true; }, advance: () => { now += 300_001; } };
}

test('reports author commits missing from personal without changing branch, files or FETCH_HEAD', async t => {
  const f = fixture(t);
  f.update();
  writeFileSync(path.join(f.dir, 'keep.txt'), 'uncommitted work');
  const before = git(f.dir, ['status', '--porcelain']);
  const head = git(f.dir, ['rev-parse', 'HEAD']);
  const result = await f.monitor.read(f.dir);
  assert.equal(result.enabled, true);
  assert.equal(result.behind, 1);
  assert.equal(result.changes?.[0].subject, 'Author improvement');
  assert.equal(path.resolve(result.personalDir!), f.dir);
  assert.equal(result.error, undefined);
  assert.equal(git(f.dir, ['rev-parse', 'HEAD']), head);
  assert.equal(git(f.dir, ['status', '--porcelain']), before);
  assert.throws(() => git(f.dir, ['rev-parse', '--verify', 'FETCH_HEAD']));
  git(f.dir, ['merge', '--no-edit', 'main']);
  f.advance();
  assert.equal((await f.monitor.read(f.dir)).behind, 0);
});

test('coalesces concurrent browsers, caches polling and lets a later manual check refresh', async t => {
  const f = fixture(t);
  await Promise.all([f.monitor.read(f.dir), f.monitor.read(f.dir), f.monitor.read(f.dir, true)]);
  await f.monitor.read(f.dir);
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 1);
  f.update();
  f.advance();
  assert.equal((await f.monitor.read(f.dir, true)).behind, 1);
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 2);
});

test('is hidden on unrelated repositories, parent floors, subdirectories and worker worktrees', async t => {
  const f = fixture(t);
  assert.equal((await f.monitor.read(f.root)).enabled, false);
  const sub = path.join(f.dir, 'sub');
  mkdirSync(sub);
  assert.equal((await f.monitor.read(sub)).enabled, false);
  const worker = path.join(f.root, 'worker');
  git(f.dir, ['worktree', 'add', '-b', 'worker', worker]);
  assert.equal((await f.monitor.read(worker)).enabled, false);
  git(f.dir, ['remote', 'set-url', 'origin', 'https://github.com/someone/portfolio.git']);
  assert.equal((await f.monitor.read(f.dir)).enabled, false);
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
});

test('an unavailable or wrong upstream is an error, never an up-to-date report', async t => {
  const f = fixture(t);
  f.offline();
  const offline = await f.monitor.read(f.dir);
  assert.equal(offline.enabled, true);
  assert.equal(offline.error, 'Offline');
  assert.equal(offline.checkedAt, undefined);
  assert.equal(offline.behind, undefined);
  f.advance();
  git(f.dir, ['remote', 'set-url', 'upstream', 'https://github.com/someone/unrelated.git']);
  assert.match((await f.monitor.read(f.dir)).error!, /Configure upstream/);
});

test('reports real merge conflicts and provides a preservation-first worker task', async t => {
  const f = fixture(t);
  f.update();
  writeFileSync(path.join(f.dir, 'app.txt'), 'personal behavior\n');
  git(f.dir, ['commit', '-qam', 'Personal behavior']);
  assert.throws(() => git(f.dir, ['merge', '--no-edit', 'main']));
  const state = await f.monitor.read(f.dir);
  assert.equal(state.merging, true);
  assert.deepEqual(state.conflicts, ['app.txt']);
  assert.equal(state.behind, 1);
  const prompt = authorUpdatePrompt(state);
  assert.match(prompt, /unfinished merge/);
  assert.match(prompt, /verify MERGE_HEAD/);
  assert.match(prompt, /npm test, npm run typecheck and npm run build/);
  assert.match(prompt, /Do not restart or stop this office while workers are active/);
  assert.match(prompt, /upstream\/main -> main/);
  assert.match(prompt, /never run a second merge concurrently/);
});

test('missing personal branch is actionable and does not fetch against the wrong branch', async t => {
  const f = fixture(t);
  git(f.dir, ['switch', 'main']);
  git(f.dir, ['branch', '-D', 'personal']);
  const state = await f.monitor.read(f.dir);
  assert.equal(state.enabled, true);
  assert.ok(state.error);
  assert.equal(state.behind, undefined);
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
});
