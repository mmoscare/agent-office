#!/usr/bin/env node
// The Mac's Agent Office launcher: what personal/windows/Launcher.cs does on Windows, in a Terminal
// window instead of a tray icon. "Agent Office.app" (install-launcher.mjs) opens the office in Chrome
// when it is running, and otherwise opens this in Terminal, which:
//
//   - checks the checkout (built, on the personal branch) and the office folder, as Launcher.cs does;
//   - takes the office password from the login keychain, asking for it the first time;
//   - runs the office through personal/windows/host.mjs (plain node, nothing Windows about it) and
//     starts it again when host.mjs exits 75 (the office asked to be restarted for an update) or 76
//     (a new build didn't start and the previous one was put back), without another browser tab;
//   - opens Chrome once the office is ready, and shows the server's output here and in server.log.
//
// Ctrl+C here or closing the window stops the office and its workers; a second Ctrl+C, or an office
// that hasn't stopped after a while, ends it by force. r + Enter restarts it: on a Mac the workers keep
// running in their terminal host (src/server/ptys.ts) and the next office picks them up. o + Enter
// opens it in Chrome.
//
//   node personal/mac/launcher.mjs [--forget-password]

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const RESTART = 75;
export const ROLLED_BACK = 76;
export const startsAgain = (code) => code === RESTART || code === ROLLED_BACK;
export const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Agent Office');
const KEYCHAIN_SERVICE = 'Agent Office';
/** How long a start may take before it counts as failed (Launcher.cs waits as long). */
const READY_MS = 90_000;
/**
 * How long a graceful stop may take before the office is ended by force. Launcher.cs gives up after
 * 10 s; the office's own second Ctrl+C forces its exit sooner than this.
 */
const STOP_MS = 15_000;
const POLL_MS = 300;

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** What install-launcher.mjs saved: this checkout, the office folder, the port and the branch. */
export function loadSettings(supportDir = SUPPORT_DIR) {
  const file = path.join(supportDir, 'settings.json');
  const saved = readJson(file);
  if (!saved?.codeDir) throw new Error(`No launcher settings in ${file}. Run: node personal/mac/install-launcher.mjs`);
  return { port: 4600, branch: 'personal', ...saved };
}

/** The branch a checkout is on (null when detached), from .git/HEAD as Launcher.cs reads it. */
export function currentBranch(codeDir) {
  try {
    let gitDir = path.join(codeDir, '.git');
    if (statSync(gitDir).isFile()) gitDir = path.resolve(codeDir, readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

/** Why the office can't be started from these settings, or null. */
export function problem({ codeDir, officeDir, branch }) {
  if (!officeDir || !existsSync(officeDir)) return `The office folder ${officeDir} is missing. Run the launcher installer again with --office <folder>.`;
  if (!existsSync(path.join(codeDir, 'dist', 'server', 'server', 'cli.js'))) return `Your personal Agent Office needs a build. Run npm run build in ${codeDir}`;
  if (currentBranch(codeDir) !== branch) return `This launcher uses your ${branch} branch. Switch the Agent Office checkout in ${codeDir} to ${branch} before launching.`;
  return null;
}

/** Whether an office answers on this port. The IPv4 loopback, as Launcher.cs probes it. */
export function healthy(port, timeout = 600) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(/"ok"\s*:\s*true/.test(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export function openBrowser(url) {
  try { execFileSync('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' }); return; } catch { /* no Chrome: the default browser */ }
  try { execFileSync('open', [url], { stdio: 'ignore' }); } catch { console.log(`Open ${url} in your browser.`); }
}

/** The login keychain, through macOS's `security`. The password is never on a command line. */
export const keychain = {
  /** Runs `security` (the tests stand in for it here). */
  security: (args, options) => execFileSync('security', args, options),
  find(account) {
    try {
      return keychain.security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '') || null;
    } catch {
      return null;
    }
  },
  /**
   * `-w` last, with no value: security asks for the password (twice) in this terminal. That is how
   * its man page says to be prompted ("Put at end of command to be prompted (recommended)"); without
   * `-w` at all it would save an empty password.
   */
  ask(account) {
    try { keychain.security(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-l', 'Agent Office password', '-w'], { stdio: 'inherit' }); } catch { /* cancelled or mistyped */ }
  },
  forget(account) {
    try { keychain.security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' }); return true; } catch { return false; }
  },
};

/**
 * The office password: the one the keychain keeps for this office folder, or asked for once and kept
 * there. Null when the office keeps a login of its own (a generated password in its config.json), as
 * Launcher.cs does.
 */
export function officePassword(officeDir, chain = keychain, say = console.log) {
  const saved = chain.find(officeDir);
  if (saved) return saved;
  if (readJson(path.join(officeDir, '.agent-office', 'config.json'))?.verifier) return null;
  say('First start on this Mac: type the password you use for Agent Office, then type it again.');
  say('Your login keychain remembers it for this launcher.');
  chain.ask(officeDir);
  const pw = chain.find(officeDir);
  if (!pw) throw new Error('No password was saved (the prompt was cancelled, or the two entries differed), so the office was not started. Double-click Agent Office to try again.');
  return pw;
}

/**
 * Runs the office until it stops for good, starting it again when host.mjs exits 75 or 76 (the page
 * reconnects by itself, so no new browser tab) or when restart() asked for it. `done` settles with the
 * last exit code, or 1 when it never became ready or had to be ended by force.
 */
export function supervise({
  codeDir, officeDir, port, env = {},
  host = path.join(codeDir, 'personal', 'windows', 'host.mjs'),
  node = process.execPath, nodeArgs = [],
  open = () => openBrowser(`http://localhost:${port}`),
  out = (line) => console.log(line), log = () => {},
  readyMs = READY_MS, stopMs = STOP_MS,
}) {
  let child = null;
  let stopping = false;
  let restarting = false;
  let failed = false;
  let forced = false;
  let stopTimer = null;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const say = (line) => { out(line); log(line); };

  function start(openWhenReady, attempt = 1) {
    let ready = false;
    let exited = false;
    const proc = spawn(node, [...nodeArgs, host, codeDir, officeDir, String(port)], {
      cwd: codeDir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the terminal's Ctrl+C or hang-up reaches only this launcher, which
      // then stops the office the graceful way (host.mjs's "stop" line).
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child = proc;
    proc.stdin.on('error', () => {});
    for (const stream of [proc.stdout, proc.stderr]) createInterface({ input: stream }).on('line', say);
    proc.on('error', (err) => say(`agent-office launcher: ${err.message}`));
    proc.on('exit', (code, signal) => {
      exited = true;
      child = null;
      if (stopping) {
        clearTimeout(stopTimer);
        return finish(failed || forced ? 1 : code ?? 0);
      }
      if (restarting) {
        restarting = false;
        return start(openWhenReady && !ready);
      }
      if (!ready) {
        // A new build that didn't start: host.mjs put the previous one back, so start that.
        if (startsAgain(code) && attempt < 3) return start(openWhenReady, attempt + 1);
        say(`Agent Office could not start (exit code ${code ?? signal}). See server.log.`);
        return finish(code || 1);
      }
      if (startsAgain(code)) {
        say(`--- Agent Office asked to be started again (exit code ${code}) ---`);
        return start(false);
      }
      say(`Agent Office stopped (exit code ${code ?? signal}).`);
      finish(code ?? 1);
    });
    const deadline = Date.now() + readyMs;
    (async function waitReady() {
      while (!exited && !stopping) {
        if (await healthy(port)) {
          ready = true;
          if (openWhenReady) open();
          return;
        }
        if (Date.now() > deadline) {
          say('Agent Office did not become ready. See server.log.');
          failed = true;
          stop();
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
  }

  /**
   * Ends the office at once: its whole process group (host.mjs was started in its own), so nothing of
   * a start that hung is left behind.
   */
  function killNow() {
    if (!child) return;
    forced = true;
    say('Ending Agent Office now.');
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* gone already */ }
    }
  }

  /**
   * Ctrl+C: closes the office and its workers through host.mjs's "stop" line. The office gets stopMs
   * for that (a start that hung before host.mjs reads its stdin never sees the line); after that, or
   * on a second stop() (a second Ctrl+C), it is ended by force, as the office's own second Ctrl+C does.
   */
  function stop() {
    if (stopping) return killNow();
    stopping = true;
    if (!child) return finish(0);
    child.stdin.write('stop\n');
    stopTimer = setTimeout(() => {
      say(`Agent Office did not stop within ${Math.round(stopMs / 1000)} s.`);
      killNow();
    }, stopMs);
    stopTimer.unref?.();
  }

  /** Stops the office the way a restart does (SIGTERM: workers keep running), then starts it again. */
  function restart() {
    if (!child || stopping || restarting) return;
    restarting = true;
    say('--- restarting Agent Office ---');
    child.kill('SIGTERM');
  }

  start(true);
  return { done, stop, restart, get pid() { return child?.pid; } };
}

// ---------------------------------------------------------------------------
// the window

/** The command line a process is running, from ps, or null when there is no such process. */
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether pid is a running launcher.mjs. launcher.pid outlives a launcher that was killed outright
 * or a restart of the Mac, and the kernel gives its pid out again, so a live pid alone isn't enough:
 * the process has to be running this file (Agent Office.app makes the same check).
 */
export function isLauncher(pid, command = commandOf) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (err) { if (err.code !== 'EPERM') return false; }
  return /(^|[\s/])launcher\.mjs(\s|$)/.test(command(pid) ?? '');
}

/** Another launcher's pid, when one is running (or starting the office) right now. */
function otherLauncher(supportDir) {
  let pid;
  try { pid = Number(readFileSync(path.join(supportDir, 'launcher.pid'), 'utf8').trim()); } catch { return null; }
  return isLauncher(pid) ? pid : null;
}

export async function main(argv = process.argv.slice(2), supportDir = SUPPORT_DIR) {
  const settings = loadSettings(supportDir);
  const url = `http://localhost:${settings.port}`;
  if (argv.includes('--forget-password')) {
    console.log(keychain.forget(settings.officeDir) ? 'The keychain no longer keeps the Agent Office password; the next start asks for it.' : 'The keychain had no Agent Office password for this office.');
    return 0;
  }
  const why = problem(settings);
  if (why) { console.error(why); return 1; }
  mkdirSync(supportDir, { recursive: true, mode: 0o700 });
  if (otherLauncher(supportDir) || await healthy(settings.port)) {
    console.log('Agent Office is already running; opening it.');
    openBrowser(url);
    return 0;
  }
  const lock = path.join(supportDir, 'launcher.pid');
  writeFileSync(lock, String(process.pid));
  process.on('exit', () => { try { if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock); } catch { /* gone already */ } });

  process.stdout.write('\x1b]0;Agent Office server\x07');
  let password;
  try { password = officePassword(settings.officeDir); } catch (err) { console.error(err.message); return 1; }
  const logFile = path.join(supportDir, 'server.log');
  const log = (line) => { try { appendFileSync(logFile, line + '\n'); } catch { /* the log is a courtesy */ } };
  log(`--- Agent Office started ${new Date().toISOString()} ---`);
  console.log('Agent Office server. Close this window or press Ctrl+C to stop the office.');
  console.log('Type o + Enter to open it in Chrome, r + Enter to restart it.\n');

  // The window closing takes the terminal away: keep going (quietly) until the office has stopped.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const office = supervise({ ...settings, env: password ? { AGENT_OFFICE_PASSWORD: password } : {}, log, out: (line) => { try { console.log(line); } catch { /* no terminal */ } } });
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => office.stop());
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const c = line.trim().toLowerCase();
    if (c === 'r') office.restart();
    else if (c === 'o') openBrowser(url);
    else if (c === 'q' || c === 'stop') office.stop();
  });
  const code = await office.done;
  input.close();
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
