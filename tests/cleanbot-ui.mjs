// npm run build && node tests/cleanbot-ui.mjs [screenshot-dir]
// A throwaway office (its own temp building, a scratch git repository as the floor, a fake agent
// instead of Claude) driven in headless Edge: CleanBot waits at his kiosk, is deployed from the floor
// menu, lists the floor's leftovers through office-cleanbot with what he suggests deleting, pins one
// and deletes only the one he's told to. Nothing touches the running office, GitHub or a real agent.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'agent-office-cleanbot-'));
const shotDir = path.resolve(process.argv[2] ?? path.join(root, 'shots'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let host;
let browser;
let logs = '';
try {
  await mkdir(shotDir, { recursive: true });
  const officeDir = path.join(root, 'Office');
  const home = path.join(root, 'home');
  await mkdir(officeDir);
  await mkdir(home);
  // The floor: a repository with two office branches left behind weeks ago (so neither is "just made").
  const old = { GIT_AUTHOR_DATE: '2026-09-01T12:00:00', GIT_COMMITTER_DATE: '2026-09-01T12:00:00' };
  const git = (...args) => execFileSync('git', args, { cwd: officeDir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', ...old } });
  git('init', '-q', '-b', 'personal');
  await writeFile(path.join(officeDir, 'README.md'), '# Test floor\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Initial');
  git('branch', 'office/pixel-1111');
  git('branch', 'office/dot-2222');
  // The fake agent: CleanBot's run, through his own command and the office's endpoint.
  const said = path.join(root, 'cleanbot-said.txt');
  const agent = path.join(root, 'fake-agent.mjs');
  await writeFile(
    agent,
    `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const cb = (...args) => {
  try { return execFileSync(process.execPath, [${JSON.stringify(path.join(codeDir, 'bin', 'office-cleanbot.js'))}, ...args], { encoding: 'utf8' }); }
  catch (e) { return 'FAILED ' + e.message + (e.stdout ?? '') + (e.stderr ?? ''); }
};
const list = cb('list');
console.log(list);
const keep = cb('keep', 'office/dot-2222');
const del = cb('delete', 'office/pixel-1111,office/dot-2222');
console.log(del);
writeFileSync(${JSON.stringify(said)}, [list, keep, del].join('\\n---\\n'));
setInterval(() => {}, 1 << 30);
`,
  );
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = `http://localhost:${port}`;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, officeDir, String(port)], {
    cwd: codeDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_HOME: home, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: agent, AGENT_OFFICE_NO_OPEN: '1' },
  });
  host.stdout.on('data', (d) => (logs += d));
  host.stderr.on('data', (d) => (logs += d));
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}: ${logs}`);
    ready = await fetch(url + '/api/health').then((r) => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'the office came up');
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  context.setDefaultTimeout(90_000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Cleanup test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, hud: { balances: false } }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor && window.__office.player.enabled);
  // The update bar covers the menus after an agent-office merge; the calendar card is this machine's own chores.
  await page.addStyleTag({ content: '.update-bar,.calendar-nag{display:none!important}' });
  const lookAtKiosk = async () => {
    await page.evaluate(() => {
      const { player } = window.__office;
      player.view = 'third';
      player.pos.set(9.6, 0, 3.6);
      player.camYaw = Math.PI;
      player.camPitch = -0.12;
      player.camDist = 0.35;
      player.updateCamera(true);
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await pause(600);
  };

  // 1. CleanBot waits at his kiosk in the lounge, west of the meeting room door, before anyone deploys him.
  const kiosk = await page.evaluate(() => {
    const d = window.__office.office.desks.get('station-cleanbot');
    return d && { x: d.def.x, z: d.def.z, vacant: d.vacancy.visible };
  });
  assert.deepEqual(kiosk, { x: 9.6, z: 7, vacant: true }, 'his kiosk is in the lounge, waiting');
  await lookAtKiosk();
  await page.screenshot({ path: path.join(shotDir, 'cleanbot-kiosk-waiting.png') });
  console.log('PASS: CleanBot waits at his kiosk in the lounge.');

  // 2. The floor menu offers to deploy him.
  await page.click('#project');
  await page.waitForSelector('.floor-menu .cleanbot-section');
  const section = page.locator('.floor-menu .cleanbot-section');
  assert.match(await section.innerText(), /Deploy CleanBot/);
  assert.match(await section.innerText(), /the PR agent, the VP or a queued task/);
  await section.screenshot({ path: path.join(shotDir, 'cleanbot-menu-deploy.png') });
  await page.click('.cleanbot-section .vp-deploy');
  await page.waitForFunction(() => [...window.__office.store.workers.values()].some((w) => w.deskId === 'station-cleanbot' && w.name === 'CleanBot'));
  console.log('PASS: Deploy CleanBot hires him at his kiosk.');

  // 3. From his terminal, office-cleanbot lists the leftovers with a suggestion, pins one, and deletes only what's safe.
  for (let i = 0; i < 1200 && !existsSync(said); i++) await pause(100);
  const [list, keep, del] = readFileSync(said, 'utf8').split('\n---\n');
  assert.match(list, /🧹 CleanBot/, list);
  assert.match(list, /🗑 Suggested to delete \(2, safe/, list);
  assert.match(list, /office-cleanbot delete office\/dot-2222,office\/pixel-1111/, list);
  assert.match(keep, /Always kept from now on: office\/dot-2222/, keep);
  assert.match(del, /removed\s+branch\s+office\/pixel-1111/, del);
  assert.match(del, /kept\s+office\/dot-2222: on the always-keep list/, del);
  assert.equal(execFileSync('git', ['branch', '--list', 'office/*'], { cwd: officeDir, encoding: 'utf8' }).trim(), 'office/dot-2222', 'only the one he was told to delete, and wasn\'t pinned, is gone');
  const log = readFileSync(path.join(officeDir, '.agent-office', 'cleanup-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.match(log[0].by, /^CleanBot, asked by Cleanup test$/);
  console.log('PASS: office-cleanbot lists with a suggestion, keeps the pinned branch and deletes only the other, logged.');

  // 4. His terminal shows the table and the suggestion; the menu now opens it.
  await page.waitForFunction(() => document.querySelector('.cleanbot-section')?.getAttribute('data-cleanbot') === 'here');
  await page.click('.cleanbot-section .vp-deploy');
  await page.waitForFunction(() => /Suggested to delete/.test(document.body.innerText));
  await pause(800);
  await page.screenshot({ path: path.join(shotDir, 'cleanbot-terminal.png') });
  console.log('PASS: the floor menu opens his terminal once he is here.');
  assert.deepEqual(errors, []);
  console.log(`PASS: no browser errors. Screenshots in ${shotDir}`);
} catch (err) {
  console.error(logs.slice(-4000));
  throw err;
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 150 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.ok(path.basename(root).startsWith('agent-office-cleanbot-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
