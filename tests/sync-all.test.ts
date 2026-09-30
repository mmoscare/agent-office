import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { blockedReason, changeAreas, newsLines, newsText, planNextSteps, riskyName, riskyText, suggestMessage, type SyncChoice, type SyncPlan, type SyncResult } from '../src/shared/sync-all.js';
import { routeSyncAll, syncPlan, syncRun } from '../src/server/sync-all.js';
import type { OfficeFloor } from '../src/server/git-board.js';

// 🔄 Sync everything against throwaway repositories: two bare "GitHub" repositories (the office's
// code and a floor's project), the app folder (a clone of the first) and the floor (a clone of the
// second). Every push lands in a local bare repository: nothing here reaches GitHub, and the real
// app folder is never touched. The repositories are made once and copied for each test (their
// remotes are relative paths, so each copy pushes to its own "GitHub"): git is slow to start on a
// busy Windows machine.

const PREFIX = 'sync all test ';

// The same git settings for every git this file starts, the office's own included, whatever this
// machine's global config says: a known identity, no hooks, no global ignores, no line-ending changes.
const SETTINGS: [string, string][] = [
  ['user.name', 'Sync All Test'],
  ['user.email', 'sync-all-test@example.invalid'],
  ['core.autocrlf', 'false'],
  ['commit.gpgsign', 'false'],
  ['core.hooksPath', path.join(tmpdir(), 'sync-all-test-no-hooks')],
  ['core.excludesFile', path.join(tmpdir(), 'sync-all-test-no-excludes')],
  ['init.defaultBranch', 'personal'],
  ['pull.rebase', 'false'],
];
process.env.GIT_CONFIG_COUNT = String(SETTINGS.length);
SETTINGS.forEach(([k, v], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = k;
  process.env[`GIT_CONFIG_VALUE_${i}`] = v;
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

interface Fixture {
  root: string;
  /** The office's code on "GitHub", and a checkout that stands in for others pushing there. */
  officeOrigin: string;
  officeSeed: string;
  /** The floor's project on "GitHub", and a checkout for others' pushes. */
  floorOrigin: string;
  floorSeed: string;
  app: string;
  floor: string;
}

function tempRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), PREFIX)));
}

function remove(root: string) {
  assert.ok(path.basename(root).startsWith(PREFIX));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** A bare "GitHub" repository with one commit, and a checkout of it (`<name>-seed`) that pushes there. */
function repo(root: string, name: string, files: Record<string, string>) {
  const seed = path.join(root, `${name}-seed`);
  mkdirSync(seed);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    writeFileSync(path.join(seed, f), text);
  }
  git(seed, 'init', '-q');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initial');
  git(root, 'clone', '-q', '--bare', `${name}-seed`, `${name}.git`);
  // Relative: a copy of the whole folder pushes to its own copy of "GitHub".
  git(seed, 'remote', 'add', 'origin', `../${name}.git`);
  git(seed, 'fetch', '-q', 'origin');
  git(seed, 'branch', '-q', '-u', 'origin/personal');
}

function clone(root: string, from: string, name: string) {
  git(root, 'clone', '-q', '-b', 'personal', from, name);
  git(path.join(root, name), 'remote', 'set-url', 'origin', `../${from}`);
}

let template: string;

before(() => {
  template = tempRoot();
  repo(template, 'office', {
    'package.json': `${JSON.stringify({ name: 'agent-office', version: '0.1.0' }, null, 2)}\n`,
    'package-lock.json': '{}\n',
    '.gitignore': 'node_modules\ndist\n.agent-office\n',
    'src/server/server.ts': 'export const a = 1;\n',
    'src/client/main.ts': 'export const b = 1;\n',
    'README.md': '# Office\n',
  });
  // The floor's project doesn't ignore the office's folders: the sync must keep them out itself.
  repo(template, 'project', { 'app.txt': 'one\ntwo\n', 'notes.md': '# Notes\n' });
  clone(template, 'office.git', 'app');
  clone(template, 'project.git', 'floor');
});

after(() => {
  if (template) remove(template);
});

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = tempRoot();
  t.after(() => remove(root));
  cpSync(template, root, { recursive: true });
  const at = (p: string) => path.join(root, p);
  return { root, officeOrigin: at('office.git'), officeSeed: at('office-seed'), floorOrigin: at('project.git'), floorSeed: at('project-seed'), app: at('app'), floor: at('floor') };
}


/** Someone else's change on "GitHub". */
function pushFrom(seed: string, files: Record<string, string>, subject: string, pr?: number) {
  git(seed, 'pull', '-q', '--ff-only');
  if (pr) git(seed, 'checkout', '-q', '-b', `pr-${pr}`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    writeFileSync(path.join(seed, f), text);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', subject);
  if (pr) {
    git(seed, 'checkout', '-q', 'personal');
    git(seed, 'merge', '-q', '--no-ff', `pr-${pr}`, '-m', `Merge pull request #${pr} from mmoscare/pr-${pr}`, '-m', subject);
  }
  git(seed, 'push', '-q', 'origin', 'personal');
}

/** What Go sends by default: every file that isn't risky or blocked, with the suggested message. */
function defaults(plan: SyncPlan): SyncChoice[] {
  return plan.repos.map((r) => ({ id: r.id, files: r.files.filter((f) => !f.risky && !f.blocked).map((f) => f.path), message: r.suggested }));
}

function worker(id: string, name: string, status: WorkerStatus): WorkerInfo {
  return { id, name, status, kind: 'claude' } as unknown as WorkerInfo;
}

async function run(fx: Fixture, choose: (plan: SyncPlan) => SyncChoice[] = defaults, floors: OfficeFloor[] = []): Promise<{ plan: SyncPlan; result: SyncResult }> {
  const plan = await syncPlan(fx.floor, true, { app: fx.app });
  const result = await syncRun(fx.floor, plan.token, choose(plan), floors, { restartable: true });
  assert.notEqual(typeof result, 'string', String(result));
  return { plan, result: result as SyncResult };
}

const byKind = (r: SyncResult, kind: 'floor' | 'office') => r.repos.find((x) => x.kind === kind)!;

test('dirty work is committed, GitHub’s changes pulled in, and everything uploaded', async (t) => {
  const fx = fixture(t);
  writeFileSync(path.join(fx.floor, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(fx.floor, 'todo.md'), '- [ ] ship it\n');
  pushFrom(fx.floorSeed, { 'notes.md': '# Notes\n\nFrom GitHub.\n' }, 'Notes from a teammate', 12);

  const plan = await syncPlan(fx.floor, true, { app: fx.app });
  const floorRepo = plan.repos.find((r) => r.kind === 'floor')!;
  assert.equal(floorRepo.branch, 'personal');
  assert.equal(floorRepo.upstream, 'origin/personal');
  assert.deepEqual(floorRepo.files.map((f) => [f.path, f.status]), [['app.txt', 'M'], ['todo.md', '?']]);
  assert.equal(floorRepo.suggested, 'Update app.txt and todo.md');
  assert.equal(plan.repos.find((r) => r.kind === 'office')?.name, 'Agent Office app');

  const choices = defaults(plan).map((c) => (c.id === floorRepo.id ? { ...c, message: 'Save my notes' } : c));
  const result = await syncRun(fx.floor, plan.token, choices, [], { restartable: true });
  assert.notEqual(typeof result, 'string');
  const floor = byKind(result as SyncResult, 'floor');
  assert.equal(floor.state, 'done', floor.message);
  assert.equal(floor.saved, 2);
  assert.equal(floor.pulled, 1);
  assert.equal(floor.pushed, 2, 'the saved commit and the merge');
  assert.match(floor.message, /^Saved 2 files \([0-9a-f]+\), uploaded 2 commits, pulled 1 new change\.$/);
  assert.deepEqual(floor.prs.map((p) => [p.number, p.title]), [[12, 'Notes from a teammate']]);
  assert.deepEqual(floor.news, [{ pr: 12, text: 'Notes from a teammate' }]);
  // Where it is on the floor, to find the clipboard's plain words for it (key pr:12 on a one-repository floor).
  assert.equal(floor.floorPath, '.');
  // GitHub (the bare repository) has it all; the folder is clean and level with it.
  assert.equal(git(fx.floor, 'rev-parse', 'HEAD'), git(fx.floorOrigin, 'rev-parse', 'personal'));
  assert.equal(git(fx.floor, 'status', '--porcelain'), '');
  assert.match(git(fx.floor, 'log', '--format=%s', '-n3'), /Save my notes/);
  assert.equal(git(fx.floorOrigin, 'show', 'personal:todo.md'), '- [ ] ship it');
  assert.equal(readFileSync(path.join(fx.floor, 'notes.md'), 'utf8'), '# Notes\n\nFrom GitHub.\n');
  // The app folder had nothing: nothing to do there.
  const app = byKind(result as SyncResult, 'office');
  assert.equal(app.state, 'done');
  assert.equal(app.message, 'Nothing to save, nothing to upload, already had the latest.');
  assert.equal((result as SyncResult).next.changed, false);

  // The review is used up: a second Go with the same token is refused.
  assert.match(String(await syncRun(fx.floor, plan.token, choices, [])), /out of date/);
});

test('nothing to commit: straight to pulling, nothing uploaded', async (t) => {
  const fx = fixture(t);
  pushFrom(fx.floorSeed, { 'app.txt': 'one\ntwo\nfrom GitHub\n' }, 'A change on GitHub');
  const before = git(fx.floorOrigin, 'rev-parse', 'personal');
  const { plan, result } = await run(fx);
  assert.ok(plan.repos.every((r) => r.files.length === 0 && !r.problem));
  const floor = byKind(result, 'floor');
  assert.equal(floor.state, 'done');
  assert.deepEqual([floor.saved, floor.pulled, floor.pushed], [0, 1, 0]);
  assert.equal(floor.message, 'Nothing to save, nothing to upload, pulled 1 new change.');
  assert.equal(floor.otherCommits, 1);
  assert.equal(git(fx.floor, 'rev-parse', 'HEAD'), before);
  assert.equal(git(fx.floorOrigin, 'rev-parse', 'personal'), before);
});

test('secret-looking and personal files are left unticked; the office’s own folders are never committed', async (t) => {
  const fx = fixture(t);
  const f = (p: string, text: string | Buffer) => {
    mkdirSync(path.dirname(path.join(fx.floor, p)), { recursive: true });
    writeFileSync(path.join(fx.floor, p), text);
  };
  f('.env', 'API_KEY=hunter2\n');
  f('.env.local', 'X=1\n');
  f('keys/server.pem', 'not really a key\n');
  f('pw.txt', 'hunter2\n');
  f('secrets.json', '{}\n');
  // A token-shaped string, built here so this test file itself doesn't look like it holds one.
  f('config.json', `{ "token": "${'gh' + 'p_'}${'a1B2'.repeat(10)}" }\n`);
  f('big.bin', Buffer.alloc(5 * 1024 * 1024 + 1, 1));
  f('.agent-office/state.json', '{"owner":"private"}\n');
  f('.agent-office/worktrees/w1/file.txt', 'x\n');
  f('node_modules/pkg/index.js', 'module.exports = 1;\n');
  f('node_modules/pkg/package.json', '{}\n');
  f('dist/out.js', 'built\n');
  f('src/tokens.ts', 'export const tokens = [];\n');
  f('a[1].txt', 'a literal bracket name\n');
  f('a1.txt', 'must not ride along with a[1].txt\n');
  // An already-tracked file gets a secret added to it.
  f('app.txt', `one\ntwo\n-----BEGIN ${'PRIVATE'} KEY-----\n`);

  const plan = await syncPlan(fx.floor, true, { app: fx.app });
  const r = plan.repos.find((x) => x.kind === 'floor')!;
  const risky = Object.fromEntries(r.files.filter((x) => x.risky).map((x) => [x.path, x.risky]));
  assert.deepEqual(Object.keys(risky).sort(), ['.env', '.env.local', 'app.txt', 'big.bin', 'config.json', 'keys/server.pem', 'pw.txt', 'secrets.json']);
  assert.match(risky['config.json']!, /GitHub token/);
  assert.match(risky['app.txt']!, /private key/);
  assert.match(risky['big.bin']!, /big file \(5\.0 MB\)/);
  const blocked = r.files.filter((x) => x.blocked).map((x) => x.path).sort();
  assert.deepEqual(blocked, ['.agent-office/ (2 files)', 'dist/', 'node_modules/ (2 files)']);
  // Code named for tokens is fine; the suggestion only counts what's ticked.
  assert.ok(r.files.some((x) => x.path === 'src/tokens.ts' && !x.risky));
  assert.equal(r.suggested, 'Update a1.txt, a[1].txt and tokens.ts'.replace('Update', 'Add'));

  // Go with the defaults, plus a try at sneaking in a blocked file and one the review never saw.
  f('late.txt', 'made after the review\n');
  const choices = defaults(plan).map((c) => (c.id === r.id ? { ...c, files: [...c.files.filter((p) => p !== 'a1.txt'), '.agent-office/state.json', 'late.txt'] } : c));
  const result = (await syncRun(fx.floor, plan.token, choices, [], { restartable: true })) as SyncResult;
  const floor = byKind(result, 'floor');
  assert.equal(floor.state, 'done', floor.message);
  assert.equal(floor.saved, 2);
  const uploaded = git(fx.floorOrigin, 'ls-tree', '-r', '--name-only', 'personal').split('\n').sort();
  assert.deepEqual(uploaded, ['a[1].txt', 'app.txt', 'notes.md', 'src/tokens.ts']);
  assert.equal(git(fx.floorOrigin, 'show', 'personal:app.txt'), 'one\ntwo', 'the secret added to app.txt stayed unsaved');
  // Everything left out is still here, untouched.
  for (const p of ['.env', 'pw.txt', 'a1.txt', 'late.txt', '.agent-office/state.json', 'node_modules/pkg/index.js']) assert.ok(existsSync(path.join(fx.floor, p)), p);
  assert.match(readFileSync(path.join(fx.floor, 'app.txt'), 'utf8'), /PRIVATE KEY/);
});

/** Go with every file ticked, risky or not: a refusal must hold even then. */
const everything = (p: SyncPlan) => p.repos.map((r) => ({ id: r.id, files: r.files.map((f) => f.path), message: 'x' }));

test('a detached HEAD is refused, and left exactly as it was', async (t) => {
  const fx = fixture(t);
  writeFileSync(path.join(fx.floor, 'app.txt'), 'changed\n');
  git(fx.floor, 'checkout', '-q', '--detach');
  const head = git(fx.floor, 'rev-parse', 'HEAD');
  const { plan, result } = await run(fx, everything);
  const r = plan.repos.find((x) => x.kind === 'floor')!;
  assert.match(r.problem!, /isn’t on a branch \(its HEAD is detached\)/);
  assert.equal(byKind(result, 'floor').state, 'skipped');
  assert.equal(git(fx.floor, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.floor, 'status', '--porcelain'), 'M app.txt');
});

test('a branch with no upstream is refused, and nothing is published', async (t) => {
  const fx = fixture(t);
  writeFileSync(path.join(fx.floor, 'app.txt'), 'changed\n');
  git(fx.floor, 'checkout', '-q', '-b', 'local-only');
  const head = git(fx.floor, 'rev-parse', 'HEAD');
  const { plan, result } = await run(fx, everything);
  const r = plan.repos.find((x) => x.kind === 'floor')!;
  assert.match(r.problem!, /doesn’t follow a branch on GitHub/);
  assert.equal(byKind(result, 'floor').state, 'skipped');
  assert.equal(git(fx.floor, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.floor, 'status', '--porcelain'), 'M app.txt');
  assert.equal(git(fx.floorOrigin, 'branch', '--list', 'local-only'), '');
});

test('a clash with GitHub stops cleanly: the work is saved in a commit here, nothing merged or uploaded', async (t) => {
  const fx = fixture(t);
  pushFrom(fx.floorSeed, { 'app.txt': 'ONE from GitHub\ntwo\n' }, 'Their edit');
  const theirs = git(fx.floorOrigin, 'rev-parse', 'personal');
  writeFileSync(path.join(fx.floor, 'app.txt'), 'one, my way\ntwo\n');
  const { result } = await run(fx);
  const floor = byKind(result, 'floor');
  assert.equal(floor.state, 'conflict', floor.message);
  assert.deepEqual(floor.clashes, ['app.txt']);
  assert.equal(floor.saved, 1);
  assert.match(floor.message, /saved in a commit here, not uploaded\. GitHub changed the same lines in app\.txt, so nothing was merged or uploaded/);
  // Back as it was after the save: the commit, no merge in progress, no conflict markers, GitHub untouched.
  assert.equal(git(fx.floor, 'log', '-1', '--format=%s'), 'Update app.txt');
  assert.equal(git(fx.floor, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(fx.floor, 'app.txt'), 'utf8'), 'one, my way\ntwo\n');
  assert.equal(git(fx.floorOrigin, 'rev-parse', 'personal'), theirs);
  assert.throws(() => git(fx.floor, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
});

test('the checklist follows what the app folder’s new commits change', async (t) => {
  const fx = fixture(t);
  const floors: OfficeFloor[] = [{ name: 'agent-office', dir: fx.floor, workers: () => [worker('w1', 'Byte', 'working'), worker('w2', 'Pixel', 'idle'), worker('w3', 'Dot', 'needs_input')] }];
  pushFrom(fx.officeSeed, { 'package.json': `${JSON.stringify({ name: 'agent-office', version: '0.2.0' }, null, 2)}\n`, 'src/server/server.ts': 'export const a = 2;\n' }, 'feat(server): Grok is the default model.', 57);
  const { result } = await run(fx, defaults, floors);
  const app = byKind(result, 'office');
  assert.equal(app.state, 'done', app.message);
  assert.equal(app.pulled, 1, 'a merged pull request is one change');
  const next = result.next;
  assert.equal(next.changed, true);
  assert.deepEqual(next.areas, ['packages', 'server']);
  assert.deepEqual(next.steps.map((s) => [s.kind, !!s.walkthrough]), [['packages', true], ['build', true], ['restart', true]]);
  assert.match(next.steps[2].why!, /^2 workers are mid-task: restarting interrupts them/);
  assert.deepEqual(next.busy.map((w) => w.name), ['Byte', 'Dot']);
  // Said the way the clipboard's What's new says a title (server/change-notes.ts tidyTitle).
  assert.deepEqual(next.news, [{ pr: 57, text: 'Grok is the default model' }]);
  assert.deepEqual(app.news, next.news);
});

test('the checklist for a pull that only changes the pages: build them, reload', async (t) => {
  const fx = fixture(t);
  pushFrom(fx.officeSeed, { 'src/client/main.ts': 'export const b = 2;\n', 'README.md': '# Office!\n' }, 'Bigger buttons');
  const next = (await run(fx)).result.next;
  assert.deepEqual(next.areas, ['client', 'docs']);
  assert.deepEqual(next.steps.map((s) => s.kind), ['build-client', 'reload']);
  assert.equal(next.steps[0].commands![0], `cd "${fx.app}"\nnpm run build:client`);
  assert.deepEqual(next.news, [{ text: '1 other change without a pull request' }]);
});

test('changeAreas and planNextSteps: packages, server, client-only, launcher, docs-only', () => {
  assert.deepEqual(changeAreas(['package-lock.json']), ['packages']);
  assert.deepEqual(changeAreas(['src/shared/layout.ts', 'bin/agent-office.js']), ['server']);
  assert.deepEqual(changeAreas(['src/client/main.ts', 'vite.config.ts']), ['client']);
  assert.deepEqual(changeAreas(['personal/windows/host.mjs']), ['launcher']);
  assert.deepEqual(changeAreas(['personal/windows/README.md', 'docs/a.md', 'tests/x.test.ts', 'PERSONAL-WORKFLOW.md', '.github/workflows/release.yml']), ['docs']);
  // Something unknown is treated as needing a build and restart.
  assert.deepEqual(changeAreas(['scripts/new-thing.mjs']), ['server']);

  const app = 'C:\\Office\\agent-office';
  const launcher = planNextSteps(['packages', 'client', 'launcher'], app, { busy: 1, startCommand: 'start it' });
  assert.deepEqual(launcher.map((s) => s.kind), ['stop', 'packages', 'build', 'launcher', 'start']);
  assert.match(launcher[0].why!, /1 worker is mid-task and will be interrupted/);
  assert.deepEqual(launcher[1].commands, [`cd "${app}"\nnpm ci`]);
  assert.deepEqual(launcher[2].commands, [`cd "${app}"\nnpm run build`]);
  assert.deepEqual(launcher[3].commands, [`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${app}\\personal\\windows\\Install-Launcher.ps1"`]);
  assert.deepEqual(launcher[4].commands, ['start it']);
  assert.ok(launcher.every((s) => !s.walkthrough), 'the launcher can’t be swapped while it runs the office');
  assert.deepEqual(planNextSteps(['launcher'], app).map((s) => s.kind), ['stop', 'launcher', 'start']);

  // No launcher to restart it: stop, packages by hand, start.
  assert.deepEqual(planNextSteps(['packages'], app, { canRestart: false }).map((s) => s.kind), ['packages', 'build', 'stop', 'packages', 'start']);
  assert.deepEqual(planNextSteps(['server', 'client'], app, { canRestart: true, busy: 0 }).map((s) => [s.kind, s.why]), [['build', 'The server’s code changed.'], ['restart', 'No workers are mid-task, so now is a good time.']]);
  assert.deepEqual(planNextSteps(['docs'], app).map((s) => s.kind), ['nothing']);
});

test('the small pieces: titles, news, suggested messages, blocked and risky names', () => {
  assert.deepEqual(newsLines([{ number: 1, title: 'fix: a', sha: 'x' }], 2, (t) => t.toUpperCase()), [{ pr: 1, text: 'FIX: A' }, { text: '2 other changes' }]);
  assert.equal(newsText({ pr: 7, text: 'A thing' }), 'A thing (#7)');
  assert.equal(suggestMessage([{ path: 'a/b/c.ts', status: 'M' }]), 'Update c.ts');
  assert.equal(suggestMessage([{ path: 'old.md', status: 'D' }, { path: 'x/older.md', status: 'D' }]), 'Remove old.md and older.md');
  assert.equal(suggestMessage(['src/client/a.ts', 'src/client/b.ts', 'src/client/ui/c.ts', 'src/client/d.ts'].map((p) => ({ path: p, status: 'M' as const }))), 'Update 4 files in src/client');
  assert.equal(suggestMessage(['src/a.ts', 'docs/b.md', 'tests/c.ts', 'src/d.ts'].map((p) => ({ path: p, status: 'M' as const }))), 'Update 4 files (src, docs and tests)');
  assert.equal(suggestMessage(['src/a.ts', 'docs/b.md', 'tests/c.ts', 'x.md'].map((p) => ({ path: p, status: 'M' as const }))), 'Update 4 files');
  assert.equal(blockedReason('src/app.ts'), undefined);
  assert.match(blockedReason('.agent-office/x.json')!, /office’s own data/);
  assert.match(blockedReason('packages/a/node_modules/b.js')!, /node_modules/);
  assert.match(blockedReason('vendor/lib/')!, /another Git repository/);
  assert.equal(riskyName('src/server/token.ts'), undefined);
  assert.ok(riskyName('client_secret.json'));
  assert.ok(riskyName('config/.npmrc'));
  assert.equal(riskyText('const re = /gh[pousr]_[A-Za-z0-9]{20,}/;'), undefined);
});

test('the route: anyone can look, only an admin can press Go, and a stale review is refused', async (t) => {
  const fx = fixture(t);
  const [status, plan] = await routeSyncAll('/api/git/sync-all', 'GET', {}, fx.floor, [], { admin: false }, fx.app);
  assert.equal(status, 200);
  assert.equal((plan as SyncPlan).admin, false);
  assert.deepEqual(await routeSyncAll('/api/git/sync-all/run', 'POST', { token: (plan as SyncPlan).token, choices: [] }, fx.floor, [], { admin: false }), [403, { error: 'Only an admin can sync the office' }]);
  const [, stale] = await routeSyncAll('/api/git/sync-all/run', 'POST', { token: 'nope', choices: [] }, fx.floor, [], { admin: true });
  assert.match((stale as { error: string }).error, /out of date/);
  await assert.rejects(routeSyncAll('/api/git/sync-all/run', 'POST', { token: 'x', choices: 'all' }, fx.floor, [], { admin: true }), /Bad request/);
});
