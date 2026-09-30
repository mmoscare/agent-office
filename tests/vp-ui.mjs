// npm run build && node tests/vp-ui.mjs [screenshot-dir]
// A throwaway office (its own temp building, a plain-folder floor, a fake agent instead of Claude)
// driven in headless Edge: the VP waits at his kiosk, is deployed from the floor menu, reaches the
// office through office-vp, and goes on and off standing duty from the same menu. Nothing touches
// the running office, GitHub or a real agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-vp-'));
const shotDir = path.resolve(process.argv[2] ?? path.join(root, 'shots'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let host;
let browser;
let logs = '';
try {
  await mkdir(shotDir, { recursive: true });
  const officeDir = path.join(root, 'Office');
  const home = path.join(root, 'home');
  await mkdir(officeDir);
  await mkdir(home);
  // The fake agent: runs office-vp status once (the VP's own command, through the office's endpoint), then waits like an agent at its prompt.
  const said = path.join(root, 'office-vp-status.txt');
  const agent = path.join(root, 'fake-agent.mjs');
  await writeFile(
    agent,
    `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let text;
try { text = execFileSync(process.execPath, [${JSON.stringify(path.join(codeDir, 'bin', 'office-vp.js'))}, 'status'], { encoding: 'utf8' }); }
catch (e) { text = 'FAILED ' + e.message + (e.stdout ?? '') + (e.stderr ?? ''); }
writeFileSync(${JSON.stringify(said)}, text);
console.log('The fake VP is at his kiosk.');
setInterval(() => {}, 1 << 30);
`,
  );
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, officeDir, String(port)], {
    cwd: codeDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_HOME: home, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: agent, AGENT_OFFICE_NO_OPEN: '1' },
  });
  host.stdout.on('data', (d) => (logs += d));
  host.stderr.on('data', (d) => (logs += d));
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then((r) => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'the office came up');
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'VP test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, hud: { balances: false } }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor && window.__office.player.enabled);
  // Hide the update bar, which covers the menus after an agent-office merge.
  await page.addStyleTag({ content: '.update-bar{display:none!important}' });
  const lookAtKiosk = async () => {
    await page.evaluate(() => {
      const { player } = window.__office;
      player.view = 'third';
      player.pos.set(14.8, 0, 3.6);
      player.camYaw = Math.PI;
      player.camPitch = -0.12;
      player.camDist = 0.35;
      player.updateCamera(true);
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await pause(600);
  };

  // 1. The VP waits at his kiosk in the lounge before anyone deploys him.
  const kiosk = await page.evaluate(() => {
    const d = window.__office.office.desks.get('station-vp');
    return d && { x: d.def.x, z: d.def.z, vacant: d.vacancy.visible };
  });
  assert.deepEqual(kiosk, { x: 14.8, z: 7, vacant: true }, 'his kiosk is by the boss office, waiting');
  await lookAtKiosk();
  await page.screenshot({ path: path.join(shotDir, 'vp-kiosk-waiting.png') });
  console.log('PASS: the VP waits at his kiosk in the lounge.');

  // 2. The floor menu offers to deploy him, with the duty switch.
  const openMenu = async () => {
    if (!(await page.locator('.floor-menu').count())) await page.click('#project');
    await page.waitForSelector('.floor-menu .vp-section');
  };
  await openMenu();
  const section = page.locator('.floor-menu .vp-section');
  assert.match(await section.innerText(), /Deploy the VP/);
  assert.match(await section.innerText(), /On duty/);
  await section.screenshot({ path: path.join(shotDir, 'vp-menu-deploy.png') });
  await page.click('.vp-section .vp-deploy');
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some((w) => w.deskId === 'station-vp' && w.name === 'VP'));
  console.log('PASS: Deploy the VP hires him at his kiosk.');

  // 3. He reaches the office with office-vp (his own command, through /office/vp).
  for (let i = 0; i < 300 && !existsSync(said); i++) await pause(100);
  const status = readFileSync(said, 'utf8');
  assert.match(status, /Not on duty/, status);
  assert.match(status, /No stuck workers/, status);
  console.log('PASS: office-vp status answers the VP from inside his terminal.');

  // 4. Standing duty from the floor menu: on (who and when shows), a first sweep runs, then off.
  await openMenu();
  await page.waitForFunction(() => document.querySelector('.vp-section')?.getAttribute('data-vp') === 'here');
  await page.click('.vp-section .vp-duty input');
  await page.waitForFunction(() => window.__office.store.vp.duty?.on === true);
  await page.waitForFunction(() => /turned on by VP test/.test(document.querySelector('.vp-section')?.textContent ?? ''));
  await page.waitForFunction(() => !!window.__office.store.vp.lastSweep, null, { timeout: 60_000 });
  const saved = JSON.parse(readFileSync(path.join(officeDir, '.agent-office', 'vp.json'), 'utf8'));
  assert.equal(saved.duty.on, true);
  assert.equal(saved.duty.by, 'VP test');
  await page.waitForFunction(() => /Last sweep/.test(document.querySelector('.vp-section')?.textContent ?? ''));
  await page.locator('.floor-menu .vp-section').screenshot({ path: path.join(shotDir, 'vp-menu-on-duty.png') });
  console.log(`PASS: on duty (${await page.evaluate(() => window.__office.store.vp.lastSweep.summary)}), kept in vp.json with who turned it on.`);
  await page.click('.vp-section .vp-duty input');
  await page.waitForFunction(() => window.__office.store.vp.duty?.on === false);
  assert.equal(JSON.parse(readFileSync(path.join(officeDir, '.agent-office', 'vp.json'), 'utf8')).duty.on, false);
  console.log('PASS: off duty again.');

  // 5. The VP at his kiosk, hired.
  await page.keyboard.press('Escape');
  await lookAtKiosk();
  await page.screenshot({ path: path.join(shotDir, 'vp-kiosk-deployed.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS: no browser errors. Screenshots in ${shotDir}`);
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 150 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.ok(path.basename(root).startsWith('agent-office-vp-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
