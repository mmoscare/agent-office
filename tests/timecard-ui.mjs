// npm run build, then node tests/timecard-ui.mjs [screenshot.png].
// An isolated office with idle Node fixtures; no AI provider or live office is used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-timecard-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, browser;
let hostErrors = '';
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Time Card UI Test');
  git(floor, 'config', 'user.email', 'timecard-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Time card fixture ready\\r\\n'); process.stdin.resume();");
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  host.stderr.on('data', data => { hostErrors = (hostErrors + data).slice(-4000); });
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(15000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Time Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
    // This browser's clock runs three hours fast: the card goes by the office's clock, which stamped the stints.
    const browserNow = Date.now;
    Date.now = () => browserNow.call(Date) + 3 * 3_600_000;
  });
  const page = await context.newPage();
  // Keep both notices present: they previously escaped the HUD and could cover dialog controls.
  await page.route('**/api/git/office**', route => route.fulfill({ json: { office: {
    dir: codeDir, branch: 'personal', ahead: 0, behind: 0, dirty: 0,
    startedAt: Date.now(), target: 'timecard-ui-fixture', floors: [],
    needs: { pull: false, build: true, restart: false },
  }, state: {
    // The update bar reads the walkthrough's state (/api/git/office/update): a build still to do.
    appDir: codeDir, target: 'timecard-ui-fixture', admin: true, prs: [], otherCommits: 0, floors: [],
    app: { behind: 0, ahead: 0, dirty: [], head: 'timecard-ui-fixture' }, packages: { needed: false, runtime: false, changes: [], staged: false },
    build: { state: 'idle' }, running: { startedAt: Date.now() }, restart: { available: true }, busy: [], outcomes: {},
    steps: { floor: 'done', app: 'done', packages: 'skipped', build: 'todo', restart: 'todo' },
  } } }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  // Once the page has the office's clock from a ping, it keeps time by that.
  await page.waitForFunction(() => window.__office?.store.floor && window.__office.store.timecard.open && window.__office.store.clock);

  // The card lies on the boss's desk, and clicking it (a real raycast) opens it.
  await page.evaluate(() => { window.__office.player.update = () => {}; window.__office.player.updateCamera = () => {}; });
  await pause(200);
  const point = await page.evaluate(() => {
    const o = window.__office;
    const card = o.office.group.getObjectByName('indirect-time-card');
    const p = card.getWorldPosition(card.position.clone());
    o.player.pos.set(p.x, p.y - 0.83, p.z + 1.6);
    o.camera.position.set(p.x - 0.9, p.y + 1.1, p.z + 1.5);
    o.camera.lookAt(p.x, p.y, p.z);
    o.camera.updateMatrixWorld();
    o.renderer.render(o.scene, o.camera);
    p.y += 0.01;
    p.project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2, kind: card.userData.interact.kind };
  });
  assert.equal(point.kind, 'timecard');
  if (process.argv[2]) await page.screenshot({ path: process.argv[2].replace('.png', '-desk.png') });
  await page.mouse.click(point.x, point.y);
  const dialog = page.getByRole('dialog', { name: 'Indirect Time', exact: true });
  await dialog.getByText('Time Test · clocked in', { exact: true }).waitFor();
  const today = dialog.locator('.timecard-day.today');
  await today.locator('.timecard-spans', { hasText: /–now$/ }).waitFor();
  assert.equal(await dialog.locator('.timecard-day').count(), 14);
  assert.equal(await dialog.locator('.timecard-total strong').first().textContent(), '0m');

  // The CSV remains clickable with the delayed Receptionist reminder and update banner showing.
  await page.waitForFunction(() => document.querySelector('.mail-nag')?.parentElement?.id === 'hud');
  await page.waitForFunction(() => document.querySelector('.update-bar:not([hidden])')?.parentElement?.id === 'app');
  // The CSV is one row per stint, for a timesheet.
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: '⬇️ CSV' }).click()]);
  const csv = readFileSync(await download.path(), 'utf8').trim().split(/\r\n/);
  assert.equal(csv[0], 'Date,Clock in,Clock out,Hours');
  assert.match(csv[1], /^\d{4}-\d\d-\d\d,\d\d:\d\d,\d\d:\d\d,0\.\d\d$/);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await page.setViewportSize({ width: 480, height: 800 });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  const [mobileDownload] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /CSV/ }).click()]);
  assert.equal(readFileSync(await mobileDownload.path(), 'utf8').split(/\r\n/)[0], 'Date,Clock in,Clock out,Hours');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Walking up: at the desk's front right it's the card (not the boss's chair or the manual shelf); at its right end, still the Office Ledger.
  const hint = page.locator('#hint');
  const standAt = (kind, dx, dz) => page.evaluate(([kind, dx, dz]) => {
    const o = window.__office;
    let thing;
    o.office.group.traverse(obj => { if (obj.userData.interact?.kind === kind) thing = obj; });
    const p = thing.getWorldPosition(thing.position.clone());
    o.player.pos.set(p.x + dx, p.y - 0.83, p.z + dz);
  }, [kind, dx, dz]);
  await standAt('timecard', 0.45, 0.65);
  await hint.getByText('Today 0m in the office', { exact: true }).waitFor();
  await standAt('ledger', 0.8, 0);
  await hint.getByText('📒 The Office Ledger', { exact: true }).waitFor();

  // A reload is the same stint, not a new one; a second tab doesn't double up.
  const start = await page.evaluate(() => window.__office.store.timecard.stints.at(-1).start);
  await page.reload();
  await page.waitForFunction(() => window.__office?.store.floor && window.__office.store.timecard.open);
  const second = await context.newPage();
  await second.goto(url);
  await second.waitForFunction(() => window.__office?.store.timecard.open);
  await second.close();
  const after = await page.evaluate(() => window.__office.store.timecard.stints);
  assert.equal(after.length, 1);
  assert.equal(after[0].start, start);

  // The same card is on the boss's desk on every floor, and in the ☰ menu.
  const other = path.join(root, 'second'); mkdirSync(other);
  const added = await context.request.post(url + '/api/floors/local', { headers: { Origin: url }, data: { dir: other } });
  assert.equal(added.status(), 200);
  const otherId = (await added.json()).floor;
  await page.evaluate(id => window.__office.net.send({ t: 'floor.go', floor: id }), otherId);
  await page.waitForFunction(id => window.__office.store.floor === id, otherId);
  assert.equal(await page.evaluate(() => window.__office.office.group.getObjectByName('indirect-time-card')?.userData.interact.kind), 'timecard');
  await page.evaluate(() => document.exitPointerLock());
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /Indirect Time/ }).click();
  await dialog.getByText('Time Test · clocked in', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(errors.length, 0, errors.join('\n'));

  // Closing the last window clocks out; stopping the office keeps the card on disk.
  await browser.close(); browser = null;
  await pause(300);
  host.stdin.write('stop\n');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Host did not stop')), 15000); host.once('exit', () => { clearTimeout(timer); resolve(); }); });
  assert.equal(host.exitCode, 0, hostErrors);
  const disk = JSON.parse(readFileSync(path.join(floor, '.agent-office/timecard.json'), 'utf8'));
  const people = Object.entries(disk.people);
  assert.equal(people.length, 1);
  assert.equal(people[0][0], 'name:time test');
  assert.equal(people[0][1].stints.length, 1);
  assert.equal(people[0][1].stints[0].start, start);
  assert.ok(people[0][1].stints[0].end > start);
  console.log('PASS: desk card click on every floor, live today row, CSV export, reload/second tab keep one stint, menu entry, mobile layout, clean browser, card saved on disk after stop.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-timecard-ui-'));
  rmSync(root, { recursive: true, force: true });
}
