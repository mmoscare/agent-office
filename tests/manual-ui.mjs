// npm run build, then node tests/manual-ui.mjs [screenshot.png].
// Opens the Office Manual on "Changes made straight to personal" in an isolated office and checks it
// renders: its place in the book, Copy buttons, `code` and **bold**, and nothing wider than the page.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2];
const root = mkdtempSync(path.join(os.tmpdir(), 'office-manual-ui-'));
const floor = path.join(root, 'project');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const APP_DIR = 'C:\\Users\\Owner\\Documents\\Development\\Agent-Office\\agent-office';
const TITLE = 'Changes made straight to personal';
let host, browser;
try {
  mkdirSync(floor);
  git(floor, 'init', '-b', 'main');
  git(floor, 'config', 'user.name', 'Manual UI Test');
  git(floor, 'config', 'user.email', 'manual-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, "process.stdout.write('Manual fixture ready\\r\\n'); process.stdin.resume();");
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Manual Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);

  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.hud-menu .menu-item', { hasText: 'Manual' }).first().click();
  const book = page.getByRole('dialog', { name: 'Office Manual', exact: true });
  const toc = book.getByRole('navigation', { name: 'Chapters' });
  const chapters = await toc.getByRole('button').evaluateAll(buttons => buttons.map(b => b.lastChild.textContent));
  assert.equal(chapters[chapters.indexOf('How work gets to GitHub and back') + 1], TITLE, 'the chapter follows the one with the three copies');

  // The front page points to it.
  await toc.getByRole('button', { name: /About this manual/ }).click();
  const pointer = book.locator('article p', { hasText: 'Not sure whether something is uncommitted?' });
  assert.equal(await pointer.locator('b').textContent(), '🧭 ' + TITLE);

  await toc.getByRole('button', { name: new RegExp(TITLE) }).click();
  const article = book.locator('article.manual-page');
  assert.equal(await article.locator('h3').textContent(), '🧭 ' + TITLE);
  const text = await article.innerText();
  assert.doesNotMatch(text, /\*\*|`/, 'no raw markdown left in the page');
  assert.ok(await article.locator('p code, li code, td code').count() > 5, '`code` is formatted');
  assert.ok(await article.locator('p b, li b').count() > 5, '**bold** is formatted');

  const boxes = article.locator('.manual-code');
  assert.equal(await boxes.count(), 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(await boxes.nth(i).locator('.manual-dir code').textContent(), APP_DIR);
    assert.equal(await boxes.nth(i).getByRole('button', { name: '📋 Copy' }).count(), 1);
  }
  const commit = boxes.nth(1);
  await commit.getByRole('button', { name: '📋 Copy' }).click();
  await commit.getByRole('button', { name: '✓ Copied' }).waitFor();
  // Windows puts CRLF line ends on the clipboard.
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), 'git add .\ngit commit -m "Describe the change"');

  const overflow = () => article.evaluate(el => {
    const wide = [el, ...el.querySelectorAll('pre, .manual-table, p, li')].filter(e => e.scrollWidth > e.clientWidth + 1);
    return wide.map(e => e.tagName + '.' + e.className);
  });
  const snap = async (suffix, scroll) => {
    if (!shot) return;
    await article.evaluate((el, s) => { el.scrollTop = s === 'end' ? el.scrollHeight : s === 'mid' ? (el.scrollHeight - el.clientHeight) / 2 : 0; }, scroll);
    await book.screenshot({ path: shot.replace(/(\.png)?$/, suffix + '.png') });
  };
  assert.deepEqual(await overflow(), [], 'nothing overflows sideways at 1440px');
  await snap('', 'top');
  await snap('-mid', 'mid');
  await snap('-end', 'end');
  await page.setViewportSize({ width: 600, height: 900 });
  await pause(200);
  assert.deepEqual(await overflow(), [], 'nothing overflows sideways at 600px');
  await snap('-narrow', 'top');
  assert.deepEqual(errors, []);
  console.log('PASS: chapter placement, front-page pointer, formatting, three Copy boxes in the app folder, copy text, and no overflow at 1440px or 600px.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-manual-ui-'));
  rmSync(root, { recursive: true, force: true });
}
