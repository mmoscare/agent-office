// npm run build, then node tests/console-ui.mjs [screenshot.png].
// Windows browser integration: an isolated office, no workers or live office used.
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
const root = mkdtempSync(path.join(os.tmpdir(), 'office-console-ui-'));
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

  const dialog = page.getByRole('dialog', { name: 'Standalone terminal', exact: true });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await dialog.getByText(`Started in: ${floor}`, { exact: true }).waitFor();
  async function command(text, expected) {
    await page.waitForFunction(() => /PS [^>]+>/.test(document.querySelector('[aria-label="Standalone terminal"] .xterm-screen')?.textContent ?? ''));
    await dialog.locator('.xterm-screen').click();
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('[aria-label="Standalone terminal"]');
      const ta = dialog?.querySelector('.xterm-helper-textarea');
      if (!dialog || !(ta instanceof HTMLElement)) return false;
      const box = dialog.getBoundingClientRect();
      const input = ta.getBoundingClientRect();
      return document.activeElement === ta && input.left >= box.left - 2 && input.top >= box.top - 2 && input.left <= box.right && input.top <= box.bottom;
    }), true);
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
    try {
      await page.waitForFunction(expected => document.querySelector('[aria-label="Standalone terminal"] .xterm-screen')?.textContent.includes(expected), expected);
    } catch (error) {
      console.error('Expected:', expected, 'Screen:', await dialog.innerText());
      throw error;
    }
  }
  await command("Write-Output ('PSVERSION_' + $PSVersionTable.PSVersion.Major)", 'PSVERSION_');
  await command("cd ..; $global:officeConsoleTest = 'kept'; Write-Output ('LOCATION_' + (Get-Location).Path)", 'LOCATION_' + root);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 1);
  await dialog.getByRole('button', { name: 'Close standalone terminal', exact: true }).click();
  await page.keyboard.press('Control+Backquote');
  await dialog.getByText(`Started in: ${floor}`, { exact: true }).waitFor();
  await command("Write-Output ('REOPEN_' + $officeConsoleTest + '_' + (Get-Location).Path)", 'REOPEN_kept_' + root);
  await page.setViewportSize({ width: 1100, height: 800 });
  await command("Write-Output ('RESIZE_' + 'OK')", 'RESIZE_OK');
  await dialog.getByRole('button', { name: 'New shell here', exact: true }).click();
  await dialog.getByText(`Started in: ${floor}`, { exact: true }).waitFor();
  await command("Write-Output ('RESET_' + (Get-Location).Path)", 'RESET_' + floor);
  await command("Write-Output ('ISOLATED_' + [string]::IsNullOrEmpty($officeConsoleTest))", 'ISOLATED_True');
  await dialog.locator('.xterm-screen').click();
  await page.keyboard.insertText('exit');
  await page.keyboard.press('Enter');
  await dialog.getByText('Shell exited. Press Enter to start a new shell in the current floor folder.', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await dialog.getByText(`Started in: ${floor}`, { exact: true }).waitFor();
  await command("Write-Output ('RESTART_' + 'OK')", 'RESTART_OK');
  // Force a genuine socket reconnect with the terminal still open.
  const oldId = await page.evaluate(() => window.__office.store.you);
  await page.evaluate(() => window.__office.net.ws.close());
  await page.waitForFunction(old => window.__office.store.you !== old, oldId);
  await dialog.getByText(`Started in: ${floor}`, { exact: true }).waitFor();
  await command("Write-Output ('RECONNECT_' + 'OK')", 'RECONNECT_OK');
  assert.equal(await page.evaluate(() => window.__office.store.workers.size), 0);
  if (process.argv[2]) await dialog.screenshot({ path: path.resolve(process.argv[2]) });
  assert.deepEqual(errors, []);
  console.log('PASS: standalone PowerShell opens without a worker; navigation, reopen, Escape, resize, fresh shell, exit/restart and reconnect work.');
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office-console-ui-'));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
