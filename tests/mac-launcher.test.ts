import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — the launcher is plain JavaScript (no build step) so it runs on a Mac straight from the checkout.
import { currentBranch, healthy, loadSettings, officePassword, problem, supervise } from '../personal/mac/launcher.mjs';
// @ts-expect-error — as above.
import { appScript, BUNDLE_ID, commandScript, install, sh } from '../personal/mac/install-launcher.mjs';

// The Mac launcher (personal/mac): launcher.mjs runs the office through host.mjs in a Terminal window
// and starts it again on 75/76, as Launcher.cs does on Windows; install-launcher.mjs writes the
// Agent Office.app that opens it. The "office" here is a stand-in host, so no real office starts.

/** A stand-in for host.mjs: answers /api/health, stops on "stop", and exits as plan.json says for each start. */
const FAKE_HOST = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const [, officeDir, port] = process.argv.slice(2);
const at = (f) => path.join(officeDir, f);
const plan = JSON.parse(fs.readFileSync(at('plan.json'), 'utf8'));
const n = fs.existsSync(at('starts')) ? Number(fs.readFileSync(at('starts'), 'utf8')) : 0;
fs.writeFileSync(at('starts'), String(n + 1));
fs.appendFileSync(at('env'), (process.env.AGENT_OFFICE_PASSWORD ?? '-') + '\\n');
const step = plan[Math.min(n, plan.length - 1)];
console.log('fake office start ' + (n + 1));
if (step.exitBeforeReady !== undefined) process.exit(step.exitBeforeReady);
const server = http.createServer((req, res) => res.end('{"ok": true}')).listen(Number(port), '127.0.0.1', () => {
  if (step.exitAfterReady !== undefined) setTimeout(() => process.exit(step.exitAfterReady), 1000);
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line !== 'stop') return;
  fs.appendFileSync(at('stops'), 'stop\\n');
  server.close();
  process.exit(0);
});
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function office(plan: object[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mac-launcher-'));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  const host = path.join(dir, 'host.mjs');
  writeFileSync(host, FAKE_HOST);
  const port = await freePort();
  const lines: string[] = [];
  let opens = 0;
  const run = supervise({ codeDir: dir, officeDir: dir, port, host, env: { AGENT_OFFICE_PASSWORD: 'pw' }, open: () => opens++, out: (l: string) => lines.push(l) });
  const starts = () => (existsSync(path.join(dir, 'starts')) ? Number(readFileSync(path.join(dir, 'starts'), 'utf8')) : 0);
  return { dir, port, run, lines, starts, opens: () => opens, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('supervise: an office that asks for a restart (75) is started again without a second browser tab; stop() stops it the graceful way', async () => {
  const o = await office([{ exitAfterReady: 75 }, {}]);
  try {
    await until('the second start', async () => o.starts() === 2 && (await healthy(o.port)));
    o.run.stop();
    assert.equal(await o.run.done, 0);
    assert.equal(o.opens(), 1);
    assert.equal(readFileSync(path.join(o.dir, 'stops'), 'utf8'), 'stop\n', 'host.mjs was sent its "stop" line');
    assert.deepEqual(readFileSync(path.join(o.dir, 'env'), 'utf8').trim().split('\n'), ['pw', 'pw'], 'the password reaches every start');
    assert.ok(o.lines.includes('fake office start 1') && o.lines.some((l) => l.includes('asked to be started again (exit code 75)')));
  } finally { o.close(); }
});

test('supervise: a new build that did not start (76) is started again, and Chrome opens once that one is up', async () => {
  const o = await office([{ exitBeforeReady: 76 }, {}]);
  try {
    await until('the browser', () => o.opens() === 1);
    assert.equal(o.starts(), 2);
    o.run.stop();
    assert.equal(await o.run.done, 0);
  } finally { o.close(); }
});

test('supervise: gives up after three starts that fail, and after an office that stops by itself', async () => {
  const failing = await office([{ exitBeforeReady: 76 }]);
  try {
    assert.equal(await failing.run.done, 76);
    assert.equal(failing.starts(), 3);
    assert.equal(failing.opens(), 0);
    assert.ok(failing.lines.some((l) => l.includes('could not start')));
  } finally { failing.close(); }
  const crashing = await office([{ exitAfterReady: 1 }]);
  try {
    assert.equal(await crashing.run.done, 1);
    assert.equal(crashing.starts(), 1, 'an exit that is not 75/76 is not a restart');
    assert.equal(crashing.opens(), 1);
    assert.ok(crashing.lines.includes('Agent Office stopped (exit code 1).'));
  } finally { crashing.close(); }
});

test('supervise: restart() stops the office and starts it again', async () => {
  const o = await office([{}]);
  try {
    await until('the first start', () => o.opens() === 1);
    o.run.restart();
    await until('the restart', async () => o.starts() === 2 && (await healthy(o.port)));
    o.run.stop();
    assert.equal(await o.run.done, 0);
    assert.equal(o.opens(), 1, 'no second tab: the page reconnects by itself');
  } finally { o.close(); }
});

test('supervise with the real host.mjs: the update walkthrough restart (75) comes back up, and stop reaches the office as Ctrl+C', async () => {
  const code = mkdtempSync(path.join(tmpdir(), 'mac-launcher-host-'));
  try {
    // A stand-in build: its cli.js listens, asks host.mjs for a restart on its first start, and says how it was stopped.
    mkdirSync(path.join(code, 'dist', 'server', 'server'), { recursive: true });
    writeFileSync(path.join(code, 'dist', 'server', 'server', 'cli.js'), `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const starts = path.join(dir, 'starts');
const n = (fs.existsSync(starts) ? Number(fs.readFileSync(starts, 'utf8')) : 0) + 1;
fs.writeFileSync(starts, String(n));
const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true })));
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const stop = (signal) => { fs.appendFileSync(path.join(dir, 'stopped'), signal + '\\n'); server.close(); setTimeout(() => process.exit(0), 20); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (n === 1) setTimeout(() => globalThis[Symbol.for('agent-office.launcher')].restart(), 300);
`);
    const port = await freePort();
    let opens = 0;
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const run = supervise({ codeDir: code, officeDir: code, port, host: path.join(repo, 'personal', 'windows', 'host.mjs'), open: () => opens++, out: () => {} });
    const starts = () => (existsSync(path.join(code, 'starts')) ? Number(readFileSync(path.join(code, 'starts'), 'utf8')) : 0);
    await until('the restart the office asked for', async () => starts() === 2 && (await healthy(port)));
    run.stop();
    assert.equal(await run.done, 0);
    assert.equal(opens, 1);
    assert.deepEqual(readFileSync(path.join(code, 'stopped'), 'utf8').trim().split('\n'), ['SIGTERM', 'SIGINT'], 'the restart keeps workers (SIGTERM); stop closes them (SIGINT)');
  } finally { rmSync(code, { recursive: true, force: true }); }
});

test('the checks Launcher.cs makes: built, on the personal branch, office folder there', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mac-launcher-checks-'));
  try {
    const code = path.join(dir, 'code');
    const office = path.join(dir, 'office');
    mkdirSync(path.join(code, '.git'), { recursive: true });
    mkdirSync(office);
    writeFileSync(path.join(code, '.git', 'HEAD'), 'ref: refs/heads/personal\n');
    const settings = { codeDir: code, officeDir: office, branch: 'personal' };
    assert.match(problem(settings), /needs a build/);
    mkdirSync(path.join(code, 'dist', 'server', 'server'), { recursive: true });
    writeFileSync(path.join(code, 'dist', 'server', 'server', 'cli.js'), '');
    assert.equal(problem(settings), null);
    writeFileSync(path.join(code, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.match(problem(settings), /uses your personal branch/);
    writeFileSync(path.join(code, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(currentBranch(code), null, 'a detached HEAD is no branch');
    assert.match(problem({ ...settings, officeDir: path.join(dir, 'nope') }), /office folder .* is missing/);
    // A linked worktree: .git is a file naming the real git folder.
    const wt = path.join(dir, 'wt');
    mkdirSync(path.join(dir, 'wt-git'), { recursive: true });
    mkdirSync(wt);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, 'wt-git')}\n`);
    writeFileSync(path.join(dir, 'wt-git', 'HEAD'), 'ref: refs/heads/personal\n');
    assert.equal(currentBranch(wt), 'personal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the password: from the keychain, asked for once, or none when the office keeps its own login', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mac-launcher-pw-'));
  try {
    const kept = new Map<string, string>();
    let asked = 0;
    const chain = { find: (a: string) => kept.get(a) ?? null, ask: (a: string) => { asked++; kept.set(a, 'typed'); } };
    const quiet = () => {};
    assert.equal(officePassword(dir, chain, quiet), 'typed');
    assert.equal(officePassword(dir, chain, quiet), 'typed');
    assert.equal(asked, 1, 'asked for only the first time');
    assert.throws(() => officePassword(dir, { find: () => null, ask: () => {} }, quiet), /No password was saved/);
    mkdirSync(path.join(dir, '.agent-office'));
    writeFileSync(path.join(dir, '.agent-office', 'config.json'), '{"salt":"00","verifier":"ab"}');
    assert.equal(officePassword(dir, { find: () => null, ask: () => { throw new Error('should not ask'); } }, quiet), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('install writes the settings, the server window and Agent Office.app, and only ever replaces its own app', () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mac launcher's install-"));
  try {
    const office = path.join(dir, 'Personal-Portfolio');
    mkdirSync(office);
    const support = path.join(dir, 'Application Support', 'Agent Office');
    const apps = path.join(dir, 'Applications');
    const code = path.join(dir, 'agent office');
    const done = install({ codeDir: code, officeDir: office, port: 4611, appsDir: apps, supportDir: support, node: '/opt/homebrew/bin/node', icon: false });
    assert.deepEqual(loadSettings(support), { codeDir: code, officeDir: office, port: 4611, branch: 'personal' });
    const plist = readFileSync(path.join(done.app, 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>Agent Office<\/string>/);
    assert.ok(plist.includes(`<string>${BUNDLE_ID}</string>`));
    const exe = path.join(done.app, 'Contents', 'MacOS', 'Agent Office');
    const script = readFileSync(exe, 'utf8');
    assert.ok(script.includes(`SUPPORT=${sh(support)}`) && script.includes("'http://127.0.0.1:4611/api/health'"));
    assert.equal(readFileSync(done.command, 'utf8'), commandScript({ codeDir: code, node: '/opt/homebrew/bin/node' }));
    if (process.platform !== 'win32') {
      assert.equal(statSync(exe).mode & 0o111, 0o111);
      assert.equal(statSync(done.command).mode & 0o111, 0o111);
    }
    assert.equal(done.icon, false);
    // Again (a new port, say): its own app is replaced.
    install({ codeDir: code, officeDir: office, port: 4612, appsDir: apps, supportDir: support, icon: false });
    assert.ok(readFileSync(exe, 'utf8').includes('4612'));
    // Someone else's app of that name is left alone.
    const other = path.join(dir, 'Other');
    mkdirSync(path.join(other, 'Agent Office.app', 'Contents'), { recursive: true });
    writeFileSync(path.join(other, 'Agent Office.app', 'Contents', 'Info.plist'), '<plist><string>com.example.other</string></plist>');
    assert.throws(() => install({ codeDir: code, officeDir: office, appsDir: other, supportDir: support, icon: false }), /isn't this launcher/);
    assert.throws(() => install({ codeDir: code, officeDir: path.join(dir, 'missing'), appsDir: apps, supportDir: support, icon: false }), /doesn't exist yet/);
    assert.throws(() => loadSettings(path.join(dir, 'nowhere')), /No launcher settings/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the app and window scripts are valid shell, with any folder name quoted', (t) => {
  // On Windows, `bash` may be WSL's, which sees other paths; the Mac and Linux run this.
  if (process.platform === 'win32') return t.skip('checked on macOS and Linux');
  const bash = 'bash';
  try { execFileSync(bash, ['-c', 'true'], { stdio: 'ignore' }); } catch { return t.skip('no bash here'); }
  const dir = mkdtempSync(path.join(tmpdir(), 'mac-launcher-sh-'));
  try {
    const odd = "/Users/me/Documents/It's a folder $HOME `x`";
    for (const [name, text] of [['app.sh', appScript({ supportDir: odd, port: 4600 })], ['window.sh', commandScript({ codeDir: odd, node: odd })]]) {
      const file = path.join(dir, name);
      writeFileSync(file, text);
      execFileSync(bash, ['-n', file]);
    }
    assert.equal(execFileSync(bash, ['-c', `printf %s ${sh(odd)}`], { encoding: 'utf8' }), odd);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
