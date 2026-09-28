// npm run build, then node tests/push-ui.mjs [screenshot.png]. Pushes only to a temporary local bare remote.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-push-ui-'));
const floor = path.join(root, 'project');
const remote = path.join(root, 'origin.git');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, browser;
let errors = '';
try {
  mkdirSync(floor); mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Push UI Test'); git(floor, 'config', 'user.email', 'push-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false'); git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Initial'); git(floor, 'remote', 'add', 'origin', remote); git(floor, 'push', '-u', 'origin', 'main');
  git(floor, 'commit', '--allow-empty', '-m', 'Finished the homepage');
  writeFileSync(path.join(floor, 'unfinished.txt'), 'Still editing');
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port; const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  for (let i = 0; i < 150; i++) {
    assert.equal(host.exitCode, null, errors);
    if (await fetch(url + '/api/health').then(r => r.ok, () => false)) break;
    await pause(100);
  }
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(20000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Push Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.__office?.store.floor);
  const floorId = await page.evaluate(() => window.__office.store.floor);
  assert.equal((await fetch(url + '/api/git/push-targets?floor=' + floorId)).status, 401);
  assert.equal((await context.request.post(url + '/api/git/push-reviewed?floor=' + floorId, { headers: { Origin: 'https://example.invalid' }, data: {} })).status(), 403);
  await page.getByRole('button', { name: 'Push', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Push', exact: true });
  const chooser = dialog.getByRole('combobox', { name: 'Repository to push' });
  await chooser.selectOption('floor:.');
  await dialog.getByText('1 commit ready to push', { exact: true }).waitFor();
  await dialog.getByText('Finished the homepage', { exact: false }).waitFor();
  assert.match(await dialog.textContent(), /uncommitted file.*stay.*on this computer/);
  assert.ok(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await dialog.getByRole('button', { name: 'Push', exact: true }).click();
  await dialog.getByText('Pushed 1 commit from main.', { exact: true }).waitFor();
  assert.equal(git(remote, 'rev-parse', 'main'), git(floor, 'rev-parse', 'HEAD'));
  assert.equal(git(floor, 'status', '--porcelain'), '?? unfinished.txt');
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
  await dialog.getByText('Everything committed is uploaded', { exact: true }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'Push', exact: true }).isDisabled());
  git(floor, 'commit', '--allow-empty', '-m', 'Reviewed next change');
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
  await dialog.getByText('1 commit ready to push', { exact: true }).waitFor();
  git(floor, 'commit', '--allow-empty', '-m', 'Concurrent change');
  await dialog.getByRole('button', { name: 'Push', exact: true }).click();
  await dialog.getByText(/changed since your review/).waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'Push', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
  await dialog.getByText('2 commits ready to push', { exact: true }).waitFor();
  await page.setViewportSize({ width: 480, height: 800 });
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
  const another = path.join(root, 'another'); mkdirSync(another);
  const added = await context.request.post(url + '/api/floors/local', { headers: { Origin: url }, data: { dir: another } });
  assert.equal(added.status(), 200); const next = await added.json();
  await page.evaluate(id => window.__office.net.send({ t: 'floor.go', floor: id }), next.floor);
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(pageErrors, []);
  await browser.close(); browser = null;
  host.stdin.write('stop\n');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Host failed to stop')), 15000); host.once('exit', () => { clearTimeout(timer); resolve(); }); });
  assert.equal(host.exitCode, 0, errors);
  console.log('PASS: Push reminder, explicit repository choice, reviewed upload, untouched dirty work, up-to-date advice, stale-review recovery, mobile layout, floor-switch closure, auth/origin checks and clean shutdown.');
} finally {
  await browser?.close();
  if (host && host.exitCode === null) { host.stdin.write('stop\n'); for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100); if (host.exitCode === null) host.kill(); }
  const dir = realpathSync(root); assert.equal(path.dirname(dir), realpathSync(os.tmpdir())); assert.ok(path.basename(dir).startsWith('office-push-ui-'));
  rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
