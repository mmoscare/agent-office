import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { retoldTask, withWorkerHandoff, withoutWorkerHandoff } from '../src/server/handoff.js';
import { notStarted, reportsIn, watchesSilence } from '../src/server/agent-start.js';
import { isAsleep } from '../src/shared/status.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

type Launch = { kind: string; args: string[]; worker?: string; token?: string; session?: string; autoupdate?: string; config?: string };

/** A fake agent CLI: notes how it was launched, then does what the test's mode file says. */
const FAKE = `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({
  kind: path.basename(process.argv[1]).replace(/\\.cjs$/, ''),
  args: process.argv.slice(2),
  worker: process.env.AGENT_OFFICE_WORKER_ID,
  token: process.env.AGENT_OFFICE_HOOK_TOKEN,
  session: process.env.AGENT_OFFICE_SESSION_ID,
  autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE,
  config: process.env.OPENCODE_CONFIG_CONTENT,
}) + '\\n');
const mode = fs.readFileSync(process.env.FAKE_AGENT_MODE, 'utf8').trim();
if (mode === 'bun') {
  // What a damaged OpenCode install does: plain Bun takes the first argument for a script.
  process.stdout.write('error: Script not found "' + process.argv[3] + '"\\r\\n');
  setTimeout(() => process.exit(1), 200);
} else if (mode === 'exit') {
  process.stdout.write('failed to start: no credentials\\r\\n');
  setTimeout(() => process.exit(3), 1000);
} else {
  process.stdout.write('fake agent up\\r\\n');
  setInterval(() => {}, 1000);
}
`;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-office-start-'));
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  mkdirSync(bin);
  mkdirSync(data);
  const log = path.join(root, 'launches.jsonl');
  const mode = path.join(root, 'mode');
  writeFileSync(log, '');
  writeFileSync(mode, 'run');
  for (const name of ['opencode', 'codex']) {
    if (process.platform === 'win32') {
      // npm's Node launcher, which the office unwraps to run node directly (see windows-command.ts).
      writeFileSync(path.join(bin, `${name}.cjs`), FAKE);
      writeFileSync(path.join(bin, `${name}.cmd`), `@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\${name}.cjs" %*\r\n`);
    } else {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${FAKE}`, { mode: 0o700 });
    }
  }
  const saved = { PATH: process.env.PATH, FAKE_AGENT_LOG: process.env.FAKE_AGENT_LOG, FAKE_AGENT_MODE: process.env.FAKE_AGENT_MODE, OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE };
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.FAKE_AGENT_LOG = log;
  process.env.FAKE_AGENT_MODE = mode;
  delete process.env.OPENCODE_DISABLE_AUTOUPDATE;
  const managers: WorkerManager[] = [];
  const toasts: string[] = [];
  t.after(() => {
    for (const m of managers) m.shutdown();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Windows may still hold the killed agents' working directory for a moment.
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left in the temp dir */ }
  });
  return {
    opencode: path.join(bin, 'opencode'),
    toasts,
    mode: (m: 'run' | 'bun' | 'exit') => writeFileSync(mode, m),
    launches: (kind = 'opencode'): Launch[] => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch).filter((l) => l.kind === kind),
    manager(): WorkerManager {
      const events: WorkerEvents = { update() {}, remove() {}, data() {}, sideData() {}, screen() {}, toast: (text) => toasts.push(text) };
      const m = new WorkerManager(root, data, path.join(bin, 'opencode'), [], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
      managers.push(m);
      return m;
    },
  };
}

async function waitFor<T>(read: () => T, ok: (value: T) => boolean, what: string, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  let value = read();
  while (!ok(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  assert.ok(ok(value), `timed out waiting for ${what}`);
  return value;
}

function hired(info: WorkerInfo | string): WorkerInfo {
  if (typeof info === 'string') assert.fail(info);
  return info;
}

/** Everything cmd.exe, CommandLineToArgvW or a shell could split or eat, over several lines. */
const PROMPT = [
  'Fix "the <login> page" & 100% of it | now ^ and `this`; $HOME',
  "second line: it's C:\\path\\\"quoted\\\" %PATH% !x!",
  '',
  '<agent-office-note attr="1">keep > all < of it</agent-office-note> \\\\server\\share\\',
].join('\n');

test('an agent that never reported in did not start, with a clear line for its desk', () => {
  assert.deepEqual([reportsIn('claude'), reportsIn('codex'), reportsIn('opencode'), reportsIn('custom')], [true, true, true, false]);
  assert.deepEqual([watchesSilence('opencode', false), watchesSilence('codex', true), watchesSilence('codex', false), watchesSilence('claude', true)], [true, true, false, false]);
  const bun = notStarted('opencode', 1, 'error: Script not found "When I create a task\n..."');
  assert.match(bun.activity, /OpenCode's install is broken/);
  assert.match(bun.note ?? '', /npm install -g opencode-ai/);
  assert.match(notStarted('opencode', 1, 'Bun is a fast JavaScript runtime, package manager').activity, /install is broken/);
  // Only OpenCode is a Bun app: other agents printing it is their own business.
  assert.match(notStarted('codex', 1, 'Script not found "x"').activity, /^Codex exited before it started \(code 1\)/);
  assert.match(notStarted('claude', 2, '').note ?? '', /exited with code 2/);
  const silent = notStarted('opencode', undefined, '');
  assert.match(silent.activity, /OpenCode still hasn't started/);
  assert.equal(silent.note, undefined, 'nothing is written into a terminal whose program still runs');
});

test('OpenCode gets a multi-line prompt with <, >, quotes and newlines as its single --prompt value, first launch and restart alike', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const info = hired(workers.spawn('desk-1', 'test', PROMPT));
  const [first] = await waitFor(() => f.launches(), (l) => l.length === 1, 'the first launch');
  assert.deepEqual(first.args, ['--prompt', withWorkerHandoff(PROMPT)]);
  assert.equal(withoutWorkerHandoff(first.args[1]), PROMPT);
  assert.equal(first.worker, info.id);
  assert.equal(first.session, '');
  assert.equal(first.autoupdate, '1', 'OpenCode must not reinstall itself under the other workers');
  assert.match(first.config ?? '', /agent-office-opencode/);
  assert.equal(workers.handleOpenCodeHook(info.id, first.token!, { type: 'ready' }), true);
  assert.equal(workers.get(info.id)?.didNotStart, undefined);

  // The office restarts before OpenCode reported a session: the worker gets its task again.
  workers.shutdown();
  const restored = f.manager();
  await restored.start();
  const [, second] = await waitFor(() => f.launches(), (l) => l.length === 2, 'the launch after the restart');
  assert.deepEqual(second.args, ['--prompt', withWorkerHandoff(retoldTask(PROMPT))]);
  assert.equal(withoutWorkerHandoff(second.args[1]), PROMPT);
  assert.equal(second.worker, info.id);
  assert.equal(restored.handleOpenCodeHook(info.id, second.token!, { type: 'ready' }), true);
});

test('an OpenCode that dies on launch waits for a person with its screen kept, then starts again with its task', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  f.mode('bun');
  const info = hired(workers.spawn('desk-1', 'test', 'fix the login'));
  await waitFor(() => f.launches(), (l) => l.length === 1, 'the first launch');
  const failed = await waitFor(() => workers.get(info.id), (w) => !!w?.didNotStart && /install is broken/.test(w.activity ?? ''), 'the broken install to show at its desk');
  assert.equal(failed?.status, 'needs_input');
  assert.equal(failed?.acked, false, 'its desk raises its hand');
  assert.equal(failed?.exitCode, 1);
  assert.equal(isAsleep(failed!.status), false, 'opening its terminal shows the error instead of relaunching it');
  const screen = workers.attach(info.id, 'viewer', 'Ada')?.data ?? '';
  assert.match(screen, /Script not found/);
  assert.match(screen, /OpenCode didn't start/);
  workers.detach(info.id, 'viewer');

  // Start again, once the install works.
  f.mode('run');
  assert.equal(workers.resume(info.id), undefined);
  const [, again] = await waitFor(() => f.launches(), (l) => l.length === 2, 'the second launch');
  assert.deepEqual(again.args, ['--prompt', withWorkerHandoff(retoldTask('fix the login'))]);
  const back = workers.get(info.id);
  assert.equal(back?.didNotStart, undefined);
  assert.equal(back?.status, 'idle');
  assert.equal(back?.activity, 'fix the login');
  assert.equal(workers.handleOpenCodeHook(info.id, again.token!, { type: 'ready' }), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(workers.get(info.id)?.status, 'idle', 'it stays up this time');
});

test('an OpenCode that stays silent is flagged, clears when it reports in, and Start again replaces the silent process', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  workers.startupMs = 300;
  const late = hired(workers.spawn('desk-1', 'test', 'slow starter'));
  const [first] = await waitFor(() => f.launches(), (l) => l.length === 1, 'the first launch');
  const flagged = await waitFor(() => workers.get(late.id), (w) => !!w?.didNotStart, 'the silent worker to be flagged');
  assert.equal(flagged?.status, 'needs_input');
  assert.match(flagged?.activity ?? '', /OpenCode still hasn't started/);
  // It was only slow: reporting in puts it back.
  assert.equal(workers.handleOpenCodeHook(late.id, first.token!, { type: 'ready' }), true);
  assert.equal(workers.get(late.id)?.didNotStart, undefined);
  assert.equal(workers.get(late.id)?.status, 'idle');
  assert.equal(workers.get(late.id)?.activity, 'slow starter');
  assert.equal(workers.resume(late.id), 'Worker is already running');

  const stuck = hired(workers.spawn('desk-2', 'test', 'stuck starter'));
  const [, second] = await waitFor(() => f.launches(), (l) => l.length === 2, 'the second worker');
  await waitFor(() => workers.get(stuck.id), (w) => !!w?.didNotStart, 'the stuck worker to be flagged');
  assert.equal(workers.resume(stuck.id), undefined, 'Start again works while the silent process still runs');
  const [, , third] = await waitFor(() => f.launches(), (l) => l.length === 3, 'the relaunch');
  assert.equal(third.worker, stuck.id);
  assert.deepEqual(third.args, ['--prompt', withWorkerHandoff(retoldTask('stuck starter'))]);
  assert.equal(workers.handleOpenCodeHook(stuck.id, second.token!, { type: 'ready' }), false, 'the replaced process no longer speaks for it');
  assert.equal(workers.handleOpenCodeHook(stuck.id, third.token!, { type: 'ready' }), true);
  assert.equal(workers.get(stuck.id)?.didNotStart, undefined);
});

test('five OpenCode workers hired at once each get their own prompt, token and no self-update', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const prompts = [1, 2, 3, 4, 5].map((n) => `Get pull request #${n} ready\nand "merge" <it>`);
  const infos = prompts.map((p, i) => hired(workers.spawn(`desk-${i + 1}`, 'test', p)));
  const launches = await waitFor(() => f.launches(), (l) => l.length === 5, 'five launches');
  for (const [i, info] of infos.entries()) {
    const launch = launches.find((l) => l.worker === info.id);
    assert.ok(launch, `${info.name} launched`);
    assert.deepEqual(launch.args, ['--prompt', withWorkerHandoff(prompts[i])]);
    assert.equal(launch.autoupdate, '1');
    assert.equal(workers.handleOpenCodeHook(info.id, launch.token!, { type: 'ready' }), true);
  }
  assert.equal(new Set(launches.map((l) => l.token)).size, 5);
  assert.ok(infos.every((info) => workers.get(info.id)?.status === 'idle' && !workers.get(info.id)?.didNotStart));
});

test('Codex that exits before its first hook did not start; one that reported in and exits is just exited', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  f.mode('exit');
  const early = hired(workers.spawn('desk-1', 'test', 'codex task', false, 'agent', 'codex'));
  const failed = await waitFor(() => workers.get(early.id), (w) => !!w?.didNotStart && /code 3/.test(w.activity ?? ''), 'the early exit to show');
  assert.equal(failed?.status, 'needs_input');
  assert.match(failed?.activity ?? '', /^Codex exited before it started \(code 3\)/);

  const late = hired(workers.spawn('desk-2', 'test', 'second codex task', false, 'agent', 'codex'));
  const launched = await waitFor(() => f.launches('codex'), (l) => l.some((x) => x.worker === late.id), 'the second Codex');
  const token = launched.find((x) => x.worker === late.id)!.token!;
  assert.equal(workers.handleCodexHook(late.id, token, 'SessionStart', { session_id: 'codex-late', source: 'startup' }), true);
  const exited = await waitFor(() => workers.get(late.id), (w) => w?.status === 'exited', 'the reported worker to exit');
  assert.equal(exited?.didNotStart, undefined);
  assert.equal(exited?.exitCode, 3);
});
