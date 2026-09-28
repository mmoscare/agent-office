import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { previewPush, pushReviewed, pushTargets } from '../src/server/push.js';
import { pushAdvice } from '../src/shared/push.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-push-'));
  t.after(() => { const dir = realpathSync(root); assert.equal(path.dirname(dir), realpathSync(tmpdir())); assert.ok(path.basename(dir).startsWith('office-push-')); rmSync(dir, { recursive: true, force: true }); });
  const remote = path.join(root, 'origin.git'); mkdirSync(remote); git(remote, 'init', '--bare', '-b', 'main');
  const floor = path.join(root, 'floor'); mkdirSync(floor);
  const clone = (name: string) => {
    const dir = path.join(floor, name); git(root, 'clone', remote, dir);
    git(dir, 'config', 'user.name', 'Push Test'); git(dir, 'config', 'user.email', 'push@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    return dir;
  };
  const repo = clone('app');
  git(repo, 'commit', '--allow-empty', '-m', 'Initial'); git(repo, 'push', '-u', 'origin', 'main');
  return { root, remote, floor, repo, clone };
}
test('general Push uploads reviewed commits on any branch and leaves dirty edits alone', async t => {
  const { floor, repo, remote } = fixture(t);
  git(repo, 'switch', '-c', 'release'); git(repo, 'commit', '--allow-empty', '-m', 'Ready feature');
  writeFileSync(path.join(repo, 'unfinished.txt'), 'Keep this local');
  const reviewed = await previewPush(floor, 'floor:app', '');
  assert.equal(reviewed.target.branch, 'release'); assert.equal(reviewed.target.dirty, 1);
  assert.equal(pushAdvice(reviewed.target).ready, true); assert.ok(reviewed.token);
  const result = await pushReviewed(floor, 'floor:app', reviewed.token!, '');
  assert.notEqual(typeof result, 'string');
  assert.equal(git(remote, 'rev-parse', 'release'), git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'release@{upstream}'), 'origin/release');
  assert.equal(git(repo, 'status', '--porcelain'), '?? unfinished.txt');
  assert.equal(git(remote, 'ls-tree', '--name-only', 'release'), '');
  const after = await previewPush(floor, 'floor:app', '');
  assert.equal(after.target.ahead, 0); assert.equal(after.token, undefined);
  assert.match(pushAdvice(after.target).detail, /not committed/);
});
test('recommendations compare origin/current branch even when another upstream is configured', async t => {
  const { floor, repo } = fixture(t);
  git(repo, 'remote', 'add', 'upstream', path.join(repo, '..', '..', 'origin.git'));
  git(repo, 'fetch', 'upstream'); git(repo, 'branch', '--set-upstream-to=upstream/main');
  git(repo, 'commit', '--allow-empty', '-m', 'Local');
  const s = await previewPush(floor, 'floor:app', '');
  assert.equal(s.target.ahead, 1); assert.equal(s.target.behind, 0);
  assert.match(s.target.destination!, /main$/); assert.ok(s.token);
});
test('new local commits and a switched branch invalidate the review', async t => {
  const { floor, repo, remote } = fixture(t);
  git(repo, 'commit', '--allow-empty', '-m', 'Reviewed');
  const reviewed = await previewPush(floor, 'floor:app', '');
  const old = git(remote, 'rev-parse', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'Not reviewed');
  assert.match(String(await pushReviewed(floor, 'floor:app', reviewed.token!, '')), /changed since your review/);
  assert.equal(git(remote, 'rev-parse', 'main'), old);
  const again = await previewPush(floor, 'floor:app', '');
  git(repo, 'switch', '-c', 'another');
  assert.match(String(await pushReviewed(floor, 'floor:app', again.token!, '')), /changed since your review/);
  assert.equal(git(remote, 'rev-parse', 'main'), old);
});
test('incoming/diverged histories and remote changes cannot be pushed through an old review', async t => {
  const { floor, repo, remote, clone } = fixture(t);
  const other = clone('other'); git(repo, 'commit', '--allow-empty', '-m', 'Local');
  const reviewed = await previewPush(floor, 'floor:app', '');
  git(other, 'commit', '--allow-empty', '-m', 'Remote'); git(other, 'push');
  const head = git(remote, 'rev-parse', 'main');
  assert.match(String(await pushReviewed(floor, 'floor:app', reviewed.token!, '')), /changed since your review/);
  const diverged = await previewPush(floor, 'floor:app', '');
  assert.equal(diverged.target.behind, 1); assert.equal(diverged.target.ahead, 1); assert.equal(diverged.token, undefined);
  assert.match(pushAdvice(diverged.target).title, /Resolve/);
  assert.equal(git(remote, 'rev-parse', 'main'), head);
});
test('multi-repository selection and separate app checkout have explicit targets; paths and tokens are scoped', async t => {
  const { root, floor, repo, clone } = fixture(t); const other = clone('other');
  git(repo, 'commit', '--allow-empty', '-m', 'To upload');
  const list = await pushTargets(other, repo);
  assert.deepEqual(list.targets.map(s => s.id), ['floor:.', 'office']);
  assert.equal(list.targets[1].name, 'Agent Office app');
  assert.equal((await pushTargets(repo, repo)).targets.length, 1);
  const preview = await previewPush(other, 'office', repo);
  assert.equal(typeof await pushReviewed(floor, 'office', preview.token!, repo), 'string');
  assert.notEqual(typeof await pushReviewed(other, 'office', preview.token!, repo), 'string');
  await assert.rejects(previewPush(floor, 'floor:../../', ''), /repository|Choose/i);
  await assert.rejects(previewPush(floor, `floor:${root}`, ''), /repository|Choose/i);
});
test('empty, detached, missing origin and separate push URLs give clear advice without leaking credentials', async t => {
  const { floor, repo, root } = fixture(t);
  git(repo, 'checkout', '--detach');
  assert.match(pushAdvice((await previewPush(floor, 'floor:app', '')).target).title, /Choose a branch/);
  git(repo, 'switch', 'main'); git(repo, 'remote', 'remove', 'origin');
  assert.match(pushAdvice((await previewPush(floor, 'floor:app', '')).target).title, /No destination/);
  git(repo, 'remote', 'add', 'origin', 'https://user:secret@example.invalid/repo.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', 'https://user:secret@example.invalid/other.git');
  const s = await previewPush(floor, 'floor:app', '');
  assert.ok(s.target.error); assert.equal(s.token, undefined); assert.ok(!JSON.stringify(s).includes('secret'));
  const empty = path.join(root, 'empty'); mkdirSync(empty); git(empty, 'init', '-b', 'main');
  assert.match(pushAdvice((await previewPush(empty, 'floor:.', '')).target).title, /Commit first/);
});
test('a changed origin cannot redirect a previously reviewed push', async t => {
  const { floor, repo, root } = fixture(t); git(repo, 'commit', '--allow-empty', '-m', 'Ready');
  const reviewed = await previewPush(floor, 'floor:app', '');
  const alternate = path.join(root, 'alternate.git'); git(root, 'clone', '--bare', path.join(root, 'origin.git'), alternate);
  git(repo, 'remote', 'set-url', 'origin', alternate);
  assert.match(String(await pushReviewed(floor, 'floor:app', reviewed.token!, '')), /changed since your review/);
  assert.notEqual(git(alternate, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'));
});
