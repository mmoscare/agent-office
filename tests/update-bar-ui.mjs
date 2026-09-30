// Isolated built-app smoke test of the update bar (src/client/ui/update-bar.ts), which points to the
// step-by-step walkthrough (ui/office-update.ts). The walkthrough's state is mocked: nothing is pulled,
// built or restarted here (tests/office-update-ui.mjs does that for real in a throwaway office).
// Run after `npm run build`: node tests/update-bar-ui.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const root = await mkdtemp(path.join(os.tmpdir(), 'office-update-bar-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let host, browser;
let logs = '';

/** The walkthrough's state as /api/git/office/update reports it, at a given step. */
function officeState(step, extra = {}) {
  const order = ['floor', 'app', 'packages', 'build', 'restart'];
  const steps = Object.fromEntries(order.map((id, i) => [id, i < order.indexOf(step) || step === 'done' ? (id === 'packages' ? 'skipped' : 'done') : 'todo']));
  return {
    appDir: 'C:\\office\\agent-office', branch: 'personal', upstream: 'origin/personal', target: 'target-a', github: 'mmoscare/agent-office', admin: true,
    prs: [{ number: 57, title: 'Grok default model', sha: 'a'.repeat(40) }], otherCommits: 0,
    floors: [{ name: 'agent-office', dir: 'C:\\floors\\agent-office', behind: step === 'floor' ? 2 : 0, dirty: 0 }],
    app: { behind: order.indexOf(step) <= 1 && step !== 'done' ? 2 : 0, ahead: 16, dirty: [], head: 'b'.repeat(40) },
    packages: { needed: false, runtime: false, changes: [], staged: false },
    build: { state: 'idle' }, running: { commit: 'c'.repeat(40), startedAt: Date.now() - 60_000 },
    restart: { available: true }, busy: [], steps, outcomes: {}, ...extra,
  };
}

try {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, root, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password },
  });
  host.stdout.on('data', d => { logs += d; });
  host.stderr.on('data', d => { logs += d; });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited: ${logs}`);
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
  context.setDefaultTimeout(60_000);
  await context.request.post(url + '/api/login', { data: { password } });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Update bar test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });

  let state = officeState('app');
  let requests = 0;
  let fail = false;
  let hold = null;
  await context.route((u) => u.pathname === '/api/git/office/update', async route => {
    requests++;
    // What the office says is what it knew when asked, even if the answer comes late.
    const answer = structuredClone(state);
    if (hold) await hold;
    if (fail) return route.abort();
    return route.fulfill({ json: { state: answer } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  const bar = page.getByRole('region', { name: 'Update the office', exact: true });
  const chip = n => bar.locator('.update-steps li').nth(n - 1);
  const chipState = n => chip(n).evaluate(li => `${li.className}:${li.querySelector('.update-num').textContent}`);
  const dialog = page.getByRole('dialog', { name: 'Update the office' });
  // A check under way that keeps its answer (what the office knew when asked) until released.
  const checkUnderWay = async () => {
    let release;
    hold = new Promise(resolve => { release = resolve; });
    const before = requests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (let i = 0; i < 50 && requests === before; i++) await pause(100);
    assert.ok(requests > before, 'a check is under way');
    return () => { hold = null; release(); };
  };
  if (shots) await mkdir(shots, { recursive: true });

  // Step 2 (the floor is done): which PR, how far, and the way into the walkthrough. No commands to copy.
  await bar.getByText('Step 2 of 5: Pull the app folder').waitFor();
  assert.match(await bar.innerText(), /PR #57: Grok default model/);
  assert.doesNotMatch(await bar.innerText(), /git pull|npm run build|PowerShell/);
  assert.equal(await chipState(1), 'done:✓');
  assert.equal(await chipState(2), 'now:2');
  assert.equal(await chip(2).getByRole('button').getAttribute('aria-current'), 'step');
  if (shots) await bar.screenshot({ path: path.join(shots, 'bar-step2.png') });
  await page.setViewportSize({ width: 480, height: 800 });
  assert.equal(await bar.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no sideways scroll on a phone');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A chip opens the walkthrough at the step on hand; the click leaves no bar button focused (Space jumps).
  await chip(4).getByRole('button').click();
  await dialog.getByText('Step 2 of 5').waitFor();
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.update-bar')), false);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await dialog.waitFor({ state: 'hidden' });
  await bar.getByRole('button', { name: /Walk me through it/ }).click();
  await dialog.getByText('Bringing in').waitFor();
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.update-bar')), false);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await dialog.waitFor({ state: 'hidden' });

  // Built and waiting for a restart done from the tray icon, while a poll is under way that asked
  // before: coming back to the tab checks again once that poll is back, well inside the 60 s poll.
  const releasePoll = await checkUnderWay();
  state = officeState('restart', { build: { state: 'ready', commit: 'b'.repeat(40) } });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); return new Promise(resolve => setTimeout(resolve, 600)); });
  const polled = requests;
  releasePoll();
  await bar.getByText('Step 5 of 5: Restart').waitFor({ timeout: 15_000 });
  assert.ok(requests > polled, 'coming back checked again after the poll under way');
  assert.equal(await chipState(4), 'done:✓');
  assert.equal(await chipState(5), 'now:5');

  // The office can't be reached (mid-restart): the bar stays as it was.
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pause(1500);
  await bar.getByText('Step 5 of 5: Restart').waitFor();
  fail = false;

  // Restarted and checked: the update is live, with a worker to tell "continue".
  const at = Date.now() - 5000;
  state = officeState('done', {
    prs: [], running: { commit: 'b'.repeat(40), startedAt: Date.now() },
    last: { at, by: 'Owner', expect: 'b'.repeat(40), prs: [{ number: 57, title: 'Grok default model', sha: 'a'.repeat(40) }], busy: [], verdict: 'live', now: [{ id: 'w1', name: 'Byte', floor: 'Personal-Portfolio', status: 'idle' }] },
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await bar.getByText('✅ Done: PR #57 is live.').waitFor({ timeout: 15_000 });
  assert.match(await bar.innerText(), /Tell 1 worker “continue”\./);
  if (shots) await bar.screenshot({ path: path.join(shots, 'bar-done.png') });

  // Hide puts it away for this update; the next merge brings it back.
  await bar.getByRole('button', { name: 'Hide', exact: true }).click();
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-office.updateBarHidden')), `target-a|${at}`);
  state = officeState('app', { target: 'target-b', prs: [{ number: 58, title: 'Faster boards', sha: 'd'.repeat(40) }] });
  await page.evaluate(() => window.__office.store.emit('floor'));
  await bar.getByText('PR #58: Faster boards').waitFor({ timeout: 15_000 });
  assert.deepEqual(errors, []);
  console.log('PASS: which PR and how far, no commands, chips and the button open the walkthrough, no focus left in the bar, phone width, re-check on coming back (also after a poll under way), unreachable office, live + continue, Hide key, next merge brings it back.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-update-bar-'));
  await rm(root, { recursive: true, force: true });
}
