// npm run build, then node tests/terminal-brief-ui.mjs [screenshot.png].
// An isolated office with an idle Node fixture; no AI provider or live office is used.
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-brief-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FIRST = 'Please add a brief summary of what I asked and what the agent is working on to the top of the terminal, any time I am clicked into an agent terminal, and keep it readable for long requests like this one.';
const LATEST = 'Also make the long request expandable';
let host, browser;
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Brief UI Test');
  git(floor, 'config', 'user.email', 'brief-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Brief fixture ready\\r\\n'); process.stdin.resume();");
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
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Brief Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.evaluate(prompt => window.__office.net.send({ t: 'worker.spawn', deskId: 'desk-1', worktree: false, kind: 'agent', provider: 'custom', prompt }), FIRST);
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some(w => w.deskId === 'desk-1' && w.ask));
  const worker = await page.evaluate(() => [...window.__office.store.workers.values()].find(w => w.deskId === 'desk-1'));
  assert.deepEqual(worker.ask, { first: FIRST });
  await page.evaluate(() => document.exitPointerLock());
  const item = page.locator('#workers li').filter({ hasText: worker.name });
  // The workers list may be tucked behind its toolbar button.
  if (!(await item.isVisible())) await page.locator('button.dock-panel').filter({ hasText: 'Workers' }).click();
  await item.click();
  const dialog = page.getByRole('dialog', { name: `${worker.name} terminal`, exact: true });
  const brief = dialog.getByRole('region', { name: 'What you asked and what it is working on' });
  await brief.getByText(FIRST, { exact: true }).waitFor();
  await brief.getByText('You asked', { exact: true }).waitFor();
  await brief.getByText('Working on', { exact: true }).waitFor();
  // The long request is cut to one line until it's expanded.
  const more = brief.getByRole('button', { name: 'More', exact: true });
  await more.waitFor();
  const oneLine = await brief.getByText(FIRST, { exact: true }).boundingBox();
  await more.click();
  await brief.getByRole('button', { name: 'Less', exact: true }).waitFor();
  const expanded = await brief.getByText(FIRST, { exact: true }).boundingBox();
  assert.ok(expanded.height > oneLine.height * 1.5, `expanded ${expanded.height} vs ${oneLine.height}`);
  await brief.getByRole('button', { name: 'Less', exact: true }).click();
  // A follow-up request is shown as the latest ask; a short reply doesn't replace it.
  await page.evaluate(({ workerId, prompt }) => window.__office.net.send({ t: 'worker.prompt', workerId, prompt }), { workerId: worker.id, prompt: LATEST });
  await brief.getByText('Latest ask', { exact: true }).waitFor();
  await brief.getByText(LATEST, { exact: true }).waitFor();
  await page.evaluate(({ workerId }) => window.__office.net.send({ t: 'worker.prompt', workerId, prompt: 'yes' }), { workerId: worker.id });
  await page.waitForFunction(id => window.__office.store.workers.get(id)?.activity === 'yes', worker.id);
  await brief.getByText(LATEST, { exact: true }).waitFor();
  assert.equal(await brief.getByText('yes', { exact: true }).count(), 0);
  if (process.argv[2]) await dialog.screenshot({ path: path.resolve(process.argv[2]) });
  // The terminal still gets the rest of the window.
  const termBox = await dialog.locator('.term-host').first().boundingBox();
  assert.ok(termBox.height > 400, `terminal height ${termBox.height}`);
  assert.deepEqual(errors, []);
  console.log('PASS: the terminal brief shows the request, the latest ask and the task, expands long requests, and keeps the terminal large.');
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office-brief-ui-'));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
