// npm run build, then node tests/wip-checkpoint-launcher.mjs.
// Runs a harmless custom Node worker in a temporary office through the Windows launcher host.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'office-checkpoint-launcher-'));
const floor = path.join(root, 'project');
const data = path.join(floor, '.agent-office');
const rel = '.agent-office/worktrees/checkpoint-fixture';
const worktree = path.join(floor, rel);
const branch = 'office/checkpoint-fixture';
const record = path.join(root, 'launch.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let host, ws;
let log = '';
try {
  mkdirSync(floor);
  git(floor, 'init', '-q', '-b', 'main');
  git(floor, 'config', 'user.name', 'Checkpoint Launcher Test');
  git(floor, 'config', 'user.email', 'checkpoint-test@example.invalid');
  git(floor, 'config', 'commit.gpgsign', 'false');
  git(floor, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  writeFileSync(path.join(floor, '.gitignore'), '.agent-office/\n');
  writeFileSync(path.join(floor, 'app.txt'), 'before\n');
  git(floor, 'add', '.');
  git(floor, 'commit', '-q', '-m', 'Fixture');
  const base = git(floor, 'rev-parse', 'HEAD');
  git(floor, 'worktree', 'add', '-q', '-b', branch, rel);
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([{
    id: 'checkpoint-fixture', deskId: 'desk-1', kind: 'agent', provider: 'custom', name: 'Checkpoint fixture',
    prompt: 'Wait for the test to stop the office.', worktree: { path: rel, branch, base, from: 'main' },
  }]));
  const fixture = path.join(root, 'idle.cjs');
  writeFileSync(fixture, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv)); process.stdin.resume();`);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = 'http://localhost:' + port;
  const password = randomUUID();
  host = spawn(process.execPath, [path.join(codeDir, 'personal/windows/host.mjs'), codeDir, floor, String(port)], {
    cwd: codeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_OFFICE_PASSWORD: password, AGENT_OFFICE_AGENT: process.execPath, AGENT_OFFICE_AGENT_ARGS: JSON.stringify(fixture) },
  });
  host.stdout.on('data', value => { log = (log + value).slice(-10000); });
  host.stderr.on('data', value => { log = (log + value).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    assert.equal(host.exitCode, null, log);
    ready = await fetch(url + '/api/health').then(r => r.ok, () => false);
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, 'the launcher starts the built office');
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  ws = new WebSocket(url.replace('http:', 'ws:') + '/ws?name=Checkpoint%20Test', { headers: { Cookie: cookie, Origin: url } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  for (let i = 0; i < 200 && !existsSync(record); i++) await pause(100);
  assert.ok(existsSync(record), 'the harmless custom worker really launched');
  writeFileSync(path.join(worktree, 'app.txt'), 'saved when the office stops\n');
  const stopped = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Launcher stop exceeded 15 seconds')), 15000);
    host.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const started = Date.now();
  host.stdin.write('stop\n');
  assert.equal(await stopped, 0, log);
  assert.ok(Date.now() - started < 10000, 'shutdown fits the launcher wait');
  const hash = git(worktree, 'rev-parse', 'HEAD');
  assert.notEqual(hash, base);
  assert.match(git(worktree, 'log', '-1', '--format=%s'), /^WIP checkpoint: office restart /);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(floor, 'rev-parse', 'HEAD'), base, 'main checkout stays untouched');
  const saved = JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8'));
  assert.equal(saved.find(w => w.id === 'checkpoint-fixture').checkpoints[0].hash, hash);
  assert.equal(saved.find(w => w.id === 'checkpoint-fixture').checkpoints[0].branch, branch);
  assert.equal(await fetch(url + '/api/health').then(r => r.ok, () => false), false);
  console.log('PASS: launcher starts a custom worker, stop creates a clean WIP commit and persists its hash, main checkout stays untouched, and host exits within 10 seconds.');
} finally {
  ws?.terminate();
  if (host && host.exitCode === null) {
    host.stdin.end('stop\n');
    for (let i = 0; i < 100 && host.exitCode === null; i++) await pause(100);
    if (host.exitCode === null) host.kill();
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('office-checkpoint-launcher-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
