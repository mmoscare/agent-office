import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCleanup, scanCleanup, setCleanupPin, strayEdits } from '../src/server/cleanup.js';
import { prune } from '../src/server/prune.js';
import { Worktrees } from '../src/server/worktrees.js';
import { Workspaces } from '../src/server/workspaces.js';
import { branchNeedsWorktree, cleanupLocked, cleanupLosses, defaultChoice, type CleanupChoice, type CleanupItem, type CleanupScan } from '../src/shared/cleanup.js';

// Fixture repositories only: nothing here touches a real floor. Origin's URL is on GitHub (so PRs are
// looked up, through a fake gh) but pushes go to a local bare repository.

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string, origin: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'personal');
  git(dir, 'config', 'user.name', 'Cleanup Test');
  git(dir, 'config', 'user.email', 'cleanup-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'notes\n');
  writeFileSync(path.join(dir, '.gitignore'), '.agent-office/\nnode_modules/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial');
  execFileSync('git', ['init', '--bare', '-b', 'personal', origin], { stdio: 'ignore' });
  git(dir, 'remote', 'add', 'origin', `https://github.com/test/${path.basename(dir)}.git`);
  git(dir, 'config', 'remote.origin.pushurl', origin);
  git(dir, 'push', '-q', 'origin', 'personal');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/personal');
}

function commit(dir: string, file: string, text: string, msg: string) {
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
}

interface Pr {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  sha: string;
  repo?: string;
}

function fixture(t: { after(fn: () => void): void }, name = 'floor') {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-cleanup-')));
  t.after(() => rmSync(top, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(top, name);
  const origin = path.join(top, 'origin.git');
  initRepo(root, origin);
  const trees = new Worktrees(root);
  const hire = (slug: string) => {
    const wt = trees.create(slug);
    assert.notEqual(typeof wt, 'string', String(wt));
    const w = wt as { path: string; branch: string; base: string };
    return { ...w, abs: path.join(root, w.path) };
  };
  const prs: Pr[] = [];
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return prs.map((p) => JSON.stringify({ repo: `test/${name}`, url: `https://github.com/test/${name}/pull/${p.number}`, ...p })).join('\n');
  };
  const floors = [{ name: 'Test floor', dir: root }];
  const scan = (repo = '.') => scanCleanup({ floorDir: root, repo, floors, fresh: true, gh });
  const run = (choices: CleanupChoice[], dryRun = false, repo = '.') => runCleanup({ floorDir: root, repo, floors, choices, dryRun, gh });
  return { top, root, origin, hire, prs, calls, gh, floors, scan, run };
}

const item = (s: CleanupScan, id: string): CleanupItem => {
  const it = s.items.find((i) => i.id === id);
  assert.ok(it, `no row ${id} in ${s.items.map((i) => i.id).join(', ')}`);
  return it;
};

/** Git's own "a worktree removal that failed partway": the admin entry goes, the folder stays. */
function halfDelete(root: string, slug: string) {
  rmSync(path.join(root, '.git', 'worktrees', slug), { recursive: true, force: true });
  git(root, 'worktree', 'prune');
}

test('verdicts: safe, uncommitted, unpushed, and already in the default branch after a squash', async (t) => {
  const f = fixture(t);
  const clean = f.hire('clean-0001');
  const dirty = f.hire('dirty-0002');
  writeFileSync(path.join(dirty.abs, 'app.txt'), 'one\nTWO\nthree\n');
  const ahead = f.hire('ahead-0003');
  commit(ahead.abs, 'feature.txt', 'feature\n', 'Add a feature nobody pushed');
  // Pushed, worktree gone: nothing lost.
  git(f.root, 'branch', 'office/pushed-0004');
  git(f.root, 'push', '-q', 'origin', 'office/pushed-0004');
  // Its commit squash-merged into personal, its own copy never pushed.
  git(f.root, 'checkout', '-q', '-b', 'office/squashed-0005');
  commit(f.root, 'squash.txt', 'squashed\n', 'Squash me');
  git(f.root, 'checkout', '-q', 'personal');
  git(f.root, 'merge', '-q', '--squash', 'office/squashed-0005');
  git(f.root, 'commit', '-q', '-m', 'Squash merge');
  git(f.root, 'push', '-q', 'origin', 'personal');

  const s = await f.scan();
  assert.equal(s.current, 'personal');
  assert.equal(s.defaultBranch, 'personal');
  assert.equal(s.prs, 'ok');

  const c = item(s, clean.branch);
  assert.equal(c.verdict.kind, 'safe');
  assert.equal(c.worktree?.path, '.agent-office/worktrees/clean-0001');
  assert.equal(c.local, true);
  assert.equal(c.remote, false);
  assert.ok(c.date);
  assert.deepEqual(defaultChoice(c, s.prs), { id: c.id, worktree: true, branch: true, remote: false, force: false, token: c.token });
  assert.ok(branchNeedsWorktree(c));

  const d = item(s, dirty.branch);
  assert.equal(d.verdict.kind, 'work');
  assert.equal(d.verdict.text, '1 uncommitted change');
  assert.match(d.loses.worktree[0], /1 uncommitted change in \.agent-office\/worktrees\/dirty-0002: app\.txt/);
  assert.deepEqual(d.loses.branch, []);
  assert.equal(defaultChoice(d, s.prs).worktree, false);

  const a = item(s, ahead.branch);
  assert.equal(a.verdict.text, '1 unpushed commit');
  assert.match(a.loses.branch[0], /1 commit on office\/ahead-0003 that no remote has: \w+ Add a feature nobody pushed/);
  // Deleting only its (clean) folder keeps the commit on the branch: nothing lost.
  assert.deepEqual(cleanupLosses(a, { worktree: true }), []);
  assert.equal(cleanupLosses(a, { worktree: true, branch: true }).length, 1);

  const p = item(s, 'office/pushed-0004');
  assert.equal(p.verdict.kind, 'safe');
  assert.equal(p.remote, true);
  assert.equal(p.worktree, undefined);

  const q = item(s, 'office/squashed-0005');
  assert.equal(q.verdict.kind, 'safe');
  assert.match(q.verdict.text, /already in personal/);
});

test('protected: the checked-out, default, main and personal branches, pr-assets/*, open PRs, live workers and meetings', async (t) => {
  const f = fixture(t);
  git(f.root, 'branch', 'main');
  git(f.root, 'branch', 'pr-assets/echo-7060');
  git(f.root, 'push', '-q', 'origin', 'main', 'pr-assets/echo-7060');
  const open = f.hire('open-0001');
  commit(open.abs, 'x.txt', 'x\n', 'Work in review');
  git(open.abs, 'push', '-q', 'origin', open.branch);
  f.prs.push({ number: 7, state: 'open', merged: false, head: open.branch, sha: git(open.abs, 'rev-parse', 'HEAD') });
  // A PR from someone else's fork with the same branch name isn't this branch's.
  const other = f.hire('fork-0009');
  f.prs.push({ number: 8, state: 'open', merged: false, head: other.branch, sha: 'f'.repeat(40), repo: 'someone/fork' });
  const live = f.hire('gizmo-0002');
  // The worker switched its worktree to another branch: the folder is still Bolt's.
  const bolt = f.hire('bolt-0003');
  git(bolt.abs, 'checkout', '-q', '-b', 'office/bolt-0003-todo-wall');
  const meeting = f.hire('meeting-standup-0004');
  writeFileSync(path.join(f.root, '.agent-office', 'workers.json'), JSON.stringify([
    { name: 'Gizmo', deskId: 'desk-5', worktree: { path: live.path, branch: live.branch, base: live.base } },
    { name: 'Bolt', deskId: 'desk-6', worktree: { path: bolt.path, branch: bolt.branch, base: bolt.base } },
    { name: 'PR agent', deskId: 'station-pulls' },
    null,
  ]));
  writeFileSync(path.join(f.root, '.agent-office', 'meetings.json'), JSON.stringify({ current: { worktree: { path: meeting.path, branch: meeting.branch } }, past: [] }));

  const s = await f.scan();
  const why = (id: string) => {
    const it = item(s, id);
    assert.ok(cleanupLocked(it), `${id} should be kept: ${it.verdict.kind}`);
    assert.equal(defaultChoice(it, s.prs).branch, false);
    return it.verdict;
  };
  assert.deepEqual(why('personal'), { kind: 'protected', text: 'checked out in the main checkout' });
  assert.deepEqual(why('main'), { kind: 'protected', text: 'main is always kept' });
  assert.deepEqual(why('pr-assets/echo-7060'), { kind: 'protected', text: "hosts pull requests' screenshots" });
  assert.deepEqual(why(open.branch), { kind: 'protected', text: 'PR #7 is open' });
  assert.equal(item(s, open.branch).pr?.state, 'OPEN');
  assert.equal(item(s, open.branch).remoteDeletable, false);
  assert.equal(why(live.branch).kind, 'worker');
  assert.match(why(live.branch).text, /Gizmo's \(desk-5\): clock Gizmo out from the office instead/);
  assert.match(why('office/bolt-0003-todo-wall').text, /^Bolt's/);
  assert.match(why(bolt.branch).text, /^Bolt's/);
  assert.match(why(meeting.branch).text, /meeting room/);
  assert.equal(item(s, other.branch).pr, undefined);
  assert.equal(item(s, other.branch).verdict.kind, 'safe');

  // The server refuses them too, whatever the browser sends.
  const r = await f.run([{ id: live.branch, worktree: true, branch: true, force: true, token: item(s, live.branch).token }, { id: 'personal', branch: true, force: true, token: item(s, 'personal').token }]);
  assert.ok(typeof r !== 'string');
  assert.equal(r.steps.length, 0);
  assert.equal(r.refused.length, 2);
  assert.ok(existsSync(live.abs));
  assert.ok(git(f.root, 'branch', '--list', live.branch));
});

test('keep pins are saved per repository outside tracked files, start unticked, and are refused', async (t) => {
  const f = fixture(t);
  const wt = f.hire('keepme-0001');
  assert.equal(setCleanupPin(f.root, '.', wt.branch, true), undefined);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, '.agent-office', 'cleanup-keep.json'), 'utf8')), { '.': [wt.branch] });
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  const s = await f.scan();
  const it = item(s, wt.branch);
  assert.equal(it.pinned, true);
  assert.equal(it.verdict.kind, 'safe');
  assert.equal(defaultChoice(it, s.prs).worktree, false);
  const r = await f.run([{ id: it.id, worktree: true, branch: true, token: it.token }]);
  assert.ok(typeof r !== 'string');
  assert.match(r.refused[0].why, /Pinned/);
  assert.ok(existsSync(wt.abs));
  assert.equal(setCleanupPin(f.root, '.', wt.branch, false), undefined);
  assert.equal((await f.scan()).items.find((i) => i.id === wt.branch)?.pinned, false);
  assert.match(String(setCleanupPin(f.root, '../elsewhere', 'x', true)), /./);
});

test('stray folders: git no longer lists them; edits are read through a throwaway index', async (t) => {
  const f = fixture(t);
  // Deleted files only (" D"): what a half-finished removal leaves.
  const bare = f.hire('bare-0001');
  rmSync(path.join(bare.abs, 'app.txt'));
  rmSync(path.join(bare.abs, '.gitignore'));
  mkdirSync(path.join(bare.abs, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(bare.abs, 'node_modules', 'pkg', 'index.js'), 'dependency\n');
  halfDelete(f.root, 'bare-0001');
  // An edit git already has: notes.txt put back the way an older commit had it.
  const known = f.hire('known-0002');
  commit(f.root, 'notes.txt', 'notes, revised\n', 'Revise notes');
  writeFileSync(path.join(known.abs, 'notes.txt'), 'notes, revised\n');
  halfDelete(f.root, 'known-0002');
  // An edit that never shipped (like gizmo-ff91's turn_id fix), and an untracked screenshot.
  const lost = f.hire('lost-0003');
  writeFileSync(path.join(lost.abs, 'app.txt'), 'one\nprompt_id\nthree\n');
  mkdirSync(path.join(lost.abs, 'tmp'));
  writeFileSync(path.join(lost.abs, 'tmp', 'shot.png'), 'not a real png\n');
  halfDelete(f.root, 'lost-0003');
  // Its branch already deleted: every file is compared with what git has anywhere.
  const orphan = f.hire('orphan-0004');
  halfDelete(f.root, 'orphan-0004');
  git(f.root, 'branch', '-D', orphan.branch);

  const index = createHash('sha1').update(readFileSync(path.join(f.root, '.git', 'index'))).digest('hex');
  const listed = await new Worktrees(f.root).list();
  assert.deepEqual(listed.strays.map((s) => path.basename(s)).sort(), ['bare-0001', 'known-0002', 'lost-0003', 'orphan-0004']);

  assert.deepEqual(await strayEdits(f.root, bare.abs, bare.branch), { edited: [], unknown: [] });
  assert.deepEqual(await strayEdits(f.root, known.abs, known.branch), { edited: ['notes.txt'], unknown: [] });
  assert.deepEqual((await strayEdits(f.root, lost.abs, lost.branch)).unknown.sort(), ['app.txt', 'tmp/shot.png']);

  const s = await f.scan();
  const b = item(s, bare.branch);
  assert.equal(b.worktree?.stray, true);
  assert.equal(b.verdict.kind, 'safe');
  assert.match(b.verdict.text, /half-deleted folder, nothing edited/);
  assert.equal(branchNeedsWorktree(b), false);
  assert.match(item(s, known.branch).verdict.text, /its 1 edited file is already in git/);
  const l = item(s, lost.branch);
  assert.equal(l.verdict.kind, 'work');
  assert.equal(l.verdict.text, '2 uncommitted changes');
  assert.match(l.loses.worktree[0], /2 edited files in \.agent-office\/worktrees\/lost-0003 that git doesn't have: app\.txt, tmp\/shot\.png/);
  const o = item(s, '.agent-office/worktrees/orphan-0004');
  assert.equal(o.branch, undefined);
  assert.equal(o.worktree?.stray, true);
  assert.equal(o.verdict.kind, 'safe');

  // Reading them left the real index alone.
  assert.equal(createHash('sha1').update(readFileSync(path.join(f.root, '.git', 'index'))).digest('hex'), index);
  assert.equal(git(f.root, 'status', '--porcelain'), '');

  // Deleting: the safe ones go (folder and branch); the one holding work only with "delete anyway".
  const choose = (it: CleanupItem, force = false): CleanupChoice => ({ id: it.id, worktree: true, branch: it.local, force, token: it.token });
  const dry = await f.run([choose(b), choose(o), choose(l)], true);
  assert.ok(typeof dry !== 'string');
  assert.deepEqual(dry.steps.map((x) => x.label), ['Delete the half-deleted folder .agent-office/worktrees/bare-0001', 'Delete the local branch office/bare-0001', 'Delete the half-deleted folder .agent-office/worktrees/orphan-0004']);
  assert.match(dry.refused[0].why, /holds work .*delete anyway/);
  assert.ok(existsSync(bare.abs), 'a dry run deletes nothing');

  const done = await f.run([choose(b), choose(o), choose(l, true)]);
  assert.ok(typeof done !== 'string');
  assert.deepEqual(done.refused, []);
  assert.ok(done.steps.every((x) => x.ok), JSON.stringify(done.steps));
  assert.match(done.steps.find((x) => x.id === l.id)!.label, /losing 2 edited files/);
  for (const wt of [bare, orphan, lost]) assert.equal(existsSync(wt.abs), false, wt.abs);
  assert.equal(git(f.root, 'branch', '--list', 'office/bare-0001'), '');
  assert.ok(existsSync(known.abs));
});

test('deleting: worktree and branch separately, refused when it changed, origin only after its PR merged', async (t) => {
  const f = fixture(t);
  const done = f.hire('done-0001');
  commit(done.abs, 'done.txt', 'done\n', 'Finished work');
  git(done.abs, 'push', '-q', 'origin', done.branch);
  f.prs.push({ number: 3, state: 'closed', merged: true, head: done.branch, sha: git(done.abs, 'rev-parse', 'HEAD') });
  const nopr = f.hire('nopr-0002');
  git(nopr.abs, 'push', '-q', 'origin', nopr.branch);
  const moving = f.hire('moving-0003');

  let s = await f.scan();
  const d = item(s, done.branch);
  assert.equal(d.pr?.state, 'MERGED');
  assert.equal(d.remoteDeletable, true);
  assert.deepEqual(d.loses.remote, []);
  assert.equal(defaultChoice(d, s.prs).remote, false);
  const n = item(s, nopr.branch);
  assert.equal(n.remoteDeletable, false);
  assert.equal(n.remoteWhy, 'it has no pull request');
  const m = item(s, moving.branch);

  // It moved after it was shown.
  commit(moving.abs, 'late.txt', 'late\n', 'Late work');
  const r1 = await f.run([{ id: m.id, worktree: true, branch: true, token: m.token }, { id: n.id, remote: true, token: n.token }, { id: d.id, branch: true, token: d.token }]);
  assert.ok(typeof r1 !== 'string');
  assert.deepEqual(r1.refused.map((x) => x.why), ['It changed since you looked: refresh and check it again', "Origin's copy can't be deleted from here: it has no pull request", 'Delete its worktree too: git keeps a branch that a worktree has checked out']);
  assert.ok(existsSync(moving.abs));

  // Just the folder, keeping the branch; then the branch and origin's copy.
  const r2 = await f.run([{ id: d.id, worktree: true, token: d.token }]);
  assert.ok(typeof r2 !== 'string' && r2.steps.every((x) => x.ok), JSON.stringify(r2));
  assert.equal(existsSync(done.abs), false);
  assert.ok(git(f.root, 'branch', '--list', done.branch));
  s = await f.scan();
  const d2 = item(s, done.branch);
  assert.equal(d2.worktree, undefined);
  const r3 = await f.run([{ id: d2.id, branch: true, remote: true, token: d2.token }]);
  assert.ok(typeof r3 !== 'string' && r3.steps.every((x) => x.ok), JSON.stringify(r3));
  assert.deepEqual(r3.steps.map((x) => x.what), ['branch', 'remote']);
  assert.equal(git(f.root, 'branch', '--list', done.branch), '');
  assert.equal(git(f.origin, 'branch', '--list', done.branch), '');
  assert.equal(git(f.root, 'branch', '-r', '--list', `origin/${done.branch}`), '');
  // The PR list was asked for over REST, never through upstream or GraphQL.
  assert.ok(f.calls.every((c) => c[0] === 'api' && c.includes('repos/test/floor/pulls')));
});

test('worktrees outside .agent-office/worktrees and ones whose folder is gone; links are never followed', async (t) => {
  const f = fixture(t);
  // A scratch "baseline" worktree in the temp folder, detached, with node_modules linked in from elsewhere.
  const outside = path.join(f.top, 'scratch', 'baseline');
  git(f.root, 'worktree', 'add', '-q', '--detach', outside, 'HEAD');
  const target = path.join(f.top, 'shared-node_modules');
  mkdirSync(target);
  writeFileSync(path.join(target, 'keep.js'), 'keep\n');
  symlinkSync(target, path.join(outside, 'node_modules'), 'junction');
  // Not ignored: git lists it as untracked, yet it's only a link, so nothing is lost.
  symlinkSync(target, path.join(outside, 'linked'), 'dir');
  // Registered, but its folder was deleted by hand.
  const gone = f.hire('gone-0001');
  rmSync(gone.abs, { recursive: true, force: true });

  const s = await f.scan();
  const b = item(s, outside);
  assert.equal(b.worktree?.external, true);
  assert.equal(b.worktree?.detached, true);
  assert.equal(b.verdict.kind, 'safe', b.verdict.text);
  assert.deepEqual(b.loses, { worktree: [], branch: [], remote: [] });
  const g = item(s, gone.branch);
  assert.equal(g.worktree?.exists, false);
  assert.match(g.verdict.text, /already gone/);

  const r = await f.run([{ id: b.id, worktree: true, token: b.token }, { id: g.id, worktree: true, branch: true, token: g.token }]);
  assert.ok(typeof r !== 'string' && r.steps.every((x) => x.ok), JSON.stringify(r));
  assert.equal(existsSync(outside), false);
  assert.ok(existsSync(path.join(target, 'keep.js')), 'the linked folder survives');
  assert.equal(git(f.root, 'worktree', 'list', '--porcelain').includes('gone-0001'), false);
  assert.equal(git(f.root, 'branch', '--list', gone.branch), '');
});

test('multi-repository desks: their worktrees in every repository belong to the desk; the manifest stays', async (t) => {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-cleanup-desk-')));
  t.after(() => rmSync(top, { recursive: true, force: true, maxRetries: 3 }));
  const floor = path.join(top, 'portfolio');
  initRepo(path.join(floor, 'site'), path.join(top, 'site.git'));
  initRepo(path.join(floor, 'api'), path.join(top, 'api.git'));
  mkdirSync(path.join(floor, '.agent-office'), { recursive: true });
  const ws = new Workspaces(floor);
  const live = ws.create('nibble-0001', { repositories: ['site', 'api'] });
  const gone = ws.create('widget-0002', { repositories: ['site', 'api'] });
  assert.notEqual(typeof live, 'string', String(live));
  assert.notEqual(typeof gone, 'string', String(gone));
  const liveDesk = live as Exclude<typeof live, string>;
  writeFileSync(path.join(floor, '.agent-office', 'workers.json'), JSON.stringify([{ name: 'Nibble', deskId: 'desk-8', workspace: liveDesk }]));
  const floors = [{ name: 'Portfolio', dir: floor }];
  const gh = async () => '';
  for (const repo of ['site', 'api']) {
    const s = await scanCleanup({ floorDir: floor, repo, floors, gh });
    const l = item(s, 'office/nibble-0001');
    assert.equal(l.verdict.kind, 'worker');
    assert.match(l.verdict.text, /Nibble's \(desk-8\)/);
    const g = item(s, 'office/widget-0002');
    assert.equal(g.verdict.kind, 'safe');
    assert.deepEqual(g.worktree?.desk, { name: 'widget-0002', repositories: ['site', 'api'] });
    assert.equal(g.worktree?.external, undefined);
    assert.equal(g.worktree?.path, `.agent-office/workspaces/widget-0002/${repo}`);
    const r = await runCleanup({ floorDir: floor, repo, floors, gh, dryRun: false, choices: [{ id: g.id, worktree: true, branch: true, token: g.token }] });
    assert.ok(typeof r !== 'string' && r.steps.every((x) => x.ok), JSON.stringify(r));
  }
  // The desk's manifest and instructions are kept, as Workspaces.remove() keeps them.
  for (const file of ['workspace.json', 'AGENTS.md']) assert.ok(existsSync(path.join(floor, '.agent-office', 'workspaces', 'widget-0002', file)), file);
  assert.equal(existsSync(path.join(floor, '.agent-office', 'workspaces', 'widget-0002', 'site')), false);
  assert.ok(existsSync(path.join(floor, '.agent-office', 'workspaces', 'nibble-0001', 'site')));
});

test('GitHub unreachable: nothing starts ticked and origin is never offered', async (t) => {
  const f = fixture(t);
  const wt = f.hire('quiet-0001');
  git(wt.abs, 'push', '-q', 'origin', wt.branch);
  const s = await scanCleanup({ floorDir: f.root, repo: '.', floors: f.floors, fresh: true, gh: async () => { throw new Error('API rate limit exceeded'); } });
  assert.equal(s.prs, 'unknown');
  assert.equal(s.prError, 'API rate limit exceeded');
  const it = item(s, wt.branch);
  assert.equal(it.verdict.kind, 'safe');
  assert.equal(defaultChoice(it, s.prs).worktree, false);
  assert.equal(it.remoteDeletable, false);
});

test('agent-office prune still keeps live workers and work, from the same saved workers', async (t) => {
  const f = fixture(t);
  const live = f.hire('live-0001');
  f.hire('left-0002');
  const held = f.hire('held-0003');
  writeFileSync(path.join(held.abs, 'app.txt'), 'changed\n');
  writeFileSync(path.join(f.root, '.agent-office', 'workers.json'), JSON.stringify([{ name: 'Live', worktree: { path: live.path, branch: live.branch } }]));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await prune([f.root, '--dry-run']), 0);
  } finally {
    console.log = log;
  }
  const out = lines.join('\n');
  assert.match(out, /kept\s+office\/live-0001\s+Live's/);
  assert.match(out, /would remove\s+office\/left-0002/);
  assert.match(out, /kept\s+office\/held-0003\s+1 uncommitted change/);
  assert.ok(existsSync(path.join(f.root, '.agent-office', 'worktrees', 'left-0002')));
});
