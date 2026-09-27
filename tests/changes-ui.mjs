// Windows browser smoke check: npm run build, then node tests/changes-ui.mjs [screenshot.png].
// Uses temporary repositories and an idle Node fixture, never an AI provider or the live office.
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-changes-ui-'));
const floor = path.join(root, 'Portfolio');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, browser;
try {
  mkdirSync(floor);
  for (const name of ['backend', 'frontend']) {
    const dir = path.join(floor, name);
    mkdirSync(dir);
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'Panel UI Test');
    git(dir, 'config', 'user.email', 'panel-ui@example.invalid');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    writeFileSync(path.join(dir, 'app.txt'), 'original\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Initial');
    writeFileSync(path.join(dir, 'app.txt'), name + ' panel edit\n');
  }
  writeFileSync(path.join(floor, 'frontend/new file.txt'), 'new panel file\n');
  const fixture = path.join(root, 'idle-fixture.cjs');
  writeFileSync(fixture, "process.stdout.write('Panel fixture ready\\r\\n'); process.stdin.resume();");
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  // Give this test's server a private shutdown channel on Windows as well as Unix.
  const hostFile = path.join(root, 'host.mjs');
  writeFileSync(hostFile, [
    "import { pathToFileURL } from 'node:url';",
    "import { createInterface } from 'node:readline';",
    "const [cli, project, port] = process.argv.slice(2);",
    "process.argv = [process.execPath, cli, project, '--port', port];",
    "await import(pathToFileURL(cli).href);",
    "const input = createInterface({ input: process.stdin });",
    "let stopping = false;",
    "const stop = () => { if (!stopping) { stopping = true; process.emit('SIGINT', 'SIGINT'); } };",
    "input.on('line', line => { if (line === 'stop') stop(); });",
    "input.on('close', stop);",
  ].join('\n'));
  host = spawn(process.execPath, [hostFile, path.join(codeDir, 'dist/server/server/cli.js'), floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath.replaceAll('\\', '/'), AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(host.exitCode, null, 'isolated server stays running');
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'built server starts');
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Panel Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.evaluate(() => window.__office.net.send({ t: 'worker.spawn', deskId: 'desk-1', kind: 'agent', provider: 'custom', worktree: false }));
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some(w => w.name === 'Pixel' && w.status === 'idle'));
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#workers li').filter({ hasText: 'Pixel' }).click();
  await page.getByRole('button', { name: /Changes/, exact: false }).filter({ hasText: '🌿' }).click();
  const panel = page.getByRole('dialog', { name: "Pixel's changes", exact: true });
  await panel.getByText('backend panel edit', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('option').count(), 3);
  assert.match(await panel.locator('header .branch').innerText(), /2 repositories/);
  await panel.getByRole('option').filter({ hasText: 'frontend/app.txt' }).click();
  await panel.getByText('frontend panel edit', { exact: true }).waitFor();
  await panel.getByRole('option').filter({ hasText: 'frontend/new file.txt' }).click();
  await panel.getByText('new panel file', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: /Commit 3 files/ }).isDisabled(), true);
  assert.equal(await panel.getByRole('button', { name: /Discard all/ }).isDisabled(), true);
  assert.equal(await panel.locator('.dh button').count(), 0);
  await panel.getByRole('option').filter({ hasText: 'frontend/app.txt' }).click();
  writeFileSync(path.join(floor, 'frontend/app.txt'), 'updated while panel is open\n');
  await panel.getByText('updated while panel is open', { exact: true }).waitFor();
  // An unreadable child must show its own error without replacing the useful file list.
  const empty = path.join(floor, 'empty');
  mkdirSync(empty); git(empty, 'init', '-b', 'main');
  await panel.getByRole('status').getByText('empty: No commits yet', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('option').count(), 3);
  if (process.argv[2]) await panel.screenshot({ path: path.resolve(process.argv[2]) });
  assert.deepEqual(errors, []);
  console.log('PASS: built panel lists both repos, opens tracked/untracked diffs, refreshes live edits, shows per-repo errors, and disables combined Git actions.');
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office-changes-ui-'));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
