// npm run build, then node tests/whats-new-ui.mjs [screenshot-dir].
// An isolated office whose floor has a made-up history; no AI provider or live office is used.
// The staffer's clipboard, clicked: its ✨ What's new page lists the floor's changes under their
// days, marks the ones newer than this browser last saw, shows older ones on request, reads another
// floor from the picker, and goes back to the roster.
//
// Claude is kept off the office's PATH, so every line is a tidied-up title marked "not yet
// rewritten". WHATS_NEW_REAL_CLAUDE=1 leaves it on, to see real rewrites (it waits for them), and
// WHATS_NEW_EXTRA_FLOOR=<folder> reads that folder as the second floor instead of a made-up one.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : '';
const realClaude = process.env.WHATS_NEW_REAL_CLAUDE === '1';
const extraFloor = process.env.WHATS_NEW_EXTRA_FLOOR ? path.resolve(process.env.WHATS_NEW_EXTRA_FLOOR) : '';
const root = mkdtempSync(path.join(os.tmpdir(), 'office-whats-new-ui-'));
const floor = path.join(root, 'project');
const other = path.join(root, 'other');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const WALK = { timeout: 60000, polling: 100 };
const DAY = 86400;

/** A repository whose main has these commits, oldest first, in one `git fast-import` (git is slow to start here). */
function repo(dir, commits) {
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'What’s New UI Test']);
  git(dir, ['config', 'user.email', 'whats-new-ui@example.invalid']);
  const data = s => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let stream = '';
  let mark = 0;
  let main = 0;
  for (const c of commits) {
    const who = `committer Test <test@example.invalid> ${c.at} +0000\n`;
    let side = 0;
    if (c.side) {
      side = ++mark;
      stream += `commit refs/heads/side\nmark :${side}\n${who}${data(c.side)}${main ? `from :${main}\n` : ''}M 644 inline side-${side}.txt\n${data(c.side)}`;
    }
    const me = ++mark;
    stream += `commit refs/heads/main\nmark :${me}\n${who}${data(c.message)}${main ? `from :${main}\n` : ''}${side ? `merge :${side}\n` : ''}M 644 inline change-${me}.txt\n${data(c.message)}`;
    main = me;
  }
  git(dir, ['fast-import', '--quiet'], stream);
  git(dir, ['reset', '-q', '--hard', 'main']);
}

// Today's and yesterday's changes, then older ones a day or two apart: more than one page of them.
const now = Math.floor(Date.now() / 1000);
const today = new Date();
const yesterdayNoon = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12).getTime() / 1000);
const older = Array.from({ length: 45 }, (_, i) => ({ at: yesterdayNoon - (45 - i) * DAY, message: `Tidy up the help page, part ${i + 1}` }));
const history = [
  ...older,
  { at: yesterdayNoon, message: 'Add a notepad you can click to jot notes down' },
  { at: now - 90, message: 'Merge pull request #7 from me/feature/wave\n\nClock workers out with a wave', side: 'Wave goodbye' },
  { at: now - 30, message: 'fix: hiring no longer waits for the repository list' },
];

// The office never finds Claude unless asked to: no model is called.
const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
const withoutClaude = (process.env[pathKey] ?? '').split(path.delimiter).filter(d => !['claude', 'claude.exe', 'claude.cmd', 'claude.bat'].some(n => existsSync(path.join(d, n)))).join(path.delimiter);

let host, browser, page;
let hostErrors = '';
try {
  repo(floor, history);
  if (!extraFloor) repo(other, [{ at: now - 3 * DAY, message: 'Start the garden' }, { at: now - 60, message: 'Water the tomatoes every morning' }]);
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('What’s new fixture ready\\r\\n'); process.stdin.resume();");
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, ...(realClaude ? {} : { [pathKey]: withoutClaude }), AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  host.stderr.on('data', data => { hostErrors = (hostErrors + data).slice(-4000); });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    assert.equal(host.exitCode, null, hostErrors);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, hostErrors);
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Generous: other offices may be running on this machine, and adding a big repository as a floor takes a while.
  context.setDefaultTimeout(90000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'News Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  await page.evaluate(() => { window.__office.player.update = () => {}; window.__office.player.updateCamera = () => {}; });

  // A second floor, added the way the floor menu adds a local folder.
  const added = await page.evaluate(async dir => {
    const r = await fetch('/api/floors/local', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) });
    return { status: r.status, body: await r.json() };
  }, extraFloor || other);
  assert.equal(added.status, 200, JSON.stringify(added));
  await page.waitForFunction(() => window.__office.store.floors.length === 2);
  // This browser last looked when the notepad was the newest: what came after it is new. The marks
  // go by the floor's folder (seenKey in src/shared/whats-new.ts), not its id.
  await page.evaluate(at => {
    const o = window.__office;
    const here = o.store.floors.find(f => f.id === o.store.floor);
    localStorage.setItem('agent-office.whats-new.seen', JSON.stringify({ [`dir:${here.dir.replace(/\\/g, '/').replace(/\/+$/, '')}`]: at }));
  }, yesterdayNoon * 1000);

  // Call the staffer over (U) and click his clipboard, as tests/staffer-ui.mjs does.
  await page.evaluate(() => {
    const o = window.__office;
    o.player.pos.set(2, 0, 3);
    o.player.facing = 0;
    o.camera.position.set(2, 3, -0.2);
    o.camera.lookAt(2, 0.8, 4);
  });
  await page.keyboard.press('KeyU');
  await page.waitForFunction(() => window.__office.staffer.phase === 'to');
  await page.waitForFunction(() => {
    const o = window.__office;
    for (let i = 0; i < 40 && o.staffer.phase !== 'here'; i++) o.staffer.update(0.1, o.player.pos);
    return o.staffer.phase === 'here';
  }, undefined, WALK);
  const point = await page.evaluate(() => {
    const o = window.__office;
    let board;
    o.office.group.traverse(obj => { if (obj.userData.interact?.kind === 'clipboard' && obj.visible) board = obj; });
    const p = board.getWorldPosition(board.position.clone());
    const me = o.player.pos;
    const d = Math.hypot(me.x - p.x, me.z - p.z) || 1;
    o.camera.position.set(p.x + ((me.x - p.x) / d) * 0.8, p.y + 0.3, p.z + ((me.z - p.z) / d) * 0.8);
    o.camera.lookAt(p);
    o.camera.updateMatrixWorld();
    o.renderer.render(o.scene, o.camera);
    p.project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const clipboard = page.getByRole('dialog', { name: "Queue agent's clipboard", exact: true });
  // Under load he may still be turning to face you, and the click lands on him: C beside him opens it too.
  const clicked = await clipboard.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (!clicked) await page.keyboard.press('KeyC');
  await clipboard.waitFor().catch(async error => {
    console.error('Dialogs:', await page.locator('[role=dialog]').evaluateAll(ds => ds.map(d => d.getAttribute('aria-label') || d.textContent.slice(0, 80))), 'Clicked:', point);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'failure.png') });
    }
    throw error;
  });
  // The roster first, as before.
  await clipboard.locator('.clipboard-floor').first().waitFor();

  // ✨ What's new: the floor you're on, newest first, under Today and Yesterday.
  await clipboard.getByRole('tab', { name: /What's new/ }).click();
  const items = clipboard.locator('.whats-new-item');
  await items.first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.whats-new-item').length === 40);
  const texts = await clipboard.locator('.whats-new-text').allTextContents();
  const days = await clipboard.locator('.whats-new-day h3').allTextContents();
  assert.deepEqual(days.slice(0, 2), ['Today', 'Yesterday']);
  if (realClaude) {
    // Written in plain words, a few at a time, while the page is open.
    await page.waitForFunction(() => !document.querySelector('.whats-new-tag.rough'), undefined, { timeout: 240000, polling: 1000 });
  } else {
    assert.deepEqual(texts.slice(0, 3), ['Hiring no longer waits for the repository list.', 'Clock workers out with a wave.', 'Add a notepad you can click to jot notes down.']);
    assert.equal(await clipboard.locator('.whats-new-tag.rough').count(), 40, 'every line is a tidied-up title');
    assert.match(await clipboard.locator('.whats-new-note').first().textContent(), /Claude isn't set up/);
  }
  assert.equal(await clipboard.locator('.whats-new-tag.fresh').count(), 2, 'the two changes after the notepad are new');
  const newTexts = await clipboard.locator('.whats-new-item.fresh .whats-new-text').allTextContents();
  assert.deepEqual(newTexts, (await clipboard.locator('.whats-new-text').allTextContents()).slice(0, 2));
  assert.ok(await clipboard.locator('.whats-new-floor').isVisible(), 'two floors: the picker shows');
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await clipboard.screenshot({ path: path.join(shots, 'whats-new.png') });
  }

  // Show older reaches the first change.
  const olderButton = clipboard.getByRole('button', { name: /Show older \(8 more\)/ });
  await olderButton.click();
  await page.waitForFunction(() => document.querySelectorAll('.whats-new-item').length === 48);
  assert.equal(await olderButton.isVisible(), false);
  if (!realClaude) assert.equal((await clipboard.locator('.whats-new-text').allTextContents()).at(-1), 'Tidy up the help page, part 1.');

  // Another floor, from the picker.
  const otherId = added.body.floor;
  await clipboard.locator('.whats-new-floor').selectOption(otherId);
  if (!extraFloor) {
    await page.waitForFunction(() => [...document.querySelectorAll('.whats-new-text')].map(e => e.textContent).join('|') === 'Water the tomatoes every morning.|Start the garden.');
  } else {
    await page.waitForFunction(() => document.querySelectorAll('.whats-new-item').length > 0 && !document.querySelector('.whats-new-status')?.textContent?.includes('Reading'));
    if (realClaude) await page.waitForFunction(() => !document.querySelector('.whats-new-tag.rough') && !/Putting|Checking/.test(document.querySelector('.whats-new-status')?.textContent ?? ''), undefined, { timeout: 300000, polling: 1000 });
    if (shots) await clipboard.screenshot({ path: path.join(shots, 'whats-new-other-floor.png') });
  }

  // Back to the roster.
  await clipboard.getByRole('tab', { name: /Who's on what/ }).click();
  await clipboard.locator('.clipboard-floor').first().waitFor();
  assert.equal(await clipboard.locator('.whats-new').count(), 0);
  if (shots) await clipboard.screenshot({ path: path.join(shots, 'whats-new-roster.png') });
  await clipboard.getByRole('button', { name: 'Close', exact: true }).click();
  await clipboard.waitFor({ state: 'detached' });

  assert.deepEqual(errors, []);
  console.log(`PASS: clipboard (${clicked ? 'clicked' : 'C beside him'}) → What's new: Today/Yesterday, 2 marked new, 40 then 48 with Show older, the other floor from the picker, back to the roster${realClaude ? ' (real Claude rewrites)' : ' (no Claude: tidied titles)'}. First lines: ${JSON.stringify(texts.slice(0, 3))}`);
} catch (error) {
  // What the page showed when it failed, and what the office said.
  if (page) {
    console.error('Windows:', await page.locator('[role=dialog]').allInnerTexts().catch(() => []));
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
    }
  }
  console.error('Office stderr:', hostErrors.slice(-1500));
  throw error;
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-whats-new-ui-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
