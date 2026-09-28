// npm run build && node tests/backoffice-ui.mjs
// Isolated office and local projects; no workers or real GitHub clones.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'office-backoffice-ui-'));
const officeDir = path.join(root, 'Upstairs');
const projectDir = path.join(root, 'Basement project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host, browser, page, observer;
let logs = '';
try {
  await mkdir(officeDir);
  await mkdir(projectDir);
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
  assert.ok(ready, 'built server starts');
  console.log('Temporary server ready');
  assert.equal((await fetch(url + '/api/floors/section', { method: 'POST' })).status, 401);
  browser = await chromium.launch({
    ...(process.env.AGENT_OFFICE_TEST_BROWSER ? { executablePath: process.env.AGENT_OFFICE_TEST_BROWSER } : { channel: process.platform === 'win32' ? 'msedge' : 'chromium' }),
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  const post = (route, data, headers = { Origin: url }) => context.request.post(url + route, { headers, data });
  assert.equal((await post('/api/floors/section', { floor: 'upstairs', section: 'backoffice' }, {})).status(), 403);
  assert.equal((await post('/api/floors/section', { floor: 'upstairs', section: 'invalid' })).status(), 400);
  assert.equal((await post('/api/floors/section', { floor: 'missing', section: 'backoffice' })).status(), 400);
  assert.equal((await post('/api/floors/local', { dir: projectDir, section: 'invalid' })).status(), 400);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Backoffice test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor, undefined, { timeout: 20000 });
  let observedFloors = [];
  const cookie = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  observer = new WebSocket(url.replace('http:', 'ws:') + '/ws?name=Observer', { headers: { Origin: url, Cookie: cookie } });
  observer.on('message', raw => { const msg = JSON.parse(String(raw)); if (msg.floors) observedFloors = msg.floors; });
  await new Promise((resolve, reject) => { observer.once('open', resolve); observer.once('error', reject); });
  // Directory checks do not need continual 3D rendering on this shared Windows machine.
  await page.evaluate(() => { window.__office.renderer.render = () => {}; });
  console.log('Both clients connected');
  const elevator = page.getByRole('dialog', { name: 'Elevator', exact: true });
  const openElevator = async () => {
    await page.evaluate(() => document.exitPointerLock());
    await page.locator('#project').click();
    await page.getByRole('menuitem', { name: /Elevator/ }).click();
    await elevator.waitFor();
  };
  const waitSection = section => page.waitForFunction(section => window.__office.store.floors.some(f => f.name === 'Basement project' && f.section === section), section);
  const waitObserver = async section => {
    for (let i = 0; i < 100; i++) {
      if (observedFloors.some(f => f.name === 'Basement project' && f.section === section)) return;
      await pause(100);
    }
    assert.fail(`Second client did not receive ${section} placement`);
  };
  await openElevator();
  await page.getByRole('button', { name: 'Basement: Backoffice', exact: true }).click();
  assert.match(await elevator.innerText(), /No Backoffice projects yet/);
  await page.getByRole('button', { name: /Add a project/ }).click();
  await page.locator('#local-floor-path').fill(projectDir);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.waitForFunction(() => window.__office.store.project?.name === 'Basement project');
  await waitObserver('backoffice');
  console.log('Local folder added in Backoffice');
  const saved = () => readFile(path.join(officeDir, '.agent-office/floors.json'), 'utf8').then(JSON.parse);
  assert.equal((await saved()).find(f => f.name === 'Basement project').section, 'backoffice');

  await openElevator();
  assert.equal(await elevator.locator('.floor-entry').count(), 1, 'basement repo is hidden upstairs');
  assert.match(await elevator.getByRole('button', { name: 'Basement: Backoffice' }).innerText(), /you are here/);
  await page.getByRole('button', { name: 'Basement: Backoffice' }).click();
  assert.equal(await elevator.locator('.floor-entry').count(), 1);
  await page.getByRole('button', { name: 'Move to main floors: Basement project', exact: true }).click();
  await waitSection('main');
  await waitObserver('main');
  assert.equal(await elevator.locator('.floor-entry').count(), 0);
  await page.getByRole('button', { name: '← Main floors', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Backoffice: Basement project', exact: true }).click();
  await waitSection('backoffice');
  assert.equal(await elevator.locator('.floor-entry').count(), 1);
  await elevator.getByRole('button', { name: 'Close', exact: true }).click();

  // The corner picker also stays short, and its elevator link preserves Backoffice.
  await page.locator('#project').click();
  assert.equal(await page.locator('.floor-menu .floor-item').filter({ hasText: 'Basement project' }).count(), 0);
  await page.getByRole('menuitem', { name: /Backoffice/ }).click();
  assert.equal(await page.locator('.floor-menu .floor-item').filter({ hasText: 'Basement project' }).count(), 1);
  await page.getByRole('menuitem', { name: /Elevator/ }).click();
  assert.equal(await elevator.locator('h2').innerText(), 'B · Backoffice');
  await page.getByRole('button', { name: /Add a project/ }).click();
  await page.locator('#local-floor-path').fill(projectDir);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await elevator.waitFor({ state: 'hidden' });
  assert.equal((await saved()).length, 2, 'existing floors are reused');
  await page.reload();
  await waitSection('backoffice');
  await page.evaluate(() => { window.__office.renderer.render = () => {}; });

  // Exercise the real clone picker and response handling without cloning or contacting GitHub.
  await page.evaluate(() => {
    const { net, store } = window.__office;
    const send = net.send.bind(net);
    net.send = msg => {
      if (msg.t === 'floor.repos') return;
      if (msg.t === 'floor.add') { window.__cloneRequest = msg; return; }
      send(msg);
    };
    store.repos = { list: [{ name: 'fixture/repo', private: false }], at: Date.now(), loading: false };
  });
  await openElevator();
  await page.getByRole('button', { name: 'Basement: Backoffice' }).click();
  await page.getByRole('button', { name: /Add a project/ }).click();
  await page.getByRole('button', { name: 'Clone from GitHub', exact: true }).click();
  await page.getByRole('option', { name: 'fixture/repo', exact: true }).click();
  await page.getByRole('button', { name: /Add fixture\/repo/ }).click();
  assert.deepEqual(await page.evaluate(() => window.__cloneRequest), { t: 'floor.add', repo: 'fixture/repo', section: 'backoffice' });
  assert.equal(await page.getByRole('button', { name: '← Main floors' }).isDisabled(), true);
  await page.evaluate(() => window.__office.net.ws.onmessage({ data: JSON.stringify({ t: 'floor.added', repo: 'fixture/repo', error: 'Fixture clone failed' }) }));
  assert.match(await elevator.innerText(), /Fixture clone failed/);
  assert.equal(await page.getByRole('button', { name: '← Main floors' }).isEnabled(), true);
  await page.getByRole('button', { name: 'Local folder', exact: true }).click();
  assert.equal(await page.locator('#local-floor-path').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await elevator.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'menu fits narrow screens');
  const shots = path.join(codeDir, '.agent-office/verification/backoffice');
  await mkdir(shots, { recursive: true });
  await elevator.screenshot({ path: path.join(shots, 'basement-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '← Main floors' }).click();
  await elevator.screenshot({ path: path.join(shots, 'elevator-main.png') });
  // Rides still reach ordinary project floors.
  await elevator.locator('.floor-entry .floor-btn').filter({ hasText: 'Upstairs' }).click();
  await page.waitForFunction(() => window.__office.store.project?.name === 'Upstairs');
  await openElevator();
  await page.getByRole('button', { name: 'Basement: Backoffice' }).click();
  await elevator.locator('.floor-entry .floor-btn').filter({ hasText: 'Basement project' }).click();
  await page.waitForFunction(() => window.__office.store.project?.name === 'Basement project');
  assert.deepEqual(errors, []);
  console.log('PASS: authentication, validation, add local in Backoffice, persistence, duplicates, moves both ways, broadcasts to a second client, both directories, clone request/error handling, narrow layout and floor rides.');
} catch (error) {
  if (page) console.error('Browser state:', page.url(), await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'unavailable'));
  throw error;
} finally {
  observer?.close();
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-backoffice-ui-'));
  await rm(root, { recursive: true, force: true });
}
