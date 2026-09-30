// npm run build && node tests/project-signs-ui.mjs
// Isolated local floors; no agents, repository clones or live office state.
// Optional argument: a saved floors.json. Copy only its discovered logo bytes into temporary
// floors to verify the real launchers' PNG/ICO/SVG artwork without opening the live projects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readProjectLogo } from '../dist/server/server/project-logo.js';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'office-signs-ui-'));
const shots = path.join(codeDir, '.agent-office/verification/floor-signage');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let host, browser;
let logs = '';
try {
  const officeDir = path.join(root, 'Sketchbook');
  await mkdir(officeDir);
  await mkdir(shots, { recursive: true });
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, officeDir, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stdout.on('data', (data) => { logs += data; });
  host.stderr.on('data', (data) => { logs += data; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then((r) => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'isolated built server starts');
  assert.equal((await fetch(url + '/api/floors/sketchbook/logo')).status, 401);
  browser = await chromium.launch({
    ...(process.env.AGENT_OFFICE_TEST_BROWSER ? { executablePath: process.env.AGENT_OFFICE_TEST_BROWSER } : { channel: process.platform === 'win32' ? 'msedge' : 'chromium' }),
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  assert.equal((await context.request.get(url + '/api/floors/sketchbook/logo')).status(), 404);
  assert.equal((await context.request.get(url + '/api/floors/unknown/logo')).status(), 404);
  const svg = await readFile(path.join(codeDir, 'src/client/public/favicon.svg'), 'utf8');
  const addFloor = async (name, image, asset = 'public/logo.svg') => {
    const dir = path.resolve(root, name);
    assert.equal(path.dirname(dir), root, 'fixture floor stays inside the temporary building');
    await mkdir(path.dirname(path.join(dir, asset)), { recursive: true });
    if (image) await writeFile(path.join(dir, asset), image);
    const response = await context.request.post(url + '/api/floors/local', { headers: { Origin: url }, data: { dir } });
    assert.equal(response.status(), 200);
    return (await response.json()).floor;
  };
  const branded = await addFloor('Agent Office', svg);
  const longName = 'a-repository-with-a-very-long-unbroken-name-that-must-still-fit-on-every-door-and-whiteboard-sign-12345';
  const long = await addFloor(longName);
  const broken = await addFloor('Broken Logo', 'not an SVG');
  const twoLines = await addFloor('Autonomous Dev Projects', svg);
  const localLogos = [];
  if (process.argv[2]) {
    const types = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/x-icon': 'ico', 'image/webp': 'webp', 'image/jpeg': 'jpg' };
    for (const floor of JSON.parse(await readFile(process.argv[2], 'utf8'))) {
      const logo = readProjectLogo(floor.dir);
      assert.ok(logo, `${floor.name} has a discovered logo`);
      const id = await addFloor(floor.name, logo.bytes, `.agent-office/logo.${types[logo.type]}`);
      localLogos.push({ id, name: floor.name, logo });
    }
  }
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Signage test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
    // Record only this feature's canvas lettering, so the check also catches clipped long names.
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.width === 1536 && this.canvas.height === 384 && args[2] === 1536) this.canvas.signText = [];
      return fillRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas.signText) {
        const metrics = this.measureText(text);
        this.canvas.signText.push({ text, x, y, width: metrics.width, top: y - metrics.actualBoundingBoxAscent, bottom: y + metrics.actualBoundingBoxDescent });
      }
      return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.evaluate(() => document.fonts.ready);
  const ride = async (id) => {
    await page.evaluate((floor) => window.__office.ride(floor), id);
    await page.waitForFunction((floor) => window.__office.store.floor === floor && window.__office.office.elevator.open, id);
  };
  const assertTitleSpacing = (sign) => {
    const header = sign.text.find((t) => t.x === 380 && t.y === 94);
    const title = sign.text.filter((t) => t.x === 380 && t.y > 94);
    assert.ok(title.every((t) => t.top > header.bottom + 8 && t.bottom < 340), 'title clears the floor label and bottom trim');
  };
  const snapshot = () => page.evaluate(() => {
    const signs = [];
    window.__office.office.group.traverse((object) => {
      if (object.name.startsWith('project-sign-') && object.isGroup) signs.push(object);
    });
    const textures = signs.map((sign) => sign.getObjectByName('project-sign-face').material.map);
    const canvas = textures[0].image;
    return {
      signs: signs.map((s) => s.name), shared: textures.every((t) => t === textures[0]),
      pixels: canvas.toDataURL(), text: canvas.signText,
      trim: signs[0].children[0].material.color.getHexString(),
      logo: window.__office.store.project.logo,
    };
  });
  const initial = await snapshot();
  assert.equal(initial.signs.length, 9);
  assert.ok(initial.shared);
  assert.ok(initial.text.some((t) => t.text === 'Sketchbook'));
  assert.ok(initial.text.some((t) => t.text === 'SK'));
  await ride(branded);
  await page.waitForFunction(() => {
    const canvas = window.__office.office.group.getObjectByName('project-sign-face').material.map.image;
    return !canvas.signText.some((t) => t.text === 'AO');
  });
  const brand = await snapshot();
  assert.notEqual(brand.trim, initial.trim, 'sign trim follows the floor palette');
  assert.ok(brand.text.some((t) => t.text === 'Agent Office'));
  const image = await context.request.get(url + brand.logo);
  assert.equal(image.status(), 200);
  assert.equal(await image.text(), svg);
  assert.match(image.headers()['content-security-policy'], /sandbox/);
  assert.match(image.headers()['cache-control'], /private/);
  assert.equal((await fetch(url + brand.logo)).status, 401);
  assert.equal(await page.evaluate(() => window.__office.office.whiteboard.group.userData.interact.kind), 'whiteboard');
  const photograph = async (name, eye, target) => {
    await page.evaluate(({ eye, target }) => {
      const { player, camera, sky } = window.__office;
      sky.show({ hour: 12, weather: 'clear' });
      player.updateCamera = () => { camera.position.set(...eye); camera.lookAt(...target); };
    }, { eye, target });
    await pause(300);
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  };
  await photograph('whiteboard-front', [5.4, 3.25, 1.5], [5.4, 2.3, -5.4]);
  await photograph('whiteboard-back', [5.4, 2.3, -9.5], [5.4, 1.8, -5.4]);
  await photograph('elevator', [8.5, 3, -5.9], [8.5, 2.1, -10.6]);
  await photograph('exit', [-13, 3, 6.5], [-18, 2.4, 6.5]);
  await photograph('balcony', [-4, 3, 7], [-4, 2.4, 13]);
  await photograph('loft', [6, 5, 10.7], [9, 5, 12.1]);
  await ride(long);
  const plain = await snapshot();
  assert.equal(plain.logo, undefined);
  assert.equal(plain.text.filter((t) => t.x === 380 && t.y > 94).map((t) => t.text).join(''), longName);
  assert.ok(plain.text.filter((t) => t.x === 380).every((t) => t.x + t.width <= 1469));
  await photograph('long-name', [5.4, 3.25, 1.5], [5.4, 2.3, -5.4]);
  await ride(twoLines);
  const wrapped = await snapshot();
  assert.equal(wrapped.text.filter((t) => t.x === 380 && t.y > 94).length, 2);
  assertTitleSpacing(wrapped);

  // Hold a real floor's image response, leave it, then deliver it after the next floor is visible.
  let held;
  await page.route(`**/api/floors/${branded}/logo*`, (route) => { held = route; });
  await ride(branded);
  for (let i = 0; i < 30 && !held; i++) await pause(100);
  assert.ok(held, 'logo request is held');
  await ride(long);
  const beforeLate = await snapshot();
  await held.fulfill({ contentType: 'image/svg+xml', body: svg });
  await pause(300);
  assert.equal((await snapshot()).pixels, beforeLate.pixels, 'late logo cannot leak onto a different floor');
  await page.unroute(`**/api/floors/${branded}/logo*`);
  await ride(broken);
  await pause(300);
  assert.ok((await snapshot()).text.some((t) => t.text === 'BL'), 'failed decoding keeps the initials');
  const version = await page.evaluate(() => window.__office.office.group.getObjectByName('project-sign-face').material.map.version);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__office.store.emit('floors'); });
  assert.equal(await page.evaluate(() => window.__office.office.group.getObjectByName('project-sign-face').material.map.version), version, 'worker-count broadcasts do not redraw signage');
  const gallery = [];
  for (const { id, name, logo } of localLogos) {
    await ride(id);
    await page.waitForFunction(() => {
      const canvas = window.__office.office.group.getObjectByName('project-sign-face').material.map.image;
      // Initials are centered at x=192; only the name/floor lettering remains after image load.
      return !canvas.signText.some((t) => t.x === 192);
    });
    const sign = await snapshot();
    assert.equal(sign.signs.length, 9, name);
    assert.ok(sign.shared);
    assertTitleSpacing(sign);
    const response = await context.request.get(url + sign.logo);
    assert.equal(response.status(), 200, name);
    assert.equal(response.headers()['content-type'], logo.type, name);
    assert.deepEqual(await response.body(), logo.bytes, name);
    gallery.push({ name, pixels: sign.pixels });
    console.log(`PASS: ${name} logo is served and rendered on every plaque (${logo.type}).`);
  }
  if (gallery.length) {
    const preview = await context.newPage();
    await preview.setContent('<html><body style="margin:24px;background:#eee9df;display:grid;grid-template-columns:1fr 1fr;gap:16px"></body></html>');
    await preview.evaluate(async (items) => {
      for (const { name, pixels } of items) {
        const image = document.createElement('img');
        image.src = pixels;
        image.alt = name;
        image.style.width = '100%';
        document.body.append(image);
      }
      await Promise.all([...document.images].map((image) => image.decode()));
    }, gallery);
    await preview.screenshot({ path: path.join(shots, 'launcher-logos.png'), fullPage: true });
    await preview.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 9 plaques, shared textures, authenticated local logos, floor palettes, initials, long names, floor rides, delayed image race, broken images, stable broadcasts and whiteboard interaction.');
  console.log(`Screenshots: ${shots}`);
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-signs-ui-'));
  await rm(root, { recursive: true, force: true });
}
