// npm run build && node tests/elevator-tiles-ui.mjs
// Isolated building, no workers or clones. Exercises the actual scene picking and ride flow.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-elevator-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host;
let browser;
let logs = '';
try {
  const officeDir = path.join(root, 'Office');
  await mkdir(officeDir);
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
  assert.ok(ready);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  for (let i = 2; i <= 8; i++) {
    const dir = path.join(root, i === 2 ? 'Personal Portfolio with a very long project name' : `Project ${i}`);
    await mkdir(dir);
    assert.equal((await context.request.post(url + '/api/floors/local', { headers: { Origin: url }, data: { dir } })).status(), 200);
  }
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Elevator test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, hud: { balances: false } }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor && window.__office.player.enabled);
  const floors = await page.evaluate(() => window.__office.store.floors.map(f => f.id));
  assert.equal(floors.length, 8);
  const look = async () => {
    await page.evaluate(() => {
      const { player } = window.__office;
      player.view = 'third';
      player.pos.set(8.5, 0, -11.3);
      player.camYaw = 0;
      player.camPitch = -0.28;
      player.camDist = 0.35;
      player.updateCamera(true);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const point = action => page.evaluate(action => {
    const o = window.__office;
    o.scene.updateMatrixWorld(true);
    o.camera.updateMatrixWorld(true);
    const lift = o.store.floor === '@roof' ? o.roof().elevator : o.office.elevator;
    const panel = lift.group.getObjectByName('elevator-floor-tiles');
    let button;
    panel.traverse(child => {
      const it = child.userData.interact;
      if (it && Object.entries(action).every(([k, v]) => it[k] === v)) button = child;
    });
    if (!button) throw new Error(`Missing tile ${JSON.stringify(action)}`);
    const p = button.getWorldPosition(o.player.pos.clone()).project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
  }, action);
  const click = async action => {
    const p = await point(action);
    await page.mouse.click(p.x, p.y);
  };
  await look();
  const shotDir = path.join(codeDir, '.agent-office/verification/elevator-tiles');
  await mkdir(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'back-wall.png') });
  await click({ floorId: floors[0] });
  assert.equal(await page.evaluate(() => window.__office.store.floor), floors[0], 'current floor stays put');
  await click({ floorId: floors[1] });
  await page.waitForFunction(id => window.__office.store.floor === id && window.__office.player.enabled, floors[1]);
  console.log('PASS: current floor stays put and clicking another tile completes a ride.');
  await look();
  await click({ elevatorPage: 1 });
  await page.waitForFunction(id => {
    let found = false;
    window.__office.office.elevator.group.traverse(o => { if (o.userData.interact?.floorId === id) found = true; });
    return found;
  }, floors[7]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await page.screenshot({ path: path.join(shotDir, 'second-page.png') });
  // E on a hovered tile uses the same destination as clicking.
  const destination = await point({ floorId: floors[7] });
  await page.mouse.move(destination.x, destination.y);
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('Project 8'));
  await page.keyboard.press('e');
  await page.waitForFunction(id => window.__office.store.floor === id && window.__office.player.enabled, floors[7]);
  console.log('PASS: paging and keyboard ride.');
  await look();
  await click({ elevatorPage: -1 });
  const roofId = await page.evaluate(() => {
    const panel = window.__office.office.elevator.group.getObjectByName('elevator-floor-tiles');
    let id;
    panel.traverse(o => { if (o.userData.interact?.floorId === '@roof') id = o.userData.interact.floorId; });
    return id;
  });
  assert.ok(roofId);
  await click({ floorId: roofId });
  await page.waitForFunction(id => window.__office.store.floor === id && window.__office.player.enabled, roofId);
  await look();
  await click({ floorId: floors[0] });
  await page.waitForFunction(id => window.__office.store.floor === id && window.__office.player.enabled, floors[0]);
  assert.deepEqual(errors, []);
  console.log('PASS: current-floor guard, click ride, paging, E ride, rooftop round trip, no browser errors.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('agent-office-elevator-'));
  await rm(root, { recursive: true, force: true });
}
