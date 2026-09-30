// npm run build, then node tests/office-update-ui.mjs. The guided office update end to end, in a throwaway
// office: a temporary "GitHub" (a bare repository), an app folder the office runs from (a clone whose
// build copies this checkout's dist) and a floor that is another clone. Pulls, the staged build and the
// restart are real; this script plays the Windows launcher and starts host.mjs again on exit code 75.
// Only the busy-worker warning, the restart-by-hand fallback and the "continue" list use mocked answers,
// because no real agents are hired here. Screenshots go to tmp/office-update (delete before committing).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-update-ui-'));
const shots = path.join(codeDir, 'tmp', 'office-update');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hooks = path.join(root, 'no-hooks');
const configure = (dir) => {
  git(dir, 'config', 'user.name', 'Update UI Test');
  git(dir, 'config', 'user.email', 'update-ui@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', hooks);
};
const clone = (name) => {
  const dir = path.join(root, name);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '-b', 'personal', origin, dir], { windowsHide: true, stdio: 'ignore' });
  configure(dir);
  return dir;
};
const origin = path.join(root, 'origin.git');
const seed = path.join(root, 'seed');
const flag = path.join(root, 'break-the-build.flag');
let host;
let browser;
let log = '';
const exits = [];
let port;
let password;
/** What to look at when something fails: filled in once the page is up. */
let report = async () => {};
let app;
let floor;

function startHost() {
  const child = spawn(process.execPath, [path.join(codeDir, 'personal', 'windows', 'host.mjs'), app, floor, String(port)], {
    cwd: app, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_HOME: path.join(root, 'home') },
  });
  child.stdout.on('data', (d) => { log = (log + d).slice(-20000); });
  child.stderr.on('data', (d) => { log = (log + d).slice(-20000); });
  // The launcher's part: 75 and 76 mean "start me again".
  child.on('exit', (code) => {
    exits.push(code);
    if (code === 75 || code === 76) host = startHost();
  });
  return child;
}

async function healthy(url) {
  for (let i = 0; i < 300; i++) {
    if (await fetch(url + '/api/health').then((r) => r.ok, () => false)) return;
    await pause(100);
  }
  throw new Error(`The office didn't come up: ${log}`);
}

try {
  mkdirSync(hooks);
  mkdirSync(shots, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'personal', origin], { windowsHide: true });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', origin, seed], { windowsHide: true, stdio: 'ignore' });
  configure(seed);
  git(seed, 'checkout', '-q', '-b', 'personal');
  writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({ name: 'agent-office', version: '0.1.0', type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`);
  writeFileSync(path.join(seed, 'package-lock.json'), `${JSON.stringify({ name: 'agent-office', version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'agent-office', version: '0.1.0' } } }, null, 2)}\n`);
  // "Building" copies this checkout's real build, so the office really runs from the app folder.
  writeFileSync(path.join(seed, 'build.mjs'), `import { cpSync, existsSync, rmSync } from 'node:fs';
if (existsSync(${JSON.stringify(flag)})) { console.error('src/client/ui/office-update.ts(12,5): error TS2322: Type string is not assignable to type number.'); process.exit(2); }
console.log('> agent-office@0.1.0 build:client');
rmSync('dist', { recursive: true, force: true });
cpSync(${JSON.stringify(path.join(codeDir, 'dist'))}, 'dist', { recursive: true });
console.log('> agent-office@0.1.0 build:server');
`);
  writeFileSync(path.join(seed, '.gitignore'), 'node_modules\ndist\n.agent-office\n');
  writeFileSync(path.join(seed, 'feature.txt'), 'before\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initial');
  git(seed, 'push', '-q', 'origin', 'personal');

  app = clone('app');
  symlinkSync(path.join(codeDir, 'node_modules'), path.join(app, 'node_modules'), 'junction');
  // Like the real app folder: a pull request merged here that isn't on GitHub yet.
  writeFileSync(path.join(app, 'local.txt'), 'merged in this folder\n');
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'Merge a PR locally');
  execFileSync(process.execPath, ['build.mjs'], { cwd: app, windowsHide: true });
  floor = clone('agent-office');

  // PR #57 merged on "GitHub".
  git(seed, 'checkout', '-q', '-b', 'grok-default', 'personal');
  writeFileSync(path.join(seed, 'feature.txt'), 'Grok is the default\n');
  git(seed, 'commit', '-qam', 'Grok default model');
  git(seed, 'checkout', '-q', 'personal');
  git(seed, 'merge', '-q', '--no-ff', 'grok-default', '-m', 'Merge pull request #57 from mmoscare/grok-default', '-m', 'Grok default model');
  git(seed, 'push', '-q', 'origin', 'personal');
  const merge = git(seed, 'rev-parse', 'HEAD');

  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  password = randomUUID();
  host = startHost();
  await healthy(url);

  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(120_000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Update Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  const floorId = await page.evaluate(() => window.__office.store.floor);
  report = async () => {
    console.log('host exits:', exits);
    console.log('page:', await page.evaluate(() => [...document.querySelectorAll('.update-bar, [role=dialog]')].map((e) => e.textContent).join(' --- ')).catch((e) => e.message));
    const r = await context.request.get(`${url}/api/git/office/update?floor=${floorId}`).catch((e) => e);
    console.log('state:', r.json ? JSON.stringify(await r.json().catch(() => r.status()), null, 1).slice(0, 5000) : r.message);
    console.log('office log:', log.slice(-4000));
  };

  // The same guards as the rest of /api/git.
  assert.equal((await fetch(`${url}/api/git/office/update?floor=${floorId}`)).status, 401);
  assert.equal((await context.request.post(`${url}/api/git/office/update/pull-app?floor=${floorId}`, { headers: { Origin: 'https://example.invalid' }, data: {} })).status(), 403);

  // The update bar names the pull request and opens the walkthrough.
  const bar = page.getByRole('region', { name: 'Update the office' });
  await bar.getByText('PR #57: Grok default model').waitFor();
  await bar.getByText('Step 1 of 5: Pull the floor').waitFor();
  await bar.screenshot({ path: path.join(shots, '0-update-bar.png') });
  // Someone's unfinished work in the app folder.
  writeFileSync(path.join(app, 'notes.txt'), 'half-written\n');
  await bar.getByRole('button', { name: /Walk me through it/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Update the office' });
  await dialog.getByText('Step 1 of 5').waitFor();
  await dialog.getByText('Bringing in').waitFor();
  assert.match(await dialog.innerText(), /Bringing in PR #57: Grok default model/);
  assert.match(await dialog.innerText(), /The agent-office floor is 2 changes behind GitHub/);
  await dialog.screenshot({ path: path.join(shots, '1-pull-the-floor.png') });

  // 1. The floor.
  await dialog.getByRole('button', { name: /Pull the floor/ }).click();
  await dialog.getByText('Step 2 of 5').waitFor();
  await dialog.getByText(/Pulled\. The agent-office floor is up to date/).waitFor();
  assert.equal(git(floor, 'rev-parse', 'HEAD'), merge);

  // 2. The app folder: stopped by the unfinished work, which is left alone.
  await dialog.getByText(/Someone’s unfinished work is in the app folder \(1 file\)/).waitFor();
  const before = git(app, 'rev-parse', 'HEAD');
  await dialog.getByRole('button', { name: /Pull the app folder/ }).click();
  await dialog.getByText(/Stopped: someone’s unfinished work is in the app folder \(1 file\), so nothing was pulled/).waitFor();
  await dialog.locator('.ou-card .ou-details summary').first().click();
  await dialog.locator('.ou-card .ou-details pre').filter({ hasText: 'notes.txt' }).waitFor();
  await dialog.screenshot({ path: path.join(shots, '2-app-folder-unfinished-work.png') });
  assert.equal(git(app, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(path.join(app, 'notes.txt'), 'utf8'), 'half-written\n');
  unlinkSync(path.join(app, 'notes.txt'));
  await dialog.getByRole('button', { name: /Try again/ }).click();
  await dialog.getByText('Step 4 of 5').waitFor();
  await dialog.getByText('Pulled. PR #57 is now in the app folder.', { exact: false }).waitFor();
  await dialog.getByText(/also has 2 commits that aren’t on GitHub yet.*⬆️ Push/).waitFor();
  await dialog.getByText('No new packages needed.', { exact: false }).waitFor();
  assert.equal(git(app, 'rev-list', '--count', 'HEAD..origin/personal'), '0');
  assert.equal(git(app, 'merge-base', '--is-ancestor', before, 'HEAD'), '');
  await dialog.screenshot({ path: path.join(shots, '3-pulled-then-build.png') });

  // 4. The build: a failure first, which leaves the running office alone.
  const liveIndex = readFileSync(path.join(app, 'dist', 'public', 'index.html'));
  writeFileSync(flag, 'x');
  await dialog.getByRole('button', { name: /Build it/ }).click();
  await dialog.getByText('The build failed. The running office is untouched. Ask Claude to “fix the build in the app folder”.', { exact: false }).waitFor();
  await dialog.locator('.ou-card .ou-details summary').first().click();
  await dialog.locator('.ou-card .ou-details pre').filter({ hasText: /The problem: src\/client\/ui\/office-update\.ts\(12,5\): error TS2322/ }).waitFor();
  await dialog.screenshot({ path: path.join(shots, '4-build-failed.png') });
  assert.deepEqual(readFileSync(path.join(app, 'dist', 'public', 'index.html')), liveIndex);
  unlinkSync(flag);
  await dialog.getByRole('button', { name: /Try again/ }).click();
  await dialog.getByText(/Building|Copying|Getting ready/).first().waitFor();
  await dialog.screenshot({ path: path.join(shots, '4-building.png') });
  await dialog.getByText('Step 5 of 5').waitFor({ timeout: 120_000 });
  await dialog.getByText(/Built in .* It switches in when the office restarts\./).waitFor();
  await dialog.getByText('No workers are busy right now', { exact: false }).waitFor();
  await dialog.screenshot({ path: path.join(shots, '5-restart.png') });
  assert.ok(existsSync(path.join(app, '.agent-office', 'app-update', 'ready.json')));

  // Mocked: busy workers, and the confirmation a restart then needs.
  const busy = [{ id: 'w-byte', name: 'Byte', floor: 'Personal-Portfolio', status: 'working' }, { id: 'w-pixel', name: 'Pixel', floor: 'agent-office', status: 'needs_input' }];
  // One handler for the whole run (it survives the reload after the restart): the office's real
  // answers, changed only while a mock is set.
  let mockState = null;
  let mockRestart = null;
  await page.route((u) => u.pathname.startsWith('/api/git/office/update'), async (route) => {
    const req = route.request();
    try {
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/restart') && mockRestart) return await route.fulfill({ json: mockRestart });
      if (req.method() !== 'GET' || !mockState) return await route.continue();
      const res = await route.fetch();
      const body = await res.json();
      if (body.state) mockState(body.state);
      return await route.fulfill({ response: res, json: body });
    } catch {
      await route.continue().catch(() => {});
    }
  });
  const reopen = async () => {
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => document.querySelector('.update-bar .btn.primary')?.click());
    await dialog.waitFor();
  };
  mockState = (s) => { s.busy = busy; };
  mockRestart = { confirm: busy };
  await reopen();
  await dialog.getByText(/These workers are busy right now\. Restarting stops them/).waitFor();
  await dialog.screenshot({ path: path.join(shots, '5-restart-busy-workers.png') });
  await dialog.getByRole('button', { name: /Restart now/ }).click();
  await dialog.getByText('Restart now and stop Byte and Pixel?').waitFor();
  await dialog.screenshot({ path: path.join(shots, '5-restart-confirm.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  mockRestart = null;

  // Mocked: an office that can't restart itself gets the steps to do it by hand.
  mockState = (s) => { s.restart = { available: false, reason: 'old-launcher' }; };
  await reopen();
  await dialog.getByText(/its launcher is from before this feature/).waitFor();
  await dialog.getByText('One-time setup', { exact: false }).waitFor();
  await dialog.screenshot({ path: path.join(shots, '5-restart-by-hand.png') });
  mockState = null;

  // 5. The real restart: host.mjs exits 75, "the launcher" starts it again on the new build.
  await reopen();
  await dialog.getByText('No workers are busy right now', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: /Restart now/ }).click();
  // A quick restart can reload the page before this is caught: the picture is a bonus.
  await dialog.getByText(/Restarting… this page reconnects by itself/).first().waitFor({ timeout: 5000 })
    .then(() => dialog.screenshot({ path: path.join(shots, '6-restarting.png') }))
    .catch(() => console.log('(the restart was too quick to photograph "Restarting…")'));
  // The page reloads onto the new office and brings the walkthrough back.
  await page.waitForFunction(() => document.querySelector('[role=dialog][aria-label="Update the office"]')?.textContent?.includes('Done: PR #57 is live'), null, { timeout: 120_000 });
  assert.deepEqual(exits, [75]);
  await healthy(url);
  const done = page.getByRole('dialog', { name: 'Update the office' });
  assert.match(await done.innerText(), /runs the new version \([0-9a-f]{7}\)/);
  await done.screenshot({ path: path.join(shots, '7-done.png') });
  const head = git(app, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse(readFileSync(path.join(app, 'dist', 'build-info.json'), 'utf8')).commit, head);
  assert.match(log, /Switched to the new build/);
  const state = (await (await context.request.get(`${url}/api/git/office/update?floor=${floorId}`)).json()).state;
  assert.equal(state.last.verdict, 'live');
  assert.equal(state.running.commit, head);
  assert.ok(Object.values(state.steps).every((s) => s !== 'todo'));

  // Mocked: the workers who were busy, each with a button to tell it "continue".
  mockState = (s) => { if (s.last) s.last.now = [{ ...busy[0], status: 'idle' }, { ...busy[1], status: 'done' }]; };
  await done.getByRole('button', { name: 'Close' }).first().click();
  await page.evaluate(() => document.querySelector('.update-bar .btn.primary')?.click());
  await done.getByText('Tell these workers “continue”:').waitFor();
  await done.getByRole('button', { name: /Say it to all of them/ }).waitFor();
  await done.screenshot({ path: path.join(shots, '7-done-continue.png') });
  await page.locator('.update-bar').screenshot({ path: path.join(shots, '7-update-bar-done.png') });
  mockState = null;

  // Narrow screens: no sideways scrolling.
  await page.setViewportSize({ width: 480, height: 800 });
  assert.ok(await done.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Close: the bar goes away until the next merge.
  await done.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.locator('.update-bar').waitFor({ state: 'hidden' });
  assert.deepEqual(pageErrors, []);
  console.log(`PASS: update bar → walkthrough; floor pull verified; unfinished work stops the app pull untouched; a merge keeps local commits and mentions ⬆️ Push; no new packages; a failed build leaves the office alone; staged build; busy-worker warning + confirm; restart-by-hand fallback; real restart via exit 75 onto the new build; "Done: PR #57 is live"; continue list; auth/origin guards; narrow layout. Screenshots in ${shots}`);
} catch (err) {
  await report().catch(() => {});
  throw err;
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.removeAllListeners('exit');
    host.stdin.write('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  const dir = realpathSync(root);
  assert.equal(path.dirname(dir), realpathSync(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('office-update-ui-'));
  const link = path.join(dir, 'app', 'node_modules');
  if (existsSync(link)) unlinkSync(link);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
