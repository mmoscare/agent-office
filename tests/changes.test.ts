import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes } from '../src/server/changes.js';
import type { ChangesState } from '../src/shared/protocol.js';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-changes-'));
  const floor = path.join(root, 'project');
  mkdirSync(floor);
  const readers: Changes[] = [];
  t.after(() => {
    readers.forEach((r) => r.stop());
    assert.equal(path.dirname(realpathSync(root)), realpathSync(tmpdir()));
    assert.ok(path.basename(root).startsWith('office-changes-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  function repo(name: string, initial = true) {
    const dir = path.join(floor, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Panel Test');
    git(dir, 'config', 'user.email', 'panel@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    if (initial) {
      writeFileSync(path.join(dir, 'app.txt'), 'original\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', 'Initial');
    }
    return dir;
  }
  function reader(cwd = floor) {
    let resolve!: (s: ChangesState) => void;
    const state = new Promise<ChangesState>((done) => { resolve = done; });
    const changes = new Changes(cwd, undefined, () => ({ name: 'Pixel', cwd, rel: '' }), () => undefined, {
      state(s) { resolve(s); }, toast() {}, refreshGitHub() {},
    });
    readers.push(changes);
    changes.watch('pixel', 'test');
    return { changes, state };
  }
  return { root, floor, repo, reader };
}

test('shared project lists and diffs same-named files in both child repositories', async t => {
  const f = fixture(t);
  const back = f.repo('backend');
  const front = f.repo('frontend');
  writeFileSync(path.join(back, 'app.txt'), 'backend edit\n');
  git(back, 'add', 'app.txt');
  writeFileSync(path.join(front, 'app.txt'), 'frontend edit\n');
  const { changes, state: first } = f.reader();
  const state = await first;
  assert.equal(state.error, undefined);
  assert.deepEqual(state.repositories?.map(r => r.path), ['backend', 'frontend']);
  assert.deepEqual(state.files.map(f => f.path), ['backend/app.txt', 'frontend/app.txt']);
  assert.ok(state.files.every(f => f.uncommitted && f.additions === 1 && f.deletions === 1));
  for (const repo of ['backend', 'frontend']) {
    const diff = await changes.diff('pixel', repo + '/app.txt');
    assert.notEqual(typeof diff, 'string', String(diff));
    if (typeof diff !== 'string') assert.match(diff.diff, new RegExp('\\+' + repo + ' edit'));
  }
  assert.equal(await changes.diff('pixel', '../app.txt'), 'That file has no changes');
});

test('combined diffs handle untracked paths, binary files, deletions and renames', async t => {
  const f = fixture(t);
  const repo = f.repo('backend');
  writeFileSync(path.join(repo, 'gone.txt'), 'removed\n');
  writeFileSync(path.join(repo, 'old.txt'), 'renamed content\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixtures');
  git(repo, 'rm', 'gone.txt'); git(repo, 'mv', 'old.txt', 'new name.txt');
  writeFileSync(path.join(repo, 'new file.txt'), 'new content\n');
  writeFileSync(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
  const { changes, state: first } = f.reader();
  const state = await first;
  assert.equal(state.files.find(f => f.path === 'backend/binary.bin')?.binary, true);
  assert.equal(state.files.find(f => f.path === 'backend/gone.txt')?.status, 'D');
  assert.equal(state.files.find(f => f.path === 'backend/new name.txt')?.from, 'backend/old.txt');
  for (const [file, expected] of [['new file.txt', /\+new content/], ['gone.txt', /-removed/], ['new name.txt', /rename to new name.txt/], ['binary.bin', /Binary files/]] as const) {
    const diff = await changes.diff('pixel', 'backend/' + file);
    assert.notEqual(typeof diff, 'string', String(diff));
    if (typeof diff !== 'string') assert.match(diff.diff, expected);
  }
});

test('one unreadable or unborn repository does not hide changes in another', async t => {
  const f = fixture(t);
  const repo = f.repo('backend');
  f.repo('empty', false);
  const broken = path.join(f.floor, 'broken');
  mkdirSync(broken);
  writeFileSync(path.join(broken, '.git'), 'gitdir: missing-git-directory\n');
  writeFileSync(path.join(repo, 'app.txt'), 'keep visible\n');
  const { state: first } = f.reader();
  const state = await first;
  assert.deepEqual(state.files.map(f => f.path), ['backend/app.txt']);
  assert.equal(state.error, undefined);
  assert.equal(state.repositories?.find(r => r.path === 'empty')?.error, 'No commits yet');
  assert.match(state.repositories?.find(r => r.path === 'broken')?.error ?? '', /not a git repository/);
});

test('a non-repository folder gets an accurate error, and a clean child repo gets an empty list', async t => {
  const f = fixture(t);
  const missing = await f.reader().state;
  assert.match(missing.error ?? '', /not a Git repository/);
  assert.doesNotMatch(missing.error ?? '', /No commits yet/);
  f.repo('backend');
  const clean = await f.reader().state;
  assert.equal(clean.error, undefined);
  assert.equal(clean.files.length, 0);
  assert.deepEqual(clean.repositories, [{ path: 'backend', error: undefined }]);
});

test('discovers direct linked worktrees without following directory links or nested dependencies', async t => {
  const f = fixture(t);
  const repo = f.repo('backend');
  f.repo('node_modules/dependency');
  git(repo, 'worktree', 'add', '-b', 'linked', path.join(f.floor, 'linked'));
  writeFileSync(path.join(f.floor, 'linked', 'app.txt'), 'linked edit\n');
  symlinkSync(repo, path.join(f.floor, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const { state: first } = f.reader();
  const state = await first;
  assert.deepEqual(state.repositories?.map(r => r.path), ['backend', 'linked']);
  assert.deepEqual(state.files.map(f => f.path), ['linked/app.txt']);
});

test('combined view blocks commit, discard and PR actions while preserving both repositories', async t => {
  const f = fixture(t);
  const repos = [f.repo('backend'), f.repo('frontend')];
  for (const repo of repos) writeFileSync(path.join(repo, 'app.txt'), 'unfinished work\n');
  const before = repos.map(repo => git(repo, 'rev-parse', 'HEAD'));
  const { changes, state } = f.reader();
  await state;
  for (const result of [
    await changes.commit('pixel', 'Must not commit', 'Test'),
    await changes.discard('pixel', 'backend/app.txt', 'Test'),
    await changes.discard('pixel', undefined, 'Test'),
    await changes.pullRequest('pixel', 'Must not push', '', 'Test'),
  ]) assert.match(result ?? '', /view spans repositories/);
  repos.forEach((repo, i) => {
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before[i]);
    assert.equal(git(repo, 'diff', '--cached'), '');
    assert.equal(readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'unfinished work\n');
  });
});

test('normal single-repository commit and per-file discard still work', async t => {
  const f = fixture(t);
  const repo = f.repo('backend');
  writeFileSync(path.join(repo, 'app.txt'), 'single-repo edit\n');
  const { changes, state } = f.reader(repo);
  const first = await state;
  assert.equal(first.repositories, undefined);
  assert.deepEqual(first.files.map(f => f.path), ['app.txt']);
  assert.equal(await changes.discard('pixel', 'app.txt', 'Test'), undefined);
  assert.equal(readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'original\n');
  writeFileSync(path.join(repo, 'app.txt'), 'commit this\n');
  assert.equal(await changes.commit('pixel', 'Normal commit', 'Test'), undefined);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Normal commit');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
