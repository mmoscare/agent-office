// npm run build, then node tests/server-down-ui.mjs [screenshot.png]. Stops and restarts a temporary office.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-server-down-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const password = randomUUID();
let host, browser;
let errors = '';
function start(port) {
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
}
async function healthy(url) {
  for (let i = 0; i < 150; i++) {
    assert.equal(host.exitCode, null, errors);
    if (await fetch(url + '/api/health').then(r => r.ok, () => false)) return;
    await pause(100);
  }
  throw new Error('The office did not start\n' + errors);
}
async function stop() {
  const was = host; host = undefined;
  if (!was || was.exitCode !== null) return;
  const exited = new Promise(resolve => was.once('exit', resolve));
  was.kill(); await exited;
}
try {
  mkdirSync(floor);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  start(port); await healthy(url);
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } }); context.setDefaultTimeout(20000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Down Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => window.__office?.store.floor && window.__office.net.up);
  const alarm = page.getByRole('alertdialog', { name: 'Lost connection to the office server' });
  assert.equal(await alarm.isVisible(), false);
  assert.doesNotMatch(await page.title(), /OFFLINE/);

  // The server goes away: the whole screen says so, over everything, and counts up.
  await stop();
  await alarm.waitFor({ state: 'visible' });
  assert.match(await page.title(), /^⚠️ OFFLINE · /);
  assert.ok(await alarm.evaluate(el => el.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)) && el.contains(document.elementFromPoint(5, 5))));
  assert.ok(await alarm.getByRole('button', { name: 'Retry now' }).evaluate(el => el === document.activeElement));
  const since = () => alarm.locator('.server-down-since').textContent();
  const first = await since(); await pause(2100);
  assert.notEqual(await since(), first);
  await alarm.getByText(/Trying to reconnect… \(\d+ tr(y|ies) so far\)/).waitFor();
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

  // Back again: Retry now picks it up without waiting out the backoff, and the screen clears by itself.
  start(port); await healthy(url);
  await alarm.getByRole('button', { name: 'Retry now' }).click();
  await alarm.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText(/Back online — the office server was unreachable for \d+s/).waitFor();
  assert.doesNotMatch(await page.title(), /OFFLINE/);
  await page.waitForFunction(() => window.__office.net.up && window.__office.store.floor);

  // A server that stops answering without hanging up: the page notices, hangs up, and connects again.
  const stale = await page.evaluateHandle(() => window.__office.net.ws);
  await page.evaluate(() => { window.__office.net.ws.onmessage = () => {}; });
  await page.waitForFunction(old => window.__office.net.ws !== old && window.__office.net.up, stale, { timeout: 30000 });

  assert.deepEqual(pageErrors, []);
  console.log('server-down UI: ok');
} finally {
  await browser?.close().catch(() => {});
  await stop().catch(() => {});
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
