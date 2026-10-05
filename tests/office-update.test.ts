import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { beforeStart, readJson, removeStaged, stagePaths, startFailed, type Applied, type StagedBuild } from '../src/server/app-swap.js';
import { mergedPrs, npmCommand, OfficeUpdater, packageCheck, redact, routeOfficeUpdate, startupSnapshot, summarize } from '../src/server/office-update.js';
import { packagesByHand } from '../src/shared/office-update.js';
import type { OfficeFloor } from '../src/server/git-board.js';

// The guided office update against throwaway repositories: a bare "GitHub" repository, the app folder
// the office runs from (a clone on personal), and a floor that is another clone. Nothing here touches
// the real app folder, and no office is restarted: a stand-in launcher records the request.

const PREFIX = 'office update test ';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function configure(dir: string, hooks: string) {
  git(dir, 'config', 'user.name', 'Office Update Test');
  git(dir, 'config', 'user.email', 'office-update-test@example.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', hooks);
}

const BUILD = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (existsSync('fail.flag')) { console.error('src/client/main.ts(12,5): error TS2322: Type string is not assignable to type number.'); process.exit(2); }
mkdirSync('dist/public', { recursive: true });
mkdirSync('dist/server/server', { recursive: true });
writeFileSync('dist/public/index.html', '<!doctype html><title>built</title>');
writeFileSync('dist/server/server/server.js', 'export {};');
writeFileSync('dist/server/server/cli.js', 'console.log("office");');
console.log('> agent-office@0.1.0 build:server');
`;

function lock(deps: Record<string, { version: string; dev?: boolean; optional?: boolean }> = {}) {
  const packages: Record<string, unknown> = { '': { name: 'agent-office', version: '0.1.0' } };
  for (const [name, entry] of Object.entries(deps)) packages[`node_modules/${name}`] = entry;
  return `${JSON.stringify({ name: 'agent-office', version: '0.1.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

function fixture(t: { after(fn: () => void): void }) {
  // Git reports the physical path (/private/var on macOS), as the real app check expects.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), PREFIX)));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(path.basename(resolved).startsWith(PREFIX));
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const hooks = path.join(root, 'no-hooks');
  mkdirSync(hooks);
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'personal', origin], { stdio: 'ignore' });
  const seed = path.join(root, 'seed');
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', origin, seed], { stdio: 'ignore' });
  configure(seed, hooks);
  git(seed, 'checkout', '-q', '-b', 'personal');
  writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({ name: 'agent-office', version: '0.1.0', type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`);
  writeFileSync(path.join(seed, 'package-lock.json'), lock());
  writeFileSync(path.join(seed, 'build.mjs'), BUILD);
  writeFileSync(path.join(seed, '.gitignore'), 'node_modules\ndist\n.agent-office\n');
  writeFileSync(path.join(seed, 'app.txt'), 'one\ntwo\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initial');
  git(seed, 'push', '-q', 'origin', 'personal');
  const clone = (name: string) => {
    const dir = path.join(root, name);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '-b', 'personal', origin, dir], { stdio: 'ignore' });
    configure(dir, hooks);
    return dir;
  };
  const app = clone('app');
  // Installed packages matching the lock, and a build made by hand.
  mkdirSync(path.join(app, 'node_modules'));
  writeFileSync(path.join(app, 'node_modules', '.package-lock.json'), lock());
  writeFileSync(path.join(app, 'node_modules', 'keep.txt'), 'the running office’s packages');
  execFileSync(process.execPath, ['build.mjs'], { cwd: app });
  const floor = clone('floor');
  /** A pull request merged on "GitHub", as GitHub writes its merge commit. */
  const mergePr = (n: number, title: string, file: string, content: string) => {
    git(seed, 'checkout', '-q', '-b', `pr-${n}`, 'personal');
    writeFileSync(path.join(seed, file), content);
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', title);
    git(seed, 'checkout', '-q', 'personal');
    git(seed, 'merge', '-q', '--no-ff', `pr-${n}`, '-m', `Merge pull request #${n} from mmoscare/pr-${n}`, '-m', title);
    git(seed, 'push', '-q', 'origin', 'personal');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { root, origin, seed, app, floor, mergePr };
}

function updater(app: string, extra: Partial<ConstructorParameters<typeof OfficeUpdater>[0]> = {}) {
  const head = git(app, 'rev-parse', 'HEAD');
  return new OfficeUpdater({ appDir: app, running: head, startupHead: head, startedAt: Date.now() - 60_000, exitSwap: false, launcher: () => undefined, ...extra });
}

function worker(id: string, name: string, status: WorkerStatus): WorkerInfo {
  return { id, name, status, kind: 'agent', deskId: id, color: '#fff', acked: true, createdBy: 't', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
}

async function until(fn: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('merged pull requests are read from GitHub’s merge commits on the branch’s own line', async (t) => {
  const { app, seed, mergePr } = fixture(t);
  const from = git(app, 'rev-parse', 'HEAD');
  const a = mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  writeFileSync(path.join(seed, 'direct.txt'), 'x\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Tidy the README');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'Faster boards (#58)');
  git(seed, 'push', '-q', 'origin', 'personal');
  git(app, 'fetch', '-q');
  const { prs, other } = await mergedPrs(app, from, 'origin/personal');
  assert.deepEqual(prs.map((p) => [p.number, p.title]), [[57, 'Grok default model'], [58, 'Faster boards']]);
  assert.equal(prs[0].sha, a);
  assert.equal(other, 1);
});

test('pulling the app folder when it is only behind: a fast-forward, checked against the merged PR', async (t) => {
  const { app, mergePr } = fixture(t);
  const merge = mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const u = updater(app);
  const before = await u.state([], true, true);
  assert.equal(before?.app.behind, 2);
  assert.deepEqual(before?.prs.map((p) => p.number), [57]);
  assert.equal(before?.steps.app, 'todo');
  const o = await u.pullApp();
  assert.equal(o.ok, true, o.message);
  assert.equal(o.message, 'Pulled. PR #57 is now in the app folder.');
  assert.equal(o.notes?.length ?? 0, 0);
  assert.equal(git(app, 'rev-parse', 'HEAD'), merge);
  const after = await u.state([], true);
  assert.equal(after?.app.behind, 0);
  assert.equal(after?.steps.app, 'done');
  assert.equal(after?.steps.packages, 'skipped');
  assert.equal(after?.steps.build, 'todo');
});

test('an app folder with commits of its own still pulls, as a merge, and says ⬆️ Push can upload them', async (t) => {
  const { app, mergePr } = fixture(t);
  writeFileSync(path.join(app, 'local.txt'), 'merged here\n');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'A PR merged locally');
  const mine = git(app, 'rev-parse', 'HEAD');
  const merge = mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const o = await updater(app).pullApp();
  assert.equal(o.ok, true, o.message);
  assert.match(o.notes?.[0] ?? '', /also has 2 commits that aren’t on GitHub yet.*⬆️ Push/);
  const parents = git(app, 'rev-list', '--parents', '-n1', 'HEAD').split(' ');
  assert.deepEqual(parents.slice(1), [mine, merge], 'a merge commit keeps the local commit first');
  assert.equal(git(app, 'rev-list', '--count', 'HEAD..origin/personal'), '0');
  assert.equal(git(app, 'status', '--porcelain'), '');
});

test('unfinished work in the app folder: nothing is pulled, stashed or discarded, and the files are listed', async (t) => {
  const { app, mergePr } = fixture(t);
  mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  writeFileSync(path.join(app, 'app.txt'), 'one\nTWO (being edited)\n');
  writeFileSync(path.join(app, 'notes.txt'), 'draft\n');
  const head = git(app, 'rev-parse', 'HEAD');
  const o = await updater(app).pullApp();
  assert.equal(o.ok, false);
  assert.match(o.message, /^Stopped: someone’s unfinished work is in the app folder \(2 files\)/);
  assert.match(o.details ?? '', /app\.txt[\s\S]*notes\.txt/);
  assert.equal(git(app, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(app, 'app.txt'), 'utf8'), 'one\nTWO (being edited)\n');
  assert.equal(readFileSync(path.join(app, 'notes.txt'), 'utf8'), 'draft\n');
  assert.equal(git(app, 'stash', 'list'), '');
});

test('a clash is undone at once: the folder is back exactly as it was, and the clashing files are named', async (t) => {
  const { app, mergePr } = fixture(t);
  writeFileSync(path.join(app, 'app.txt'), 'one\nmine\n');
  git(app, 'commit', '-qam', 'Local change');
  const head = git(app, 'rev-parse', 'HEAD');
  mergePr(57, 'Grok default model', 'app.txt', 'one\ntheirs\n');
  const o = await updater(app).pullApp();
  assert.equal(o.ok, false);
  assert.equal(o.message, 'Nothing changed. These files clash: app.txt. Ask Claude to “update the app folder”.');
  assert.match(o.details ?? '', /git merge --abort[\s\S]*done[\s\S]*back as it was/);
  assert.equal(git(app, 'rev-parse', 'HEAD'), head);
  assert.equal(git(app, 'status', '--porcelain'), '');
  assert.equal(existsSync(path.join(app, '.git', 'MERGE_HEAD')), false);
  assert.equal(readFileSync(path.join(app, 'app.txt'), 'utf8'), 'one\nmine\n');
});

test('floors that are copies of the office’s code are pulled and checked', async (t) => {
  const { app, floor, mergePr } = fixture(t);
  mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const floors: OfficeFloor[] = [{ name: 'agent-office', dir: floor }, { name: 'The app itself', dir: app }];
  const u = updater(app);
  const s = await u.state(floors, true, true);
  assert.deepEqual(s?.floors.map((f) => [f.name, f.behind]), [['agent-office', 2]]);
  assert.equal(s?.steps.floor, 'todo');
  const o = await u.pullFloors(floors);
  assert.equal(o.ok, true, o.message);
  assert.match(o.message, /^Pulled\. The agent-office floor is up to date/);
  assert.equal((await u.state(floors, true))?.steps.floor, 'done');
});

test('package check: what is installed against package-lock.json, build tools told apart', (t) => {
  const { app } = fixture(t);
  assert.deepEqual(packageCheck(app), { needed: false, runtime: false, changes: [] });
  writeFileSync(path.join(app, 'package-lock.json'), lock({ vite: { version: '8.4.0', dev: true }, '@esbuild/linux-x64': { version: '0.28.2', dev: true, optional: true } }));
  writeFileSync(path.join(app, 'node_modules', '.package-lock.json'), lock({ vite: { version: '8.3.1', dev: true } }));
  assert.deepEqual(packageCheck(app), { needed: true, runtime: false, changes: ['vite 8.3.1 → 8.4.0'] });
  writeFileSync(path.join(app, 'package-lock.json'), lock({ vite: { version: '8.3.1', dev: true }, ws: { version: '8.21.3' } }));
  assert.deepEqual(packageCheck(app), { needed: true, runtime: true, changes: ['ws 8.21.3 (new)'] });
  rmSync(path.join(app, 'node_modules'), { recursive: true });
  assert.equal(packageCheck(app).needed, true);
});

test('the build is made in the staging copy; the running office’s dist and node_modules are never touched', async (t) => {
  const { app, mergePr } = fixture(t);
  const liveIndex = readFileSync(path.join(app, 'dist', 'public', 'index.html'), 'utf8');
  mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const u = updater(app);
  assert.equal((await u.pullApp()).ok, true);
  const head = git(app, 'rev-parse', 'HEAD');
  assert.equal(u.startBuild(), undefined);
  assert.match(u.startBuild() ?? '', /still running/);
  await until(async () => (await u.state([], true))?.build.state !== 'building');
  const s = await u.state([], true);
  assert.equal(s?.outcomes.build?.ok, true, s?.outcomes.build?.details);
  assert.match(s?.outcomes.build?.message ?? '', /^Built in .*switches in when the office restarts\.$/);
  assert.equal(s?.build.state, 'ready');
  assert.equal(s?.steps.build, 'done');
  assert.equal(s?.steps.restart, 'todo');
  const p = stagePaths(app);
  assert.deepEqual(readJson<StagedBuild>(p.ready)?.commit, head);
  assert.equal(readJson<{ commit: string }>(path.join(p.next, 'dist', 'build-info.json'))?.commit, head);
  assert.equal(readFileSync(path.join(app, 'dist', 'public', 'index.html'), 'utf8'), liveIndex);
  assert.equal(git(app, 'status', '--porcelain'), '', 'the staging folder is ignored by git');
  // Cleaning the staging copy takes its node_modules link away, never what it points to.
  removeStaged(p.stage, p.next);
  assert.equal(readFileSync(path.join(app, 'node_modules', 'keep.txt'), 'utf8'), 'the running office’s packages');
});

test('a failed build says so plainly, with the error line, and leaves the running office alone', async (t) => {
  const { app, seed } = fixture(t);
  writeFileSync(path.join(seed, 'fail.flag'), 'x');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Break the build');
  git(seed, 'push', '-q', 'origin', 'personal');
  const u = updater(app);
  assert.equal((await u.pullApp()).ok, true);
  assert.equal(u.startBuild(), undefined);
  await until(async () => (await u.state([], true))?.build.state !== 'building');
  const s = await u.state([], true);
  assert.equal(s?.build.state, 'failed');
  assert.equal(s?.outcomes.build?.ok, false);
  assert.equal(s?.outcomes.build?.message, 'The build failed. The running office is untouched. Ask Claude to “fix the build in the app folder”.');
  assert.match(s?.outcomes.build?.details ?? '', /^The problem: src\/client\/main\.ts\(12,5\): error TS2322/);
  assert.equal(existsSync(stagePaths(app).ready), false);
  assert.equal(existsSync(path.join(app, 'dist', 'server', 'server', 'cli.js')), true);
});

test('new packages go into the staging copy with npm ci, then switch in with the build at the restart', async (t) => {
  const { root, app, seed } = fixture(t);
  // A package from a local tarball: a real npm ci, with no network.
  const pkg = path.join(root, 'left');
  mkdirSync(pkg);
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'left', version: '1.0.0', main: 'index.js' }));
  writeFileSync(path.join(pkg, 'index.js'), 'module.exports = "left";');
  const npm = npmCommand();
  execFileSync(npm.file, [...npm.args, 'pack', '--silent', '--pack-destination', seed], { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = JSON.parse(readFileSync(path.join(seed, 'package.json'), 'utf8'));
  manifest.dependencies = { left: 'file:left-1.0.0.tgz' };
  writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync(npm.file, [...npm.args, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: seed, stdio: ['ignore', 'pipe', 'pipe'] });
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Add a package');
  git(seed, 'push', '-q', 'origin', 'personal');

  const u = updater(app);
  assert.equal((await u.pullApp()).ok, true);
  let s = await u.state([], true);
  assert.equal(s?.steps.packages, 'todo');
  assert.equal(s?.packages.runtime, true);
  assert.deepEqual(s?.packages.changes, ['left 1.0.0 (new)']);
  assert.equal(u.startBuild(), 'Get the new packages first (step 3).');
  assert.equal(u.startPackages(), undefined);
  await until(async () => (await u.state([], true))?.build.state !== 'packages', 120_000);
  s = await u.state([], true);
  assert.equal(s?.outcomes.packages?.ok, true, s?.outcomes.packages?.details);
  assert.equal(s?.steps.packages, 'done');
  const p = stagePaths(app);
  assert.equal(existsSync(path.join(p.next, 'node_modules', 'left', 'index.js')), true);
  assert.equal(existsSync(path.join(app, 'node_modules', 'left')), false, 'the running office’s node_modules is left alone');
  assert.equal(u.startBuild(), undefined);
  await until(async () => (await u.state([], true))?.build.state !== 'building');
  assert.equal(readJson<StagedBuild>(p.ready)?.packages, true);

  // The restart: the launcher's host.mjs switches both in while the office is stopped.
  const started = beforeStart(app);
  assert.equal(started.swapped, true, started.message);
  assert.equal(existsSync(path.join(app, 'node_modules', 'left', 'index.js')), true);
  const applied = readJson<Applied>(p.applied);
  assert.equal(applied?.state, 'applied');
  assert.equal(readFileSync(path.join(p.stage, applied!.backup!, 'node_modules', 'keep.txt'), 'utf8'), 'the running office’s packages');
  assert.equal(packageCheck(app).needed, false);
});

test('a staged build is switched in only for the commit it was built from, and put back if it fails to start', async (t) => {
  const { app, mergePr } = fixture(t);
  mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const u = updater(app);
  await u.pullApp();
  u.startBuild();
  await until(async () => (await u.state([], true))?.build.state !== 'building');
  const p = stagePaths(app);
  const oldCli = readFileSync(path.join(app, 'dist', 'server', 'server', 'cli.js'), 'utf8');
  writeFileSync(path.join(p.next, 'dist', 'server', 'server', 'cli.js'), 'throw new Error("new build")');

  // Someone committed in the app folder after the build: it's out of date, so nothing moves.
  writeFileSync(path.join(p.ready), JSON.stringify({ ...readJson<StagedBuild>(p.ready)!, commit: '0'.repeat(40) }));
  assert.equal(beforeStart(app).swapped, false);
  assert.equal(readJson<Applied>(p.applied)?.state, 'skipped');
  assert.equal(readFileSync(path.join(app, 'dist', 'server', 'server', 'cli.js'), 'utf8'), oldCli);

  writeFileSync(p.ready, JSON.stringify({ commit: git(app, 'rev-parse', 'HEAD'), builtAt: Date.now(), packages: false }));
  assert.equal(beforeStart(app).swapped, true);
  assert.equal(readFileSync(path.join(app, 'dist', 'server', 'server', 'cli.js'), 'utf8'), 'throw new Error("new build")');
  assert.equal(startFailed(app, 'Error: new build'), true);
  const back = beforeStart(app);
  assert.equal(back.swapped, false);
  assert.match(back.message ?? '', /went back to the previous one/);
  assert.equal(readFileSync(path.join(app, 'dist', 'server', 'server', 'cli.js'), 'utf8'), oldCli);
  assert.equal(readJson<Applied>(p.applied)?.state, 'rolled-back');
  assert.equal(readFileSync(path.join(app, 'node_modules', 'keep.txt'), 'utf8'), 'the running office’s packages');
});

test('restart: busy workers are listed and must be confirmed; what was running and who was busy is saved first', async (t) => {
  const { app } = fixture(t);
  let restarts = 0;
  const statuses: Record<string, WorkerStatus> = { a: 'working', b: 'needs_input', c: 'idle' };
  const floors: OfficeFloor[] = [{ name: 'Personal-Portfolio', dir: app, workers: () => [worker('a', 'Byte', statuses.a), worker('b', 'Pixel', statuses.b), worker('c', 'Gizmo', statuses.c)] }];
  const none = updater(app);
  assert.match((await none.requestRestart(floors, 'now', true, 'Owner')) as string, /can’t restart itself/);
  assert.equal((await none.state(floors, true))?.restart.available, false);

  const u = updater(app, { launcher: () => ({ restart: () => restarts++ }) });
  const s = await u.state(floors, true);
  assert.equal(s?.restart.available, true);
  assert.deepEqual(s?.busy.map((w) => [w.name, w.status]), [['Byte', 'working'], ['Pixel', 'needs_input']]);
  const ask = await u.requestRestart(floors, 'now', false, 'Owner');
  assert.deepEqual(typeof ask === 'object' && ask.confirm?.map((w) => w.name), ['Byte', 'Pixel']);
  assert.equal(existsSync(stagePaths(app).restart), false);

  // As soon as everyone is idle: it waits for Byte (working), not for Pixel (waiting on an answer).
  assert.deepEqual(await u.requestRestart(floors, 'idle', false, 'Owner'), { waiting: true });
  assert.ok((await u.state(floors, true))?.restart.waiting);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(restarts, 0);
  statuses.a = 'done';
  await until(() => restarts === 1, 10_000);
  const record = readJson<{ expect: string; busy: { name: string }[]; by: string }>(stagePaths(app).restart);
  assert.equal(record?.expect, git(app, 'rev-parse', 'HEAD'));
  assert.deepEqual(record?.busy.map((w) => w.name), ['Pixel']);
  assert.equal(record?.by, 'Owner');
  assert.equal((await u.state(floors, true))?.restart.pending, true);
});

test('after the restart: live when the office runs the expected commit, with the workers to tell “continue”', async (t) => {
  const { app, mergePr } = fixture(t);
  const oldHead = git(app, 'rev-parse', 'HEAD');
  const merge = mergePr(57, 'Grok default model', 'grok.txt', 'grok\n');
  const u = updater(app, { launcher: () => ({ restart() {} }) });
  await u.pullApp();
  const floors: OfficeFloor[] = [{ name: 'Personal-Portfolio', dir: app, workers: () => [worker('a', 'Byte', 'working')] }];
  assert.deepEqual(await u.requestRestart(floors, 'now', true, 'Owner'), { restarting: true });
  const pending = await u.state(floors, true);
  assert.equal(pending?.last?.verdict, 'pending');

  const back = (running: string) => new OfficeUpdater({ appDir: app, running, startupHead: running, startedAt: Date.now() + 1000, exitSwap: false, launcher: () => undefined });
  const after = [{ name: 'Personal-Portfolio', dir: app, workers: () => [worker('a', 'Byte', 'idle')] }];
  const live = await back(merge).state(after, true);
  assert.equal(live?.last?.verdict, 'live');
  assert.deepEqual(live?.last?.prs.map((p) => p.number), [57]);
  assert.deepEqual(live?.last?.now.map((w) => [w.name, w.status]), [['Byte', 'idle']]);
  assert.equal(Object.values(live!.steps).every((st) => st !== 'todo'), true);

  const old = await back(oldHead).state(after, true);
  assert.equal(old?.last?.verdict, 'old-code');
  assert.match(old?.last?.message ?? '', /still running the old version/);

  const [status, body] = await routeOfficeUpdate('/api/git/office/update/done', 'POST', new URLSearchParams(), {}, after, { admin: true, name: 'Owner' }, back(merge));
  assert.equal(status, 200);
  assert.equal((body as { state: { last: { acknowledged: boolean } } }).state.last.acknowledged, true);
});

test('only admins can press the buttons', async (t) => {
  const { app } = fixture(t);
  const u = updater(app);
  const [status] = await routeOfficeUpdate('/api/git/office/update/pull-app', 'POST', new URLSearchParams(), {}, [], { admin: false, name: 'Guest' }, u);
  assert.equal(status, 403);
  const [ok, body] = await routeOfficeUpdate('/api/git/office/update', 'GET', new URLSearchParams(), {}, [], { admin: false, name: 'Guest' }, u);
  assert.equal(ok, 200);
  assert.equal((body as { state: { admin: boolean } }).state.admin, false);
});

test('credentials never reach what is shown', () => {
  assert.equal(redact('fatal: unable to access https://me:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git'), 'fatal: unable to access https://***@github.com/x.git');
  assert.equal(redact('//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789'), '//registry.npmjs.org/:_authToken=***');
  assert.equal(redact('token github_pat_11ABCDEFG0123456789_abcdefghijklmnop'), 'token ***');
  assert.equal(summarize('npm error code ENOENT\nnpm error Could not read package.json\nnpm error A complete log of this run'), 'Could not read package.json');
});

test('the staging copy’s node_modules link is removed as a link', (t) => {
  const { root, app } = fixture(t);
  const p = stagePaths(app);
  mkdirSync(p.next, { recursive: true });
  symlinkSync(path.join(app, 'node_modules'), path.join(p.next, 'node_modules'), 'junction');
  assert.throws(() => removeStaged(p.stage, path.join(root, 'app')), /not inside/);
  removeStaged(p.stage, p.next);
  assert.equal(existsSync(p.next), false);
  assert.equal(readFileSync(path.join(app, 'node_modules', 'keep.txt'), 'utf8'), 'the running office’s packages');
});

/** Sets every file of a dist folder's build to this time (seconds), as a build then would have. */
function touchDist(dist: string, seconds: number) {
  for (const f of ['public/index.html', 'server/server/server.js']) utimesSync(path.join(dist, f), seconds, seconds);
}

test('a build by hand counts only when it is newer than the checkout’s last change, in a linked worktree too', (t) => {
  const { root, app } = fixture(t);
  // A linked worktree: its .git is a file, and HEAD's reflog lives in the main repository's .git/worktrees.
  const wt = path.join(root, 'app-worktree');
  git(app, 'worktree', 'add', '-q', '-b', 'worktree-app', wt);
  execFileSync(process.execPath, ['build.mjs'], { cwd: wt });
  const dist = path.join(wt, 'dist');
  const head = git(wt, 'rev-parse', 'HEAD');
  const now = Date.now() / 1000;
  touchDist(dist, now + 3600);
  assert.equal(startupSnapshot(wt, dist).running, head, 'built after the last change: of HEAD');
  touchDist(dist, now - 3600);
  assert.equal(startupSnapshot(wt, dist).running, undefined, 'built before the last change: not of HEAD');

  // No reflog at all: it can't be told, so it isn't taken as built.
  touchDist(path.join(app, 'dist'), now + 3600);
  assert.equal(startupSnapshot(app, path.join(app, 'dist')).running, git(app, 'rev-parse', 'HEAD'));
  rmSync(path.join(app, '.git', 'logs', 'HEAD'));
  assert.equal(startupSnapshot(app, path.join(app, 'dist')).running, undefined);
});

test('the build step is not done when a build by hand can’t be shown to be of the checked-out commit', async (t) => {
  const { app } = fixture(t);
  const u = updater(app, { running: undefined });
  touchDist(path.join(app, 'dist'), Date.now() / 1000 + 3600);
  assert.equal((await u.state([], true))?.steps.build, 'done', 'a build newer than the checkout’s last change');
  rmSync(path.join(app, '.git', 'logs', 'HEAD'));
  const s = await u.state([], true);
  assert.equal(s?.steps.build, 'todo');
  assert.equal(s?.steps.restart, 'todo');
});

test('a missing or unreadable record of what’s installed means new packages are needed', (t) => {
  const { app } = fixture(t);
  const record = path.join(app, 'node_modules', '.package-lock.json');
  assert.equal(packageCheck(app).needed, false);
  rmSync(record);
  const missing = packageCheck(app);
  assert.equal(missing.needed, true);
  assert.equal(missing.runtime, true);
  assert.match(missing.changes[0], /node_modules\/\.package-lock\.json\) is missing or unreadable/);
  writeFileSync(record, '{"packages": {"node_modules/vi');
  assert.equal(packageCheck(app).needed, true);
});

test('new packages by hand: npm ci then the build, and a staged build already running is dropped', async (t) => {
  const { app } = fixture(t);
  // Without a launcher, the staged build can't switch its node_modules in: the steps install and build in place.
  assert.equal(packagesByHand('/srv/agent-office'), 'cd "/srv/agent-office"\nnpm ci\nnpm run build');
  const head = git(app, 'rev-parse', 'HEAD');
  const p = stagePaths(app);
  mkdirSync(p.stage, { recursive: true });
  writeFileSync(p.ready, JSON.stringify({ commit: head, builtAt: Date.now(), packages: true }));
  const before = await updater(app, { running: '0'.repeat(40) }).state([], true);
  assert.equal(before?.restart.available, false);
  assert.equal(before?.restart.needsPackagesByHand, true);
  assert.equal(existsSync(p.ready), true, 'still waiting while the office runs an older build');
  // Started again after npm ci and npm run build by hand: it runs that commit, so the staged copy
  // mustn't be swapped over it at a later start.
  updater(app, { running: head });
  assert.equal(existsSync(p.ready), false);
  assert.deepEqual(readdirSync(p.stage).filter((f) => f === 'ready.json'), []);
});
