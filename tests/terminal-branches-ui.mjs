// npm run build, then node tests/terminal-branches-ui.mjs [screenshot.png].
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-branch-ui-'));
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
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Branch Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.getByRole('button', { name: /Workers/ }).click();
  async function openWorker(deskId, worktree) {
    await page.evaluate(({ deskId, worktree }) => window.__office.net.send({ t: 'worker.spawn', deskId, worktree, kind: 'agent', provider: 'custom' }), { deskId, worktree });
    await page.waitForFunction(id => [...window.__office.store.workers.values()].some(w => w.deskId === id), deskId);
    const worker = await page.evaluate(id => [...window.__office.store.workers.values()].find(w => w.deskId === id), deskId);
    await page.evaluate(() => document.exitPointerLock());
    await page.locator('#workers li').filter({ hasText: worker.name }).click();
    return worker;
  }
  await openWorker('desk-1', false);
  let dialog = page.getByRole('dialog', { name: 'Pixel terminal', exact: true });
  await dialog.getByText('Branch: main', { exact: true }).waitFor();
  git(floor, 'switch', '-c', 'personal');
  await dialog.getByText('Branch: personal', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close terminal', exact: true }).click();
  const worker = await openWorker('desk-2', true);
  dialog = page.getByRole('dialog', { name: `${worker.name} terminal`, exact: true });
  await dialog.getByText(`Branch: ${worker.worktree.branch}`, { exact: true }).waitFor();
  const checkout = path.join(floor, worker.worktree.path);
  git(checkout, 'switch', '-c', 'feature/live-terminal-branch');
  await dialog.getByText('Branch: feature/live-terminal-branch', { exact: true }).waitFor();
  assert.equal(git(floor, 'branch', '--show-current'), 'personal');
  if (process.argv[2]) await dialog.screenshot({ path: path.resolve(process.argv[2]) });
  git(checkout, 'switch', '--detach');
  await dialog.getByText(`Branch: Detached HEAD · ${git(checkout, 'rev-parse', '--short', 'HEAD')}`, { exact: true }).waitFor();
  // Simulate an older running server: updates never include the new branches field.
  await dialog.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await page.evaluate(() => {
    const store = window.__office.store;
    const apply = store.apply.bind(store);
    store.apply = msg => {
      if (msg.worker) delete msg.worker.branches;
      for (const worker of msg.workers ?? []) delete worker.branches;
      apply(msg);
    };
    for (const worker of store.workers.values()) delete worker.branches;
  });
  await page.locator('#workers li').filter({ hasText: worker.name }).click();
  await dialog.getByText(`Branch: ${worker.worktree.branch} (last known)`, { exact: true }).waitFor();
  await dialog.getByText('Live updates unavailable. Restart Agent Office after active work finishes to load branch reporting.', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Checking branch…', { exact: true }).count(), 0);
  // Even without saved metadata, a missing response gets a useful end state.
  await dialog.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await page.evaluate(() => {
    const store = window.__office.store;
    store.project.branch = undefined;
    const apply = store.apply.bind(store);
    store.apply = msg => {
      if (msg.project) msg.project.branch = undefined;
      apply(msg);
    };
  });
  await page.locator('#workers li').filter({ hasText: 'Pixel' }).click();
  dialog = page.getByRole('dialog', { name: 'Pixel terminal', exact: true });
  await dialog.getByText('Live branch unavailable', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Checking branch…', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: terminal badges show shared/worktree branches, refresh live after switches, identify detached HEAD, and recover from missing older-server reports.');
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office-branch-ui-'));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
