// Isolated built-app smoke test. UI data is mocked; real Git behavior is covered by author-updates.test.ts.
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
const root = await mkdtemp(path.join(os.tmpdir(), 'office-author-ui-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host, browser;
let logs = '';
try {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, root, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stdout.on('data', d => { logs += d; });
  host.stderr.on('data', d => { logs += d; });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited: ${logs}`);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready);
  assert.equal((await fetch(url + '/api/git/author-updates')).status, 401);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.post(url + '/api/login', { data: { password } });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Update test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, pins: ['author-updates'] }));
  });
  let state = { enabled: true, dir: root, personalDir: root, latest: 'a'.repeat(40), behind: 2, checkedAt: Date.now(),
    changes: [{ sha: 'a'.repeat(40), subject: 'Author improvement <not HTML>' }] };
  let postChecks = 0;
  await context.route('**/api/git/author-updates**', route => {
    if (route.request().method() === 'POST') postChecks++;
    return route.fulfill({ json: state });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  const floor = await page.evaluate(() => window.__office.store.floor);
  // APIRequestContext bypasses UI mocks and exercises authentication, origin and floor guards.
  assert.equal((await context.request.post(`${url}/api/git/author-updates/check?floor=${floor}`)).status(), 403);
  assert.deepEqual(await (await context.request.get(`${url}/api/git/author-updates?floor=${floor}`)).json(), { enabled: false });
  assert.equal((await context.request.get(`${url}/api/git/author-updates?floor=missing`)).status(), 404);
  const board = () => page.evaluate(() => {
    const o = window.__office.office;
    const m = o.group.children.find(x => x.userData.interact?.kind === 'authorUpdates');
    // The board's reservation: on the north wall over the gong (x 11.8), above the gong's own (which starts at the floor).
    const mine = o.fixtures().find(f => f.wall === 'north' && f.u0 < 11.8 && f.u1 > 11.8 && f.y0 > 2.5);
    // Nothing else on this floor claims the same stretch of wall: the elevator, the gong, the Reception kiosk…
    const clash = mine && o.fixtures().filter(f => f !== mine && f.wall === mine.wall && f.u0 < mine.u1 && mine.u0 < f.u1 && f.y0 < mine.y1 && mine.y0 < f.y1);
    return { visible: m.visible, off: m.userData.interact.off, reserved: !!mine, clear: !clash?.length };
  });
  await page.getByRole('button', { name: 'Author updates', exact: true }).waitFor();
  assert.deepEqual(await board(), { visible: true, off: false, reserved: true, clear: true });
  const shots = path.join(codeDir, 'tmp/author-updates');
  await mkdir(shots, { recursive: true });
  await page.evaluate(() => {
    const p = window.__office.player;
    p.setView('first');
    p.pos.set(11.8, 0, -8.5);
    p.camYaw = 0;
    p.lookPitch = 0.49;
  });
  await pause(600);
  await page.screenshot({ path: path.join(shots, 'updates-wall.png') });
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Author updates', exact: true });
  await dialog.waitFor();
  await page.evaluate(() => window.__office.player.setView('third'));
  await page.getByRole('heading', { name: '2 new author updates', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /2 new author updates/);
  assert.match(await dialog.innerText(), /Author improvement <not HTML>/);
  await dialog.screenshot({ path: path.join(shots, 'updates-panel.png') });
  await page.getByRole('button', { name: 'Merge with a worker', exact: true }).click();
  await page.getByRole('dialog', { name: 'Merge author updates', exact: true }).waitFor();
  const prompt = await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue();
  assert.match(prompt, /upstream\/main -> main/);
  assert.match(prompt, /npm test, npm run typecheck and npm run build/);
  // Cancel before any provider call; no workers are spawned and no Git branches are changed.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  state = { ...state, merging: true, conflicts: ['src/app.ts'] };
  await page.getByRole('button', { name: 'Author updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve / continue with a worker', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Merge needs attention', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /src\/app.ts/);
  await page.getByRole('button', { name: 'Resolve / continue with a worker', exact: true }).click();
  await page.getByRole('dialog', { name: 'Resolve author update conflicts', exact: true }).waitFor();
  assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /verify MERGE_HEAD/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  state = { enabled: true, dir: root, error: 'Network unavailable' };
  await page.getByRole('button', { name: 'Author updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Network unavailable' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Merge with a worker', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  state = { enabled: true, dir: root, behind: 0, checkedAt: Date.now(), changes: [] };
  await page.getByRole('button', { name: 'Author updates', exact: true }).click();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await page.getByRole('heading', { name: 'Up to date with author', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Merge with a worker', exact: true }).isDisabled(), true);
  // Floor transition immediately hides the board, its interaction and the HUD entry.
  state = { enabled: false };
  await page.evaluate(() => { window.__office.store.floor = 'different-floor'; window.__office.store.emit('floor'); });
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await board(), { visible: false, off: true, reserved: false, clear: true });
  assert.equal(await page.getByRole('button', { name: 'Author updates', exact: true }).count(), 0);
  assert.ok(postChecks >= 3);
  assert.deepEqual(errors, []);
  console.log('PASS: wall scope, update list, merge/conflict worker prompts, offline/up-to-date states, floor switch, authenticated API and origin checks. No workers launched.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-author-ui-'));
  await rm(root, { recursive: true, force: true });
}
