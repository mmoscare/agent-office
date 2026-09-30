// Windows browser smoke check: npm run build, then node tests/workspace-ui.mjs.
// Uses temporary Git repos and a fake Codex CLI. No real AI requests or GitHub writes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office workspace ui '));
const floor = path.join(root, 'Portfolio');
const bin = path.join(root, 'bin');
const log = path.join(root, 'fake-agent.jsonl');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host, browser, page;
const messages = [];
let logs = '';
try {
  mkdirSync(floor); mkdirSync(bin);
  for (const name of ['frontend', 'backend', 'docs']) {
    const dir = path.join(floor, name); mkdirSync(dir);
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.name', 'UI Test'); git(dir, 'config', 'user.email', 'ui-test@example.invalid');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'app.txt'), `original ${name}\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Initial');
    git(dir, 'switch', '-c', 'personal');
    writeFileSync(path.join(dir, 'app.txt'), `personal ${name}\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-m', 'Personal');
    git(dir, 'switch', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/test/project.git');
    git(dir, 'update-ref', 'refs/remotes/origin/development', git(dir, 'rev-parse', 'personal'));
  }
  writeFileSync(path.join(floor, 'frontend/app.txt'), 'unfinished original edits\n');
  // Use the same npm shim shape supported by the Windows command adapter.
  writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\fake-codex.cjs" %*\r\n');
  writeFileSync(path.join(bin, 'fake-codex.cjs'), `
const fs = require('node:fs');
const log = process.env.WORKSPACE_TEST_LOG;
fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.stdout.write('Fake Codex ready\\r\\n');
process.stdin.on('data', data => fs.appendFileSync(log, JSON.stringify({ input: String(data) }) + '\\n'));
process.stdin.resume();
fetch(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/codex?worker=' + process.env.AGENT_OFFICE_WORKER_ID + '&event=SessionStart', {
  method: 'POST', headers: { Authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id: 'workspace-ui-fake-session', source: 'startup' })
}).catch(() => {});
`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: path.join(bin, 'codex.cmd'), AGENT_OFFICE_AGENT_ARGS: '', WORKSPACE_TEST_LOG: log, CODEX_HOME: path.join(root, 'test-codex-config'), CLAUDE_CONFIG_DIR: path.join(root, 'test-claude-config') },
  });
  host.stdout.on('data', data => { logs += data; }); host.stderr.on('data', data => { logs += data; });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'built server starts');
  assert.equal((await fetch(url + '/api/workspace/repositories?floor=portfolio')).status, 401);
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(30000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'UI Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
    localStorage.setItem('agent-office.worktree', '0');
  });
  page = await context.newPage();
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try { const msg = JSON.parse(String(payload)); if (msg.t === 'toast') messages.push(msg.text); } catch { /* non-JSON frame */ }
  }));
  const errors = []; page.on('pageerror', err => errors.push(err.message));
  await page.goto(url); await page.waitForFunction(() => window.__office?.store.floor, undefined, { timeout: 20000 });
  const atDesk = async () => {
    await page.evaluate(() => {
      const { player, office } = window.__office;
      player.unlock();
      const desk = office.interactables.find(it => it.kind === 'desk' && it.deskId === 'desk-1');
      player.pos.set(desk.x, desk.y ?? 0, desk.z); player.vy = 0;
    });
    await pause(300);
    await page.waitForFunction(() => {
      const hint = document.querySelector('#hint');
      const worker = window.__office.store.workerAtDesk('desk-1');
      return !hint?.classList.contains('hidden') && hint?.textContent.includes(worker ? 'Send home' : 'Desk 1');
    });
  };
  await atDesk(); await page.keyboard.press('e');
  const hire = page.getByRole('dialog', { name: /Hire a worker at/ }); await hire.waitFor();
  // Hire pressed before the list arrives waits for it, then asks which of the several repositories to use.
  let release; const slow = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspace/repositories**', async route => { await slow; await route.continue(); });
  await hire.getByRole('button', { name: 'Choose starting branch…' }).click();
  await hire.getByRole('button', { name: 'Hire & start' }).click();
  await hire.getByRole('button', { name: 'Finding repositories…' }).waitFor();
  release();
  await hire.getByText('Select at least one repository (12 per worker maximum).').waitFor();
  assert.equal(await hire.getByText(/Wait for the repository list/).count(), 0);
  assert.equal(await page.evaluate(() => window.__office.store.workers.size), 0);
  await page.unroute('**/api/workspace/repositories**');
  console.log('Hire pressed mid-search waited for the list, then asked for a repository choice.');
  assert.equal(await hire.getByRole('checkbox', { name: 'Work in separate git worktrees & branches' }).isChecked(), true);
  await hire.getByRole('checkbox', { name: 'Use frontend', exact: true }).check();
  await hire.getByRole('checkbox', { name: 'Use backend', exact: true }).check();
  await hire.getByRole('combobox', { name: 'Starting branch for frontend' }).selectOption('refs/heads/personal');
  await hire.getByRole('combobox', { name: 'Starting branch for backend' }).selectOption('refs/remotes/origin/development');
  await hire.getByRole('textbox', { name: 'New branch name (optional)' }).fill('feature/ui-login');
  const screenshots = path.join(codeDir, 'tmp/screenshots'); mkdirSync(screenshots, { recursive: true });
  await hire.screenshot({ path: path.join(screenshots, 'workspace-hire.png') });
  await hire.getByRole('button', { name: 'Hire & start' }).click();
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some(w => w.workspace?.repositories.length === 2 && w.status === 'idle'), undefined, { timeout: 20000 });
  console.log('Hired a fake Codex worker across both repositories.');
  const worker = () => JSON.parse(readFileSync(path.join(floor, '.agent-office/workers.json'), 'utf8'))[0];
  const ws = worker().workspace;
  assert.equal(ws.repositories.find(r => r.repository === 'frontend').from, 'personal');
  assert.equal(ws.repositories.find(r => r.repository === 'backend').from, 'development');
  for (const repo of ws.repositories) {
    assert.equal(readFileSync(path.join(floor, repo.path, 'app.txt'), 'utf8'), `personal ${repo.name}\n`);
    assert.equal(git(path.join(floor, repo.repository), 'branch', '--show-current'), 'main');
  }
  const invocations = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations[0].cwd, path.join(floor, ws.path));
  assert.match(invocations[0].args.at(-1), /frontend/); assert.match(invocations[0].args.at(-1), /backend/);
  assert.equal(readFileSync(path.join(floor, 'frontend/app.txt'), 'utf8'), 'unfinished original edits\n');
  const backend = path.join(floor, ws.repositories.find(r => r.repository === 'backend').path);
  writeFileSync(path.join(backend, 'app.txt'), 'backend isolated UI change\n');
  // The Workers panel starts hidden in the HUD; the dock's Workers button shows it.
  if (await page.locator('#workers-panel').evaluate((el) => el.classList.contains('hud-off'))) await page.locator('#dock button.dock-panel').filter({ hasText: 'Workers' }).click();
  await page.locator('#workers li').filter({ hasText: 'Pixel' }).click();
  await page.getByRole('button', { name: /Changes/ }).click();
  const workspace = page.getByRole('dialog', { name: 'Pixel workspace' });
  await workspace.waitFor();
  assert.equal(await workspace.locator('.workspace-card').count(), 2);
  await workspace.screenshot({ path: path.join(screenshots, 'workspace-repositories.png') });
  await workspace.locator('[data-repository="backend"]').getByRole('button', { name: 'Changes & commits' }).click();
  const changes = page.locator('.desk-changes');
  await changes.getByText('backend isolated UI change', { exact: true }).waitFor({ timeout: 10000 });
  await changes.getByRole('button', { name: /Commit 1 file/ }).click();
  const commit = page.getByRole('dialog', { name: /Commit 1 file/ });
  await commit.getByRole('textbox', { name: 'Prompt' }).fill('Backend UI fixture');
  await commit.getByRole('button', { name: 'Commit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.desk-changes footer')?.textContent.includes('all committed'));
  assert.equal(git(backend, 'log', '-1', '--format=%s'), 'Backend UI fixture');
  assert.equal(git(path.join(floor, 'backend'), 'log', '-1', '--format=%s'), 'Initial');
  console.log('Committed only the backend worktree through its Changes window.');
  await changes.getByRole('button', { name: 'Close', exact: true }).click();
  await workspace.getByRole('button', { name: 'Add repositories' }).click();
  const add = page.getByRole('dialog', { name: 'Add repositories', exact: true });
  await add.getByRole('checkbox', { name: 'Use docs' }).waitFor();
  await add.getByRole('combobox', { name: 'Starting branch for docs' }).selectOption('refs/heads/personal');
  await add.getByRole('button', { name: 'Add worktrees' }).click();
  await page.waitForFunction(() => [...window.__office.store.workers.values()][0]?.workspace?.repositories.length === 3, undefined, { timeout: 30000 });
  assert.equal(git(path.join(floor, worker().workspace.repositories.find(r => r.repository === 'docs').path), 'branch', '--show-current'), 'feature/ui-login');
  assert.equal(worker().workspace.repositories.find(r => r.repository === 'docs').from, 'personal');
  console.log('Added a third repository to the existing worker.');
  await workspace.getByRole('button', { name: 'Close workspace' }).click();
  await atDesk(); await page.keyboard.press('x');
  const cleanup = page.getByRole('alertdialog', { name: 'Send Pixel home?' }).or(page.getByRole('dialog', { name: 'Send Pixel home?' }));
  await cleanup.waitFor();
  await cleanup.getByText(/backend: 0 uncommitted changes, 1 unpushed commits/).waitFor({ timeout: 15000 });
  assert.equal(await cleanup.getByRole('radio', { name: /Keep everything/ }).isChecked(), true);
  await cleanup.getByRole('button', { name: 'Send home', exact: true }).click();
  await page.waitForFunction(() => window.__office.store.workers.size === 0);
  assert.equal(existsSync(backend), true, 'default cleanup preserves unpushed work');
  assert.equal(readFileSync(path.join(floor, 'frontend/app.txt'), 'utf8'), 'unfinished original edits\n');
  assert.deepEqual(errors, []);
  console.log('Workspace browser smoke passed: hire both repos, actual fake-agent launch, separate changes/commit, add repo, safe cleanup.');
} catch (err) {
  console.error(messages);
  if (page) {
    console.error(await page.evaluate(() => ({ hint: document.querySelector('#hint')?.textContent, dialogs: [...document.querySelectorAll('.modal')].map(m => m.getAttribute('aria-label')), position: window.__office?.player.pos, locked: window.__office?.player.locked, seat: window.__office?.player.seat, view: window.__office?.settings.view })));
    await page.screenshot({ path: path.join(codeDir, 'tmp/screenshots/workspace-failure.png') }).catch(() => {});
  }
  console.error(logs.slice(-3000)); throw err;
} finally {
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office workspace ui '));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
