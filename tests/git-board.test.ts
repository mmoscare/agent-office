import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitCommit, gitFileDiff, gitPush, gitRepositories, gitRepository, gitStage, gitUnstage } from '../src/server/git-board.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(dir: string) {
  git(dir, 'config', 'user.name', 'Git Board Test');
  git(dir, 'config', 'user.email', 'git-board-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/** A floor folder holding clones of a bare "GitHub" repository, which stands in for origin. */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office git board '));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(path.basename(resolved).startsWith('office git board '));
    rmSync(resolved, { recursive: true, force: true });
  });
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  const seed = path.join(root, 'seed');
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', origin, seed], { stdio: 'ignore' });
  configure(seed);
  writeFileSync(path.join(seed, 'app.txt'), 'one\ntwo\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initial');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const floor = path.join(root, 'floor');
  mkdirSync(floor);
  const clone = (name: string) => {
    const dir = path.join(floor, name);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', origin, dir]);
    configure(dir);
    return dir;
  };
  return { floor, origin, seed, clone };
}

test('a floor of checkouts lists each one; a floor that is a checkout lists just itself', async (t) => {
  const { floor, clone } = fixture(t);
  clone('alpha');
  const beta = clone('beta');
  writeFileSync(path.join(beta, 'new.txt'), 'hi\n');
  const list = await gitRepositories(floor);
  assert.equal(list.floorIsRepo, false);
  assert.deepEqual(list.repos.map((r) => [r.path, r.branch, r.upstream, r.dirty]), [['alpha', 'main', 'origin/main', 0], ['beta', 'main', 'origin/main', 1]]);
  const alone = await gitRepositories(path.join(floor, 'alpha'));
  assert.equal(alone.floorIsRepo, true);
  assert.deepEqual(alone.repos.map((r) => r.path), ['.']);
});

test('the checked-out branch is compared with GitHub, uncommitted edits and unpushed commits included', async (t) => {
  const { floor, seed, clone } = fixture(t);
  const dir = clone('app');
  // GitHub moves on by a commit this checkout hasn't got.
  writeFileSync(path.join(seed, 'remote.txt'), 'theirs\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Theirs');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'fetch', '-q');
  // Here: a commit not pushed, a staged file and an untracked one.
  writeFileSync(path.join(dir, 'app.txt'), 'one\nTWO\n');
  git(dir, 'commit', '-qam', 'Mine');
  writeFileSync(path.join(dir, 'staged.txt'), 'a\n');
  git(dir, 'add', 'staged.txt');
  writeFileSync(path.join(dir, 'loose.txt'), 'b\nc\n');

  const d = await gitRepository(floor, 'app');
  assert.equal(d.error, undefined);
  assert.equal(d.branch, 'main');
  assert.equal(d.current, 'main');
  assert.equal(d.defaultBranch, 'main');
  assert.deepEqual(d.compare, { ref: 'origin/main' });
  assert.equal(d.ahead, 1);
  assert.equal(d.behind, 1);
  assert.deepEqual(d.outgoing.map((c) => c.subject), ['Mine']);
  assert.deepEqual(d.incoming.map((c) => c.subject), ['Theirs']);
  assert.deepEqual(d.uncommitted.map((f) => [f.path, f.status, !!f.staged, !!f.unstaged]), [['loose.txt', '?', false, true], ['staged.txt', 'A', true, false]]);
  // Against GitHub: its remote.txt is missing here, app.txt differs, and the two new files.
  assert.deepEqual(d.githubFiles.map((f) => [f.path, f.status, !!f.uncommitted]), [['app.txt', 'M', false], ['loose.txt', '?', true], ['remote.txt', 'D', false], ['staged.txt', 'A', true]]);

  const diff = await gitFileDiff(floor, 'app', undefined, 'app.txt', 'github');
  assert.ok(typeof diff !== 'string' && diff.diff.includes('+TWO'));
  const untracked = await gitFileDiff(floor, 'app', undefined, 'loose.txt', 'uncommitted');
  assert.ok(typeof untracked !== 'string' && untracked.diff.includes('+c'));
  assert.equal(await gitFileDiff(floor, 'app', undefined, 'nope.txt', 'github'), 'That file has no changes');
});

test('another branch is compared with its own GitHub copy, or with the default branch before it is published', async (t) => {
  const { floor, clone } = fixture(t);
  const dir = clone('app');
  git(dir, 'switch', '-qc', 'feature');
  writeFileSync(path.join(dir, 'feature.txt'), 'f\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Feature');
  git(dir, 'switch', '-q', 'main');

  const d = await gitRepository(floor, 'app', 'feature');
  assert.equal(d.branch, 'feature');
  assert.equal(d.current, 'main');
  assert.equal(d.compare.unpublished, true);
  assert.equal(d.compare.ref, 'origin/main');
  assert.deepEqual(d.githubFiles.map((f) => f.path), ['feature.txt']);
  assert.deepEqual(d.uncommitted, []);
  assert.match((await gitRepository(floor, 'app', 'no-such')).error ?? '', /No branch called no-such/);
  assert.match((await gitRepository(floor, '../elsewhere')).error ?? '', /inside this floor/);
});

test('stage, unstage, commit and push the checked-out branch', async (t) => {
  const { floor, origin, clone } = fixture(t);
  const dir = clone('app');
  git(dir, 'switch', '-qc', 'work');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');

  assert.equal(await gitStage(floor, 'app', ['a.txt']), undefined);
  assert.deepEqual((await gitRepository(floor, 'app')).uncommitted.filter((f) => f.staged).map((f) => f.path), ['a.txt']);
  assert.match((await gitStage(floor, 'app', ['missing.txt'])) ?? '', /no uncommitted changes/);
  assert.equal(await gitUnstage(floor, 'app'), undefined);
  assert.deepEqual((await gitRepository(floor, 'app')).uncommitted.filter((f) => f.staged), []);
  assert.equal(await gitStage(floor, 'app'), undefined);
  assert.deepEqual((await gitRepository(floor, 'app')).uncommitted.filter((f) => f.staged).map((f) => f.path), ['a.txt', 'b.txt']);

  assert.equal(await gitCommit(floor, 'app', '   '), 'The commit needs a message');
  const committed = await gitCommit(floor, 'app', 'Add a and b');
  assert.ok(typeof committed !== 'string' && committed.stagedAll === false);
  // Nothing staged: everything is added first.
  writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  const smart = await gitCommit(floor, 'app', 'Add c');
  assert.ok(typeof smart !== 'string' && smart.stagedAll === true);
  assert.equal(await gitCommit(floor, 'app', 'Again'), 'Nothing to commit');

  const before = await gitRepository(floor, 'app');
  assert.equal(before.compare.unpublished, true);
  assert.deepEqual(await gitPush(floor, 'app'), { branch: 'work' });
  assert.equal(git(origin, 'log', '-1', '--format=%s', 'work'), 'Add c');
  const after = await gitRepository(floor, 'app');
  assert.deepEqual(after.compare, { ref: 'origin/work' });
  assert.equal(after.ahead, 0);
  assert.deepEqual(after.githubFiles, []);
});
