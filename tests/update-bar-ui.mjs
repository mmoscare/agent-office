// Isolated built-app smoke test of the update bar's steps (src/client/ui/update-bar.ts).
// The office status is mocked: pull, build and restart are never really run.
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
  for (let i = 0; i < 200; i++) {
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
  await context.request.post(url + '/api/login', { data: { password } });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Update bar test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });

  // The office's own status, as /api/git/office reports it: 2 commits behind GitHub, not built, started before this page.
  const startedAt = Date.now() - 60_000;
  let state = {
    dir: 'C:\\office\\agent-office', branch: 'personal', upstream: 'origin/personal', ahead: 0, behind: 2, dirty: 0,
    startedAt, target: 'target-a', floors: [], needs: { pull: true, build: true, restart: false },
  };
  let requests = 0;
  let fail = false;
  let hold = null;
  await context.route('**/api/git/office**', async route => {
    requests++;
    // What the office says is what it knew when asked, even if the answer comes late.
    const office = structuredClone(state);
    if (hold) await hold;
    if (fail) return route.abort();
    return route.fulfill({ json: { office } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  const bar = page.getByRole('region', { name: 'Update the office', exact: true });
  const title = bar.locator('.update-now-title');
  const doneButton = bar.locator('.update-done');
  const why = bar.locator('.update-why');
  const back = bar.getByRole('button', { name: /Back to the current step/ });
  const chip = n => bar.locator('.update-steps li').nth(n - 1);
  const chipState = n => chip(n).evaluate(li => `${li.className}:${li.querySelector('.update-num').textContent}`);
  // Coming back to the tab from PowerShell: the bar checks again by itself.
  const comeBack = async () => {
    const before = requests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (let i = 0; i < 50 && requests === before; i++) await pause(100);
    assert.ok(requests > before, 'coming back to the tab checks again');
    await pause(300);
  };
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

  // Step 2 (the floor is fine): the instructions, and a way on.
  await title.filter({ hasText: 'Step 2: Pull the app' }).waitFor();
  assert.equal(await doneButton.innerText(), '✓ Done, next step');
  assert.match(await bar.innerText(), /git pull/);
  assert.equal(await chipState(1), 'done:✓');
  assert.equal(await chipState(2), 'now:2');
  if (shots) await bar.screenshot({ path: path.join(shots, 'step2-done-button.png') });

  // "Done" before git pull has finished: say why, and offer the next step anyway.
  await doneButton.click();
  await why.waitFor();
  assert.equal(await why.innerText(), 'The app folder is still 2 commits behind origin/personal. Did git pull finish? Look for an error in PowerShell.');
  assert.equal(await doneButton.innerText(), '↻ Check again');
  assert.equal(await chipState(2), 'now:2');
  if (shots) await bar.screenshot({ path: path.join(shots, 'step2-not-yet.png') });
  await page.setViewportSize({ width: 480, height: 800 });
  assert.equal(await bar.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'no sideways scroll on a phone');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The next step anyway: its instructions, without faking a ✓ on step 2.
  await bar.getByRole('button', { name: 'Show me the next step anyway →', exact: true }).click();
  await title.filter({ hasText: 'Step 3: Build' }).waitFor();
  assert.equal(await chipState(2), 'now:2');
  assert.equal(await chipState(3), 'later shown:3');
  if (shots) await bar.screenshot({ path: path.join(shots, 'step3-preview.png') });
  assert.equal(await chip(3).getByRole('button').getAttribute('aria-current'), 'step');
  assert.equal(await back.innerText(), '← Back to the current step (2)');
  // A check while reading it doesn't pull the view away.
  await comeBack();
  assert.equal(await title.innerText(), 'Step 3: Build');
  await back.click();
  await title.filter({ hasText: 'Step 2: Pull the app' }).waitFor();
  assert.equal(await back.count(), 0);

  // "Done" pressed while a check is already under way (one that began before git pull finished):
  // it waits for that one, then checks again, rather than doing nothing.
  const release = await checkUnderWay();
  state = { ...state, behind: 0, target: 'target-a', needs: { pull: false, build: true, restart: false } };
  await doneButton.click();
  await doneButton.filter({ hasText: 'Checking…' }).waitFor();
  assert.equal(await doneButton.isDisabled(), true);
  const held = requests;
  release();
  await title.filter({ hasText: 'Step 3: Build' }).waitFor();
  assert.ok(requests > held, 'it checked again after the one under way');
  assert.equal(await chipState(2), 'done:✓');
  assert.equal(await chipState(3), 'now:3');
  assert.equal(await why.count(), 0);
  // Space (jump) mustn't press a bar button again: the click leaves no button focused in it.
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.update-bar')), false);

  // Build not finished yet.
  await doneButton.click();
  await why.filter({ hasText: 'There’s no new build yet. Is npm run build still running, or did it stop with an error?' }).waitFor();

  // Open an earlier step from its chip; a status change while reading it doesn't move the view.
  await chip(1).getByRole('button').click();
  await title.filter({ hasText: 'Step 1: Pull the floor' }).waitFor();
  assert.match(await bar.innerText(), /✓ This step is done\./);
  assert.equal(await doneButton.count(), 0);
  // The build finishes while a poll is under way that asked before it had. Coming back to the tab
  // then checks again once that poll is back, rather than keeping its old answer until the next one.
  const releasePoll = await checkUnderWay();
  state = { ...state, builtAt: Date.now(), needs: { pull: false, build: false, restart: true } };
  // Page timers fire in order, so the return's own 500 ms timer has fired by the time this one does.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); return new Promise(resolve => setTimeout(resolve, 600)); });
  const polled = requests;
  releasePoll();
  // Well inside the 60 s poll, so it's the return that checked.
  await bar.locator('.update-steps li.now').filter({ hasText: 'Restart' }).waitFor({ timeout: 15_000 });
  assert.ok(requests > polled, 'coming back checked again after the poll under way');
  assert.equal(await title.innerText(), 'Step 1: Pull the floor');
  assert.equal(await chipState(3), 'done:✓');
  assert.equal(await chipState(4), 'now:4');
  assert.equal(await back.innerText(), '← Back to the current step (4)');
  await back.click();
  await title.filter({ hasText: 'Step 4: Restart' }).waitFor();

  // The office can't be reached (mid-restart): say so rather than "not restarted".
  fail = true;
  await doneButton.click();
  await why.filter({ hasText: 'Couldn’t reach the office just now.' }).waitFor();
  fail = false;
  await doneButton.click();
  await why.filter({ hasText: 'The office hasn’t restarted since the build.' }).waitFor();

  // Restarted: on to reloading this page, with its button as before.
  state = { ...state, startedAt: Date.now(), needs: { pull: false, build: false, restart: false } };
  await doneButton.click();
  await title.filter({ hasText: 'Step 5: Reload this page' }).waitFor();
  assert.match(await bar.locator('.update-head').innerText(), /The office was updated/);
  await bar.getByRole('button', { name: '🔄 Reload now', exact: true }).waitFor();
  assert.equal(await doneButton.count(), 0);

  // Hide still puts it away for this update, under the same key as before.
  await bar.getByRole('button', { name: 'Hide', exact: true }).click();
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-office.updateBarHidden')), `target-a|${state.startedAt}`);
  assert.deepEqual(errors, []);
  console.log('PASS: step 2 Done button, not-yet reasons (pull, build, restart, unreachable), next step anyway, chips and back link, no yank on checks, click during a check, re-check on coming back (also after a poll under way), reload step, Hide key.');
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
