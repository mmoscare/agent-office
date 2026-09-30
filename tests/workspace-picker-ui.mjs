// Windows browser check: npm run build, then node tests/workspace-picker-ui.mjs [screenshot dir].
// Hire never gets stuck on the repository search: on a floor that is itself a repo, a failed or slow
// search falls back to the single-repo worktree, a quick one is waited for, and the next dialog opens
// with the last list. Temporary Git repo and a fake Codex CLI only; no real AI requests or GitHub writes.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = path.resolve(process.argv[2] ?? path.join(codeDir, 'tmp/screenshots'));
const root = mkdtempSync(path.join(os.tmpdir(), 'office workspace picker ui '));
const floor = path.join(root, 'Solo');
const bin = path.join(root, 'bin');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A held search, released early when the check ends.
const held = new Set();
const hold = ms => new Promise(resolve => {
  const done = () => { clearTimeout(timer); held.delete(done); resolve(); };
  const timer = setTimeout(done, ms);
  held.add(done);
});
let host, browser, page;
const toasts = [];
const spawns = [];
let logs = '';
try {
  mkdirSync(floor); mkdirSync(bin); mkdirSync(screenshots, { recursive: true });
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'UI Test'); git(floor, 'config', 'user.email', 'ui-test@example.invalid');
  git(floor, 'config', 'core.autocrlf', 'false');
  git(floor, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(floor, 'app.txt'), 'original\n');
  git(floor, 'add', '.'); git(floor, 'commit', '-m', 'Initial');
  writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\fake-codex.cjs" %*\r\n');
  writeFileSync(path.join(bin, 'fake-codex.cjs'), `
process.stdout.write('Fake Codex ready\\r\\n');
process.stdin.resume();
fetch(process.env.AGENT_OFFICE_HOOK_URL + '/hooks/codex?worker=' + process.env.AGENT_OFFICE_WORKER_ID + '&event=SessionStart', {
  method: 'POST', headers: { Authorization: 'Bearer ' + process.env.AGENT_OFFICE_HOOK_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ session_id: 'workspace-picker-ui-fake-session', source: 'startup' })
}).catch(() => {});
`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: path.join(bin, 'codex.cmd'), AGENT_OFFICE_AGENT_ARGS: '', CODEX_HOME: path.join(root, 'test-codex-config'), CLAUDE_CONFIG_DIR: path.join(root, 'test-claude-config') },
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
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  context.setDefaultTimeout(30000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'UI Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
    // The owner's case: the worktree box is remembered on, so every hire dialog starts a repository search.
    localStorage.setItem('agent-office.worktree', '1');
  });
  page = await context.newPage();
  page.on('websocket', ws => {
    ws.on('framesent', ({ payload }) => {
      try { const msg = JSON.parse(String(payload)); if (msg.t === 'worker.spawn') spawns.push(msg); } catch { /* non-JSON frame */ }
    });
    ws.on('framereceived', ({ payload }) => {
      try { const msg = JSON.parse(String(payload)); if (msg.t === 'toast') toasts.push(msg.text); } catch { /* non-JSON frame */ }
    });
  });
  const errors = []; page.on('pageerror', err => errors.push(err.message));
  // Each check sets how the repository search behaves: slow, failing, or passed through to the real server.
  let search = { delay: 0, fail: false };
  await page.route('**/api/workspace/repositories**', async route => {
    const { delay, fail } = search;
    if (delay) await hold(delay);
    try {
      if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture search failure' }) });
      else await route.continue();
    } catch { /* the page moved on */ }
  });
  await page.goto(url, { timeout: 90000 }); await page.waitForFunction(() => window.__office?.store.floor, undefined, { timeout: 60000 });
  const hireDialog = async n => {
    await page.evaluate(deskId => {
      const { player, office } = window.__office;
      player.unlock();
      const desk = office.interactables.find(it => it.kind === 'desk' && it.deskId === deskId);
      player.pos.set(desk.x, desk.y ?? 0, desk.z); player.vy = 0;
    }, `desk-${n}`);
    await page.waitForFunction(label => {
      const hint = document.querySelector('#hint');
      return !hint?.classList.contains('hidden') && hint?.textContent.includes(label);
    }, `Desk ${n}`);
    await page.keyboard.press('e');
    const dialog = page.getByRole('dialog', { name: `✨ Hire a worker at Desk ${n}` });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox', { name: 'Work in separate git worktrees & branches' }).isChecked(), true);
    return dialog;
  };
  const spawned = async (count, within) => {
    const until = Date.now() + within;
    while (spawns.length < count && Date.now() < until) await pause(100);
    assert.equal(spawns.length, count, `hire request ${count} was sent`);
    return spawns[count - 1];
  };

  // 1. The search fails: Hire goes ahead with the floor's own worktree instead of showing an error.
  search = { delay: 800, fail: true };
  let dialog = await hireDialog(1);
  await dialog.getByRole('button', { name: 'Hire & start' }).click();
  let sent = await spawned(1, 20000);
  assert.equal(sent.worktree, true); assert.equal(sent.workspace, undefined);
  assert.equal(await dialog.isVisible(), false);
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some(w => w.deskId === 'desk-1' && w.worktree), undefined, { timeout: 60000 });
  console.log('A failed repository search still hired desk 1 in its own git worktree.');

  // 2. The search hangs: Hire shows it is finding repositories, then falls back after a few seconds.
  search = { delay: 60000, fail: false };
  dialog = await hireDialog(2);
  await dialog.getByText('Finding repositories in this floor…').waitFor();
  await dialog.evaluate(el => {
    const button = el.querySelector('button[type=submit]');
    window.__hireLabels = [];
    new MutationObserver(() => window.__hireLabels.push({ label: `${button.textContent}${button.disabled ? ' (disabled)' : ''}`, at: performance.now() })).observe(button, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  await dialog.getByRole('button', { name: 'Hire & start' }).click();
  sent = await spawned(2, 40000);
  assert.equal(sent.worktree, true); assert.equal(sent.workspace, undefined);
  const labels = await page.evaluate(() => window.__hireLabels);
  const from = labels.find(l => l.label === 'Finding repositories… (disabled)');
  const to = labels.findLast(l => l.label === 'Hire & start');
  assert.ok(from && to, `Hire shows that it is waiting: ${JSON.stringify(labels)}`);
  const waited = Math.round(to.at - from.at);
  assert.ok(waited >= 3500 && waited < 30000, `waited ${waited} ms for the search before falling back`);
  console.log(`A hung repository search fell back to desk 2's own worktree after waiting ${waited} ms.`);

  // 3. A quick search is waited for, and the hire goes out without a second click.
  search = { delay: 1000, fail: false };
  const listed = page.waitForResponse(r => r.url().includes('/api/workspace/repositories') && r.status() === 200, { timeout: 90000 });
  dialog = await hireDialog(3);
  await dialog.getByRole('button', { name: 'Hire & start' }).click();
  sent = await spawned(3, 45000);
  assert.equal(sent.worktree, true); assert.equal(sent.workspace, undefined);
  await listed;
  console.log('Hire clicked mid-search went out on its own for desk 3.');

  // 4. The next dialog shows the last list at once, even while its refresh hangs, and hires immediately.
  await pause(500);
  search = { delay: 60000, fail: false };
  dialog = await hireDialog(4);
  const choice = dialog.getByRole('checkbox', { name: 'Use .' });
  await choice.waitFor({ timeout: 3000 });
  assert.equal(await choice.isChecked(), true);
  await dialog.screenshot({ path: path.join(screenshots, 'hire-cached-repositories.png') }).catch(() => {});
  await dialog.getByRole('button', { name: 'Hire & start' }).click();
  sent = await spawned(4, 5000);
  assert.equal(sent.worktree, true); assert.equal(sent.workspace, undefined);
  console.log('The cached repository list opened instantly and hired desk 4 without waiting.');
  assert.deepEqual(errors, []);
  console.log('Workspace picker browser check passed.');
} catch (err) {
  console.error({ toasts, spawns });
  if (page) await page.screenshot({ path: path.join(screenshots, 'workspace-picker-failure.png') }).catch(() => {});
  console.error(logs.slice(-3000)); throw err;
} finally {
  for (const done of held) done();
  await browser?.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    await Promise.race([new Promise(resolve => host.once('exit', resolve)), pause(7000)]);
    if (host.exitCode === null) host.kill();
  }
  const resolved = realpathSync(root);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('office workspace picker ui '));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
