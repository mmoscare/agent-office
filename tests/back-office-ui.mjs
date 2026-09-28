// Manual Windows smoke check for the elevator's Back Office: npm run build, then node tests/back-office-ui.mjs.
// Uses an isolated temporary building and never hires agents or clones a repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-ui-'));
const officeDir = path.join(root, 'office');
const projectDir = path.join(root, 'back office project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host;
let browser;
let logs = '';
try {
  await mkdir(officeDir);
  await mkdir(path.join(officeDir, '.agent-office'));
  const usage = { input: 700, output: 100, reasoning: 100, cacheRead: 100, cacheWrite: 0, totalTokens: 1000, calls: 0, cost: 0, costKnown: false, callsKnown: false };
  await writeFile(path.join(officeDir, '.agent-office/model-usage.json'), JSON.stringify({ version: 1, records: [
    { key: 'codex:fixture', provider: 'codex', worker: 'Codex fixture', floor: 'Portfolio', startedAt: 123, updatedAt: 123, usage },
    { key: 'opencode:fixture', provider: 'opencode', worker: 'Grok fixture', floor: 'Dashboard', initialModel: 'xai/example', startedAt: 124, updatedAt: 124, usage: { ...usage, cost: .42, costKnown: true } },
  ] }));
  await mkdir(path.join(projectDir, 'frontend'), { recursive: true });
  await mkdir(path.join(projectDir, 'backend'));
  await writeFile(path.join(projectDir, 'keep.txt'), 'Unchanged project file');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, officeDir, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stdout.on('data', data => { logs += data; });
  host.stderr.on('data', data => { logs += data; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'launcher host starts the built server');
  assert.equal((await fetch(url + '/api/folders')).status, 401);
  assert.equal((await fetch(url + '/api/model-usage')).status, 401);
  assert.equal((await fetch(url + '/api/floors/local', { method: 'POST' })).status, 401);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  assert.equal((await context.request.post(url + '/api/floors/local', { data: { dir: projectDir } })).status(), 403);
  assert.equal((await context.request.post(url + '/api/floors/local', {
    headers: { Origin: url }, data: { dir: path.join(projectDir, 'keep.txt') },
  })).status(), 400);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Smoke test', color: '#ff8a5b', look: {} }));
    // Use the normal third-person setting so pointer lock does not redirect automated clicks.
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor, undefined, { timeout: 20000 });
  const floors = () => readFile(path.join(officeDir, '.agent-office/floors.json'), 'utf8').then(JSON.parse);
  const elevator = page.getByRole('dialog', { name: 'Elevator', exact: true });
  const openElevator = async () => {
    await page.evaluate(() => document.exitPointerLock());
    await page.locator('#project').click();
    await page.getByRole('menuitem', { name: /Elevator/ }).click();
    await elevator.waitFor({ state: 'visible' });
  };
  const screenshotDir = path.join(codeDir, 'tmp/screenshots');
  await mkdir(screenshotDir, { recursive: true });
  const officeFloor = await page.evaluate(() => window.__office.store.floor);

  // Add a local folder straight into the Back Office.
  await openElevator();
  assert.match(await elevator.locator('.floor-btn.basement').innerText(), /Back Office \(0\)/);
  await elevator.getByRole('button', { name: /Add a project/ }).click();
  const toggle = page.getByLabel(/File it in the Back Office/);
  assert.equal(await toggle.isChecked(), false, 'new projects go on the main list by default');
  await toggle.check();
  await page.locator('#local-floor-path').fill(projectDir);
  await elevator.screenshot({ path: path.join(screenshotDir, 'back-office-add.png') });
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.waitForFunction(() => window.__office?.store.project?.name === 'back office project');
  const saved = await floors();
  assert.equal(saved.length, 2);
  assert.equal(saved.find(d => d.name === 'back office project').backOffice, true);
  assert.equal(saved.find(d => d.id === officeFloor).backOffice, undefined);
  // The header counts floors the way the elevator numbers them.
  const projectMeta = () => page.locator('#project-meta').textContent();
  assert.match(await projectMeta(), /Back Office floor B1 of 1/);

  // On a Back Office floor, the elevator opens in the basement.
  await openElevator();
  assert.equal(await elevator.getByRole('button', { name: /back to the floors/ }).isVisible(), true);
  assert.match(await elevator.locator('.floor-btn.here').innerText(), /B1[\s\S]*back office project[\s\S]*you are here/);
  await elevator.screenshot({ path: path.join(screenshotDir, 'back-office-basement.png') });
  await elevator.getByRole('button', { name: /back to the floors/ }).click();
  // The main list shrank by one: only the office's own floor, numbered 1, and the basement button.
  assert.equal(await elevator.locator('.floor-row').count(), 1);
  assert.match(await elevator.locator('.floor-row').innerText(), /^1\b/);
  assert.match(await elevator.locator('.floor-btn.basement').innerText(), /Back Office \(1\)[\s\S]*you are down here/);
  await elevator.screenshot({ path: path.join(screenshotDir, 'back-office-main.png') });
  await elevator.locator('.floor-row .floor-btn').first().click();
  await page.waitForFunction(id => window.__office?.store.floor === id, officeFloor);
  assert.match(await projectMeta(), /🛗 floor 1 of 1\b/, 'the Back Office floor is not counted among the main floors');

  // Down to B and pick the Back Office floor.
  await openElevator();
  await elevator.locator('.floor-btn.basement').click();
  await elevator.locator('.floor-btn').filter({ hasText: 'back office project' }).click();
  await page.waitForFunction(() => window.__office?.store.project?.name === 'back office project');

  // Move the office's floor down and back up without re-adding it.
  await openElevator();
  await elevator.getByRole('button', { name: /back to the floors/ }).click();
  await elevator.locator('.floor-move').first().click();
  await page.waitForFunction(() => window.__office.store.floors.every(f => f.backOffice));
  assert.ok((await floors()).every(d => d.backOffice === true));
  assert.match(await elevator.innerText(), /Every floor is filed in the Back Office/);
  await elevator.locator('.floor-btn.basement').click();
  await elevator.locator('.floor-row').filter({ hasText: /^B1/ }).locator('.floor-move').click();
  await page.waitForFunction(id => !window.__office.store.floors.find(f => f.id === id).backOffice, officeFloor);
  assert.equal((await floors()).find(d => d.id === officeFloor).backOffice, undefined);
  await elevator.getByRole('button', { name: 'Close', exact: true }).click();

  // The corner floor menu keeps the Back Office in its own section, open while you're down there.
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#project').click();
  const menu = page.getByRole('menu', { name: 'Floors' });
  await menu.waitFor({ state: 'visible' });
  assert.match(await menu.innerText(), /Back Office \(1\)/i);
  const backItem = menu.locator('.floor-item').filter({ hasText: 'back office project' });
  assert.match(await backItem.innerText(), /B1[\s\S]*you are here/);
  await menu.screenshot({ path: path.join(screenshotDir, 'back-office-floor-menu.png') });
  await menu.getByRole('button', { name: /Back Office/ }).click();
  assert.equal(await backItem.count(), 0, 'the section collapses');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  host.stdin.write('stop\n');
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Launcher host did not stop gracefully')), 15000);
    host.once('exit', () => { clearTimeout(deadline); resolve(); });
  });
  assert.equal(host.exitCode, 0);
  assert.equal(await fetch(url + '/api/health').then(r => r.ok, () => false), false);
  console.log('PASS: added a local folder into the Back Office, rode to B1 and back up, moved a floor down and back, and floors.json kept the flag.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  // Only remove this test's unique directory, resolved beneath the OS temp directory.
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('agent-office-ui-'));
  await rm(root, { recursive: true, force: true });
}
