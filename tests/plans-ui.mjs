// npm run build, then node tests/plans-ui.mjs [screenshot.png].
// An isolated office with idle Node fixtures; no AI provider or live office is used.
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-plans-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, browser;
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Branch UI Test');
  git(floor, 'config', 'user.email', 'branch-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Branch fixture ready\\r\\n'); process.stdin.resume();");
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(host.exitCode, null);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Plans Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  const floorId = await page.evaluate(() => window.__office.store.floor);
  assert.equal((await fetch(url + '/api/plans?floor=' + floorId)).status, 401);
  assert.equal((await context.request.get(url + '/api/plans?floor=missing')).status(), 404);
  assert.equal((await context.request.post(url + '/api/plans?floor=' + floorId, { data: { revision: 0, action: 'add', text: 'Cross-origin' }, headers: { Origin: 'https://example.invalid' } })).status(), 403);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await pause(200);
  const binder = await page.evaluate(() => {
    const o = window.__office;
    const binder = o.office.group.getObjectByName('to-do-next-binder');
    const p = binder.getWorldPosition(binder.position.clone());
    o.player.pos.set(p.x, p.y - 0.83, p.z + 1.9);
    o.player.yaw = 0;
    return { x: p.x, y: p.y, z: p.z, kind: binder.userData.interact.kind, children: binder.children.length };
  });
  assert.equal(binder.kind, 'plans');
  assert.ok(binder.children >= 7);
  // Freeze the camera for an actual raycast click and a close-up of the binder on the desk.
  const point = await page.evaluate(() => {
    const o = window.__office;
    o.renderer.setAnimationLoop(null);
    const b = o.office.group.getObjectByName('to-do-next-binder');
    const p = b.getWorldPosition(b.position.clone());
    o.camera.position.set(p.x - 1.5, p.y + 2.2, p.z + 2.5);
    o.camera.lookAt(p.x + .25, p.y, p.z);
    o.camera.updateMatrixWorld();
    o.renderer.render(o.scene, o.camera);
    p.y += .12;
    p.project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
  });
  if (process.argv[2]) await page.screenshot({ path: process.argv[2].replace('.png', '-desk.png') });
  await page.mouse.click(point.x, point.y);
  let dialog = page.getByRole('dialog', { name: 'To Do Next', exact: true });
  await dialog.getByText('All plans saved', { exact: true }).waitFor();
  const open = async () => {
    await page.evaluate(() => document.exitPointerLock());
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'To Do Next', exact: true }).click();
    await dialog.getByText('All plans saved', { exact: true }).waitFor();
  };
  const saved = () => dialog.getByText('Saved', { exact: true }).waitFor();
  const planText = 'Build a simpler homepage\nAdd a gallery and contact form';
  await dialog.getByRole('textbox', { name: 'New plan', exact: true }).fill(planText);
  await dialog.getByRole('button', { name: 'Add plan', exact: true }).click();
  await saved();
  await dialog.locator('[data-status=todo] .plan-text').filter({ hasText: 'Build a simpler homepage' }).waitFor();
  await dialog.getByRole('combobox', { name: 'Move plan' }).selectOption('progress');
  await dialog.locator('[data-status=progress] .plan-card').waitFor();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Edit plan', exact: true }).fill(planText + '\nKeep it fast');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved();
  await dialog.getByRole('combobox', { name: 'Move plan' }).selectOption('finished');
  await dialog.locator('[data-status=finished] .plan-card').waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await open();
  assert.equal(await dialog.locator('[data-status=finished] .plan-text').textContent(), planText + '\nKeep it fast');
  // Saving failure retains the draft and never reports success.
  await page.route('**/api/plans?*', async route => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test write failure' }) });
    else await route.continue();
  });
  await dialog.getByRole('textbox', { name: 'New plan', exact: true }).fill('Keep this draft');
  await dialog.getByRole('button', { name: 'Add plan', exact: true }).click();
  await dialog.getByText('Change not saved', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'New plan', exact: true }).inputValue(), 'Keep this draft');
  await page.unroute('**/api/plans?*');
  await dialog.getByRole('button', { name: 'Add plan', exact: true }).click();
  await saved();
  // A second writer cannot silently overwrite this window's revision.
  const api = url + '/api/plans?floor=' + floorId;
  const state = await (await context.request.get(api)).json();
  assert.equal((await context.request.post(api, { headers: { Origin: url }, data: { revision: state.revision, action: 'add', text: 'Other window plan' } })).status(), 200);
  await dialog.getByRole('textbox', { name: 'New plan', exact: true }).fill('Next idea');
  await dialog.getByRole('button', { name: 'Add plan', exact: true }).click();
  await dialog.getByText(/changed in another window/).waitFor();
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await dialog.getByText('All plans saved', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'New plan', exact: true }).inputValue(), 'Next idea');
  await dialog.getByRole('button', { name: 'Add plan', exact: true }).click();
  await saved();
  const card = dialog.locator('.plan-card').filter({ hasText: 'Keep this draft' });
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.getByRole('button', { name: 'Keep plan', exact: true }).click();
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.getByRole('button', { name: 'Remove plan', exact: true }).click();
  await saved();
  assert.equal(await card.count(), 0);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await page.setViewportSize({ width: 480, height: 800 });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const second = path.join(root, 'second'); mkdirSync(second);
  const added = await context.request.post(url + '/api/floors/local', { headers: { Origin: url }, data: { dir: second } });
  assert.equal(added.status(), 200);
  const addedBody = await added.json();
  const secondId = addedBody.floor;
  assert.ok(secondId, JSON.stringify(addedBody));
  assert.deepEqual((await (await context.request.get(url + '/api/plans?floor=' + secondId)).json()).items, []);
  await page.reload();
  await page.waitForFunction(() => window.__office?.store.floor);
  await open();
  assert.equal(await dialog.locator('.plan-card').count(), 3);
  await page.evaluate(id => window.__office.net.send({ t: 'floor.go', floor: id }), secondId);
  await dialog.waitFor({ state: 'hidden' });
  await open();
  assert.equal(await dialog.locator('.plan-card').count(), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  await browser.close(); browser = null;
  host.stdin.end('stop\n');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Host did not stop')), 15000); host.once('exit', () => { clearTimeout(timer); resolve(); }); });
  assert.equal(host.exitCode, 0);
  const disk = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(floor, '.agent-office/plans.json'), 'utf8'));
  assert.equal(disk.items.length, 3);
  console.log('PASS: desk binder click, add/edit/move/remove, reload persistence, failed-save draft recovery, stale-write protection, floor isolation, mobile layout, auth/origin checks, clean browser and graceful host stop.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-plans-ui-'));
  rmSync(root, { recursive: true, force: true });
}
