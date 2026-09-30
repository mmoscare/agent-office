// npm run build, then node tests/staffer-ui.mjs [screenshot-dir].
// An isolated office with an idle Node fixture as the agent; no AI provider or live office is used.
// U on the office floor, at the loft's west edge and at the balcony railing (facing out, both), a
// click on his clipboard, and a hired staffer sent home from beside you.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : '';
const root = mkdtempSync(path.join(os.tmpdir(), 'office-staffer-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// SwiftShader draws a frame or two a second, and a frame moves him at most 0.1 s along, so the test
// walks him on itself (the same StafferSummon and Departures, with the office's own colliders).
const WALK = { timeout: 60000, polling: 100 };
let host, browser;
let hostErrors = '';
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Staffer UI Test');
  git(floor, 'config', 'user.email', 'staffer-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Staffer fixture ready\\r\\n'); process.stdin.resume();");
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
    assert.equal(host.exitCode, null, hostErrors);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, hostErrors);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  context.setDefaultTimeout(20000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Staffer Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  // You stand where the test puts you: no walking, no falling, and the camera where the test puts it.
  await page.evaluate(() => { window.__office.player.update = () => {}; window.__office.player.updateCamera = () => {}; });

  const toasts = () => page.locator('.toast').allTextContents().catch(() => []);
  const staffer = () => page.evaluate(() => {
    const s = window.__office.staffer;
    const p = s.positions()[0];
    return { phase: s.phase, at: p ? { x: p.x, y: p.y, z: p.z } : null };
  });
  /** Walks him on until he's `phase`. */
  const settle = phase => page.waitForFunction(phase => {
    const o = window.__office;
    for (let i = 0; i < 40 && o.staffer.phase !== phase; i++) o.staffer.update(0.1, o.player.pos);
    return o.staffer.phase === phase;
  }, phase, WALK);
  /** Stands you at (x, y, z) facing `facing`, with the camera over your shoulder, and presses U. */
  const summonFrom = async (x, y, z, facing) => {
    await page.evaluate(([x, y, z, facing]) => {
      const o = window.__office;
      o.player.pos.set(x, y, z);
      o.player.facing = facing;
      o.camera.position.set(x - Math.sin(facing) * 3.2, y + 3, z - Math.cos(facing) * 3.2);
      o.camera.lookAt(x + Math.sin(facing), y + 0.8, z + Math.cos(facing));
    }, [x, y, z, facing]);
    await page.keyboard.press('KeyU');
    await page.waitForFunction(() => window.__office.staffer.phase === 'to');
    await settle('here');
    return staffer();
  };
  const sendBack = async () => {
    await page.keyboard.press('KeyU');
    await page.waitForFunction(() => window.__office.staffer.phase === 'back');
    await settle('home');
  };
  /** A picture from off to one side of you and him, into the screenshot folder, if there is one. */
  const shot = async name => {
    if (!shots) return;
    await page.evaluate(() => {
      const o = window.__office;
      const p = o.player.pos;
      const s = o.staffer.positions()[0] ?? p;
      const [mx, mz] = [(p.x + s.x) / 2, (p.z + s.z) / 2];
      const [dx, dz] = [s.x - p.x, s.z - p.z];
      const d = Math.hypot(dx, dz) || 1;
      o.camera.position.set(mx - (dz / d) * 3.4 - (dx / d) * 1.2, p.y + 2.2, mz + (dx / d) * 3.4 - (dz / d) * 1.2);
      o.camera.lookAt(mx, p.y + 0.8, mz);
    });
    await pause(1500);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, name) });
  };

  // 1. On the office floor: beside you, and U again sends him back.
  const onFloor = await summonFrom(2, 0, 3, 0);
  assert.ok(Math.hypot(onFloor.at.x - 2, onFloor.at.z - 3) < 2.2, JSON.stringify(onFloor));
  assert.ok(Math.abs(onFloor.at.y + 0.07) < 0.1, JSON.stringify(onFloor));
  await shot('staffer-floor.png');

  // 2. Click his clipboard: the clipboard window opens, without prompting him. He faces you, so it's
  // looked at from your side.
  const point = await page.evaluate(() => {
    const o = window.__office;
    let board;
    o.office.group.traverse(obj => { if (obj.userData.interact?.kind === 'clipboard' && obj.visible) board = obj; });
    const p = board.getWorldPosition(board.position.clone());
    const me = o.player.pos;
    const d = Math.hypot(me.x - p.x, me.z - p.z) || 1;
    o.camera.position.set(p.x + ((me.x - p.x) / d) * 0.8, p.y + 0.3, p.z + ((me.z - p.z) / d) * 0.8);
    o.camera.lookAt(p);
    o.camera.updateMatrixWorld();
    o.renderer.render(o.scene, o.camera);
    p.project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const clipboard = page.getByRole('dialog', { name: "Queue agent's clipboard", exact: true });
  await clipboard.waitFor().catch(async error => {
    console.error('Dialogs:', await page.locator('[role=dialog]').evaluateAll(ds => ds.map(d => d.getAttribute('aria-label') || d.textContent.slice(0, 80))), 'Toasts:', await toasts());
    throw error;
  });
  // A full-page screenshot in headless Edge leaves the window out; the window's own doesn't.
  if (shots) await clipboard.screenshot({ path: path.join(shots, 'staffer-clipboard.png') });
  await clipboard.getByRole('button', { name: 'Close', exact: true }).click();
  await clipboard.waitFor({ state: 'detached' });
  await sendBack();

  // 3. At the loft's west edge, facing out through the glass: up on the loft beside you, not downstairs.
  const loft = await summonFrom(9.45, 3, 9.5, -Math.PI / 2);
  assert.ok(loft.at.x > 9.3 && loft.at.z > 8.3, `on the loft: ${JSON.stringify(loft)}`);
  assert.ok(Math.abs(loft.at.y + 0.07 - 3) < 0.1, `at the loft's height: ${JSON.stringify(loft)}`);
  assert.ok(Math.hypot(loft.at.x - 9.45, loft.at.z - 9.5) < 2.2, JSON.stringify(loft));
  await shot('staffer-loft.png');
  // Beside you, so U sends him back instead of calling him again.
  await sendBack();

  // 4. At the balcony railing, facing out: on the deck beside you, not out in the air.
  const balcony = await summonFrom(-4, 0, 16.2, 0);
  assert.ok(balcony.at.z > 13.3 && balcony.at.z < 16.7 - 0.3 && balcony.at.x > -10.2 && balcony.at.x < 2.2, `on the deck: ${JSON.stringify(balcony)}`);
  assert.ok(Math.abs(balcony.at.y + 0.07) < 0.1, `on the deck: ${JSON.stringify(balcony)}`);
  assert.ok(Math.hypot(balcony.at.x + 4, balcony.at.z - 16.2) < 2.2, JSON.stringify(balcony));
  await shot('staffer-balcony.png');
  await sendBack();

  // 5. Hire him, call him over, send him home: he packs up beside you and walks out, never flying.
  await page.evaluate(() => window.__office.net.send({ t: 'station.prompt', deskId: 'station-queue', prompt: 'What is on the queue?' }));
  await page.waitForFunction(() => [...window.__office.workerViews.values()].some(v => v.deskId === 'station-queue'));
  const hired = await summonFrom(2, 0, 3, 0);
  assert.ok(Math.hypot(hired.at.x - 2, hired.at.z - 3) < 2.2, JSON.stringify(hired));
  const walk = await page.evaluate(async () => {
    const o = window.__office;
    const [id, view] = [...o.workerViews].find(([, v]) => v.deskId === 'station-queue');
    const model = view.model;
    o.net.send({ t: 'worker.kill', workerId: id });
    // The office sends him home, and the departures take him over.
    const until = performance.now() + 30000;
    while (performance.now() < until && model.root.parent !== o.scene) await new Promise(r => setTimeout(r, 100));
    const seen = [model.root.position.clone()];
    for (let i = 0; i < 6000 && model.root.parent; i++) {
      o.departures.update(0.05, i * 0.05);
      if (model.root.parent) seen.push(model.root.position.clone());
    }
    let stride = 0;
    for (let i = 1; i < seen.length; i++) stride = Math.max(stride, Math.hypot(seen[i].x - seen[i - 1].x, seen[i].z - seen[i - 1].z));
    const kiosk = o.office.desks.get('station-queue').def;
    return { frames: seen.length, gone: !model.root.parent, stride, start: seen[0], byKiosk: Math.min(...seen.map(p => Math.hypot(p.x - kiosk.x, p.z - kiosk.z))) };
  });
  assert.ok(walk.gone, `he walked out and was gone: ${JSON.stringify(walk)}`);
  assert.ok(Math.hypot(walk.start.x - hired.at.x, walk.start.z - hired.at.z) < 0.05, `he packed up where he stood: ${JSON.stringify(walk)}`);
  assert.ok(walk.stride < 0.5, `no flying: at most ${walk.stride.toFixed(2)} m in a frame`);
  assert.ok(walk.byKiosk < 2.5, `back past his kiosk: ${JSON.stringify(walk)}`);

  assert.deepEqual(errors, []);
  console.log(`PASS: U on the floor, loft edge and balcony railing (he stands beside you each time, and U sends him back); clipboard click; a hired staffer sent home from beside you walks out (${walk.frames} frames, longest stride ${walk.stride.toFixed(2)} m). Toasts: ${JSON.stringify(await toasts())}`);
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-staffer-ui-'));
  rmSync(root, { recursive: true, force: true });
}
