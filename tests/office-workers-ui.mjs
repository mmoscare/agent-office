// npm run build, then node tests/office-workers-ui.mjs.
// An isolated office with idle Node fixtures (no AI provider, no live office): the PR agent runs
// office-workers from its own PATH, the office refuses what isn't safe, and a clean worker is clocked
// out through the real office, with the toast and the worktree removed.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-workers-ui-'));
const floor = path.join(root, 'project');
const remote = path.join(root, 'project.git');
const agents = path.join(root, 'agents');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function until(what, fn, ms = 90_000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(250)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`Timed out waiting for ${what}`);
}
let host, browser;
let hostErrors = '';
try {
  mkdirSync(floor);
  mkdirSync(agents);
  git(floor, 'init', '-b', 'personal');
  git(floor, 'config', 'user.name', 'Office Workers UI Test');
  git(floor, 'config', 'user.email', 'office-workers-ui@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(floor, 'commit', '--allow-empty', '-m', 'Fixture');
  git(root, 'init', '--bare', '-b', 'personal', remote);
  git(floor, 'remote', 'add', 'origin', remote);
  git(floor, 'push', '-q', '-u', 'origin', 'personal');
  // Every agent here: note who it is and how it reaches the office, finish its turn, then sit idle.
  const fixture = path.join(root, 'agent.cjs');
  writeFileSync(fixture, `
const fs = require('fs'), http = require('http'), path = require('path');
const e = process.env, id = e.AGENT_OFFICE_WORKER_ID;
const pathKey = Object.keys(e).find((k) => k.toUpperCase() === 'PATH');
fs.writeFileSync(path.join(${JSON.stringify(agents)}, id + '.json'), JSON.stringify({ id, url: e.AGENT_OFFICE_HOOK_URL, token: e.AGENT_OFFICE_HOOK_TOKEN, path: e[pathKey], cwd: process.cwd() }));
const hook = (event) => new Promise((ok) => {
  const u = new URL(e.AGENT_OFFICE_HOOK_URL + '/hooks/claude');
  u.searchParams.set('worker', id);
  u.searchParams.set('event', event);
  const req = http.request(u, { method: 'POST', headers: { authorization: 'Bearer ' + e.AGENT_OFFICE_HOOK_TOKEN, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', ok); });
  req.on('error', ok);
  req.end('{}');
});
process.stdout.write('Fixture agent ready\\r\\n');
(async () => { await hook('SessionStart'); await hook('UserPromptSubmit'); await hook('Stop'); })();
process.stdin.resume();
`);
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  host.stderr.on('data', (data) => { hostErrors = (hostErrors + data).slice(-4000); });
  await until('the office to start', async () => {
    assert.equal(host.exitCode, null, hostErrors);
    return fetch(url + '/api/health').then((r) => r.ok, () => false);
  });
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(30000);
  assert.equal((await context.request.post(url + '/api/login', { data: { password } })).status(), 200);
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Workers Test', color: '#ff8a5b', look: {} }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor);
  const workers = () => page.evaluate(() => [...window.__office.store.workers.values()].map((w) => ({ id: w.id, name: w.name, deskId: w.deskId, status: w.status, worktree: w.worktree })));

  // The PR agent at its kiosk, and two workers with worktrees of their own.
  await page.evaluate(() => {
    const n = window.__office.net;
    n.send({ t: 'station.prompt', deskId: 'station-pulls', prompt: 'Look after the PRs' });
    n.send({ t: 'worker.spawn', deskId: 'desk-1', prompt: 'What does app.txt do?', worktree: true });
    n.send({ t: 'worker.spawn', deskId: 'desk-2', prompt: 'Start on the login page', worktree: true });
  });
  const seated = await until('three agents done at their desks', async () => {
    const ws = await workers();
    return ws.length === 3 && ws.every((w) => w.status === 'done') && ws;
  });
  const byDesk = Object.fromEntries(seated.map((w) => [w.deskId, w]));
  const [kiosk, first, second] = [byDesk['station-pulls'], byDesk['desk-1'], byDesk['desk-2']];
  assert.ok(first.worktree && second.worktree);
  const envOf = (w) => {
    const a = JSON.parse(readFileSync(path.join(agents, w.id + '.json'), 'utf8'));
    return { ...process.env, PATH: a.path, Path: a.path, AGENT_OFFICE_HOOK_URL: a.url, AGENT_OFFICE_WORKER_ID: a.id, AGENT_OFFICE_HOOK_TOKEN: a.token };
  };
  await until('every agent to note its token', () => [kiosk, first, second].every((w) => existsSync(path.join(agents, w.id + '.json'))));
  // The command as the PR agent runs it: off its PATH (the .cmd shim on Windows), with its own token.
  const run = (w, ...args) => {
    const r = spawnSync(`office-workers ${args.join(' ')}`, { env: envOf(w), encoding: 'utf8', shell: true, windowsHide: true, timeout: 120_000 });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };

  const list = run(kiosk, 'list');
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^3 workers on this floor/);
  assert.match(list.out, new RegExp(`${first.id}  done .*${first.name} · Desk 1[^]*?worktree clean, nothing unpushed, 0 commits of its own · ✓ can clock out`));
  assert.match(list.out, /PR agent · PR board[^]*?board agent · ✗ stays: PR agent is a board agent/);
  const json = JSON.parse(run(kiosk, 'list', '--json').out);
  assert.equal(json.workers.length, 3);

  // A desk worker can't use it at all.
  const desk = run(first, 'list');
  assert.equal(desk.code, 1);
  assert.match(desk.err, /The office said no \(403\): Only the agents standing by the boards can use office-workers/);

  // Unsafe: uncommitted work, a board agent, a name instead of an id.
  writeFileSync(path.join(floor, second.worktree.path, 'login.txt'), 'half done\n');
  const dirty = run(kiosk, 'home', second.id, '--remove-worktree');
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, new RegExp(`The office said no \\(409\\): ${second.name} has 1 uncommitted change in .*: clocking it out would leave that work unshipped`));
  assert.match(run(kiosk, 'home', kiosk.id).err, /\(409\): PR agent is a board agent: only a person clocks those out/);
  assert.match(run(kiosk, 'home', second.name).err, /\(400\): Give the worker's id, not its name, since names are reused/);

  // Safe: the clean one goes, its worktree and branch with it, and the floor hears who sent it. The
  // toasts only last a few seconds and the command blocks this script, so the page keeps a note of them,
  // and of the worker walking out (the clock-out wave X plays too).
  await page.evaluate(() => {
    window.__toastsSeen = [];
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) window.__toastsSeen.push(n.textContent); }).observe(document.getElementById('toasts'), { childList: true });
    const d = window.__office.departures;
    const add = d.add.bind(d);
    window.__waved = 0;
    d.add = (...a) => { window.__waved++; return add(...a); };
  });
  const home = run(kiosk, 'home', first.id, '--remove-worktree');
  assert.equal(home.code, 0, home.err);
  assert.equal(home.out, `Clocked out ${first.name} (${first.id}).\nDeleted ${first.name}'s worktree and branch ${first.worktree.branch}.`);
  const seen = await until('the toasts', async () => {
    const t = await page.evaluate(() => window.__toastsSeen);
    return t.includes(`🏠 The PR agent clocked out ${first.name}`) && t.includes(`Deleted ${first.name}'s worktree and branch ${first.worktree.branch}`) && t;
  });
  assert.ok(seen);
  await until('the worker to leave', async () => !(await workers()).some((w) => w.id === first.id));
  assert.equal(await page.evaluate(() => window.__waved), 1);
  assert.equal(existsSync(path.join(floor, first.worktree.path)), false);
  assert.equal(git(floor, 'for-each-ref', `refs/heads/${first.worktree.branch}`), '');
  // The other stays, work and all.
  assert.ok((await workers()).some((w) => w.id === second.id));
  assert.ok(existsSync(path.join(floor, second.worktree.path, 'login.txt')));
  assert.deepEqual(readdirSync(agents).length, 3);
  assert.equal(errors.length, 0, errors.join('\n'));

  await browser.close(); browser = null;
  host.stdin.write('stop\n');
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Host did not stop')), 30000); host.once('exit', () => { clearTimeout(timer); resolve(); }); });
  assert.equal(host.exitCode, 0, hostErrors);
  console.log('PASS: office-workers on the PR agent\'s PATH lists the floor; the office refuses desk workers, uncommitted work, board agents and names; a clean worker is clocked out with its worktree and branch removed, the toast names the PR agent, and the other worker stays.');
} finally {
  if (browser) await browser.close();
  if (host && host.exitCode === null) {
    host.stdin.write('stop\n');
    for (let i = 0; i < 150 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-workers-ui-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
