// npm run build, then node tests/ledger-ui.mjs [screenshot.png].
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-ledger-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, browser;
let hostErrors = '';
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Ledger Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  assert.equal((await fetch(url + '/api/ledger')).status, 401);
  const response = await context.request.get(url + '/api/ledger');
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).codex.sessions, 0);
  await page.evaluate(() => { window.__office.player.update = () => {}; window.__office.player.updateCamera = () => {}; });
  await pause(200);
  const open = async () => {
    const point = await page.evaluate(() => {
      const o = window.__office;
      let book;
      o.office.group.traverse(obj => { if (obj.userData.interact?.kind === 'ledger') book = obj; });
      const p = book.getWorldPosition(book.position.clone());
      o.player.pos.set(p.x, p.y - .83, p.z + 1.9);
      o.camera.position.set(p.x, p.y + 1.5, p.z + 1.5);
      o.camera.lookAt(p);
      o.camera.updateMatrixWorld();
      o.renderer.render(o.scene, o.camera);
      p.y += .04;
      p.project(o.camera);
      const r = o.renderer.domElement.getBoundingClientRect();
      return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'The Office Ledger', exact: true });
  await dialog.locator('.row.foot').waitFor().catch(async error => { console.error('Dialogs:', await page.locator('[role=dialog]').allTextContents(), 'Errors:', errors); await page.screenshot({ path: '.agent-office/ledger-debug.png' }); throw error; });
  assert.match(await dialog.locator('.total').first().locator('small').textContent(), /^\u2265 .* a year$/);
  await dialog.getByRole('combobox', { name: 'Codex (ChatGPT) plan', exact: true }).selectOption('none');
  assert.match(await dialog.locator('.total').nth(1).locator('small').textContent(), /^\u2265 .* a year$/);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // A missing report on any floor makes both totals lower bounds, even if Codex is known.
  let unavailable = false;
  let requests = 0;
  const facts = {
    claude: { today: 0, total: 0, calls: 0 },
    codex: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0, sessions: 1 },
    opencode: { cost: 0, sessions: 0, unknown: 1 },
  };
  await page.route('**/api/ledger', route => {
    requests++;
    return route.fulfill({ status: unavailable ? 503 : 200, contentType: 'application/json', body: JSON.stringify(facts) });
  });
  await open();
  await dialog.locator('.row.foot').waitFor();
  const oc = dialog.locator('.row').filter({ has: page.getByText('OpenCode workers', { exact: true }) });
  assert.deepEqual(await oc.locator('.num').allTextContents(), ['n/a', 'n/a']);
  assert.match(await dialog.locator('.verdict').textContent(), /unavailable/);
  for (const text of await dialog.locator('.total small').allTextContents()) assert.match(text, /^\u2265 /);
  unavailable = true;
  await dialog.getByText('Office usage is unavailable. Retrying...', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.total').count(), 0, 'failed refresh never leaves stale complete totals');
  unavailable = false;
  facts.opencode = { cost: 1, sessions: 1, unknown: 0 };
  await dialog.locator('.row.foot').waitFor();
  assert.match(await oc.locator('.num').first().textContent(), /\$/);
  for (const text of await dialog.locator('.total small').allTextContents()) assert.doesNotMatch(text, /^\u2265 /);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const before = requests;
  await pause(5300);
  assert.equal(requests, before, 'closing the book stops polling');
  assert.deepEqual(errors, []);
  console.log('PASS: authenticated ledger API, book click, unknown OpenCode, annual lower bounds, refresh failure/recovery and close cleanup.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-ledger-ui-'));
  rmSync(root, { recursive: true, force: true });
}
