// Manual Windows smoke check: npm run build, then node tests/local-floor-ui.mjs.
// Uses an isolated temporary building and never hires agents or clones a repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-ui-'));
const officeDir = path.join(root, 'office');
const projectDir = path.join(root, 'multi repo project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host;
let browser;
let logs = '';
try {
  await mkdir(officeDir);
  await mkdir(path.join(officeDir, '.agent-office'));
  const usage = { input: 700, output: 100, reasoning: 100, cacheRead: 100, cacheWrite: 0, totalTokens: 1000, calls: 0, cost: 0, costKnown: false, callsKnown: false };
  await writeFile(path.join(officeDir, '.agent-office/model-usage.json'), JSON.stringify({ version: 1, records: [
    { key: 'codex:fixture', provider: 'codex', worker: 'Codex fixture', floor: 'Portfolio', startedAt: 123, updatedAt: 123, usage },
    { key: 'opencode:fixture', provider: 'opencode', worker: 'Grok fixture', floor: 'Dashboard', initialModel: 'xai/example', startedAt: 124, updatedAt: 124, usage: { ...usage, cost: .42, costKnown: true } },
  ] }));
  await mkdir(path.join(projectDir, 'frontend'), { recursive: true });
  await mkdir(path.join(projectDir, 'backend'));
  await writeFile(path.join(projectDir, 'keep.txt'), 'Unchanged project file');
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, officeDir, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stdout.on('data', data => { logs += data; });
  host.stderr.on('data', data => { logs += data; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'launcher host starts the built server');
  assert.equal((await fetch(url + '/api/folders')).status, 401);
  assert.equal((await fetch(url + '/api/model-usage')).status, 401);
  assert.equal((await fetch(url + '/api/floors/local', { method: 'POST' })).status, 401);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  assert.equal((await context.request.post(url + '/api/floors/local', { data: { dir: projectDir } })).status(), 403);
  assert.equal((await context.request.post(url + '/api/floors/local', {
    headers: { Origin: url }, data: { dir: path.join(projectDir, 'keep.txt') },
  })).status(), 400);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Smoke test', color: '#ff8a5b', look: {} }));
    // Use the normal third-person setting so pointer lock does not redirect automated clicks.
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor, undefined, { timeout: 20000 });
  const addProject = async () => {
    await page.evaluate(() => document.exitPointerLock());
    await page.locator('#project').click();
    await page.getByRole('button', { name: /Add a project/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Local folder', exact: true }).getAttribute('aria-pressed'), 'true');
  };
  await addProject();
  await page.getByRole('button', { name: 'Browse folders', exact: true }).click();
  await page.locator('.folder-row').filter({ hasText: 'multi repo project' }).click();
  await page.waitForFunction(dir => document.querySelector('#local-floor-path')?.value === dir, projectDir);
  assert.equal(await page.locator('.folder-row').count(), 2);
  const screenshotDir = path.join(codeDir, 'tmp/screenshots');
  await mkdir(screenshotDir, { recursive: true });
  await page.getByRole('dialog', { name: 'Elevator', exact: true }).screenshot({ path: path.join(screenshotDir, 'local-folder-picker.png') });
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.waitForFunction(() => window.__office?.store.project?.name === 'multi repo project');
  const floors = () => readFile(path.join(officeDir, '.agent-office/floors.json'), 'utf8').then(JSON.parse);
  assert.equal((await floors()).length, 2);
  assert.equal(await readFile(path.join(projectDir, 'keep.txt'), 'utf8'), 'Unchanged project file');
  await addProject();
  await page.locator('#local-floor-path').fill(projectDir);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.getByRole('dialog', { name: 'Elevator', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await floors()).length, 2, 'opening an existing floor never duplicates it');
  await addProject();
  await page.getByRole('button', { name: 'Clone from GitHub', exact: true }).click();
  await page.getByRole('textbox', { name: 'Repository', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Open folder', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: 'Local folder', exact: true }).click();
  assert.equal(await page.locator('#local-floor-path').isVisible(), true);
  await page.getByRole('dialog', { name: 'Elevator', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#btn-model-usage').click();
  await page.waitForFunction(() => document.querySelectorAll('.usage-record').length === 2);
  assert.match(await page.locator('.usage-summary').innerText(), /2,000 tokens.*\$0.42/);
  await page.getByRole('combobox', { name: 'Filter usage by provider' }).selectOption('codex');
  assert.match(await page.locator('.usage-summary').innerText(), /1,000 tokens.*Cost unavailable/);
  assert.equal(await page.locator('.usage-record').count(), 1);
  await page.getByRole('combobox', { name: 'Filter usage by provider' }).selectOption('');
  await page.getByRole('dialog', { name: 'Usage and cost' }).screenshot({ path: path.join(screenshotDir, 'usage-and-cost.png') });
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  const exported = await downloadReady;
  assert.equal(exported.suggestedFilename(), 'Agent Office usage.csv');
  await page.getByRole('button', { name: 'Close usage', exact: true }).click();
  await page.evaluate(() => document.exitPointerLock());
  // A simulated worker exercises the real xterm input path without launching or billing an AI.
  await page.evaluate(() => {
    const { store, net } = window.__office;
    const original = net.send.bind(net);
    window.__terminalInputs = [];
    net.send = msg => { if (msg.workerId === 'keyboard-fixture') window.__terminalInputs.push(msg); else original(msg); };
    store.workers.set('keyboard-fixture', { id: 'keyboard-fixture', name: 'Keyboard fixture', kind: 'agent', provider: 'codex', deskId: 'desk-1', color: '#ff8a5b', status: 'idle', acked: true, createdBy: 'Test', createdAt: Date.now(), cols: 80, rows: 24, viewers: [] });
    store.emit('workers');
  });
  await page.locator('#workers li').filter({ hasText: 'Keyboard fixture' }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Keyboard fixture terminal' }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.__terminalInputs.some(m => m.t === 'term.input' && m.data === '\x1b')), true);
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Keyboard fixture terminal' }).count(), 0);
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  host.stdin.write('stop\n');
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Launcher host did not stop gracefully')), 15000);
    host.once('exit', () => { clearTimeout(deadline); resolve(); });
  });
  assert.equal(host.exitCode, 0);
  assert.equal(await fetch(url + '/api/health').then(r => r.ok, () => false), false);
  console.log('PASS: authenticated APIs, local folders, duplicates, GitHub mode, saved usage, provider filters, CSV export, Esc reaches terminal, click closes terminal, and launcher host start/stop.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  // Only remove this test's unique directory, resolved beneath the OS temp directory.
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('agent-office-ui-'));
  await rm(root, { recursive: true, force: true });
}
