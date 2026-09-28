import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { PtyHost, type PtyExit, type SpawnOpts } from '../src/server/ptys.js';
import { TaskNamer } from '../src/server/tasks.js';
import { Ledger } from '../src/server/usage.js';
import { withWorkerHandoff, withoutWorkerHandoff } from '../src/server/handoff.js';
import type { AgentProvider, WorkerInfo } from '../src/shared/protocol.js';

// Capture the real WorkerManager launch boundary without starting provider CLIs or a native PTY.
function fixture(t: TestContext, provider: AgentProvider = 'claude') {
  const root = mkdtempSync(path.join(tmpdir(), 'office-handoff-'));
  const data = path.join(root, 'data');
  mkdirSync(data);
  const command = path.join(root, provider === 'custom' ? 'wrapper' : provider).replaceAll('\\', '/');
  writeFileSync(command, '', { mode: 0o700 });
  const launches: { opts: SpawnOpts; input: string[]; exit(): void }[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(TaskNamer.prototype, 'request', () => {});
  t.mock.method(PtyHost.prototype, 'spawn', (opts: SpawnOpts) => {
    let onExit: (event: PtyExit) => void = () => {};
    const input: string[] = [];
    const exit = () => onExit({ exitCode: 0 });
    launches.push({ opts, input, exit });
    return {
      pid: 1, write: (text: string) => input.push(text), resize() {}, kill: exit,
      onData() {}, onExit: (cb: typeof onExit) => { onExit = cb; },
    };
  });
  const workers = new WorkerManager(root, data, command, ['--configured'], { url: 'http://127.0.0.1:1', token: '' }, {
    update() {}, remove() {}, data() {}, screen() {}, toast() {},
  }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => {
    workers.shutdown();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { workers, launches };
}

function worker(result: WorkerInfo | string): WorkerInfo {
  assert.notEqual(typeof result, 'string');
  return result as WorkerInfo;
}

for (const provider of ['claude', 'opencode', 'codex', 'custom'] as const) {
  test(`${provider} receives the handoff on launch and follow-up without changing the task card`, (t) => {
    const { workers, launches } = fixture(t, provider);
    const info = worker(workers.spawn('desk-1', 'Tester', '- Fix the login'));
    const { args, env } = launches[0].opts;
    const submitted = args.at(-1)!;
    assert.equal(args.at(-2), provider === 'opencode' ? '--prompt' : '--');
    assert.ok(args.includes('--configured'));
    assert.ok(submitted.startsWith('- Fix the login\n\n'));
    assert.match(submitted, /Before declaring a task complete/);
    assert.match(submitted, /PR description/);
    assert.match(submitted, /completion comment/);
    assert.match(submitted, /checks actually run with commands and results/);
    assert.match(submitted, /remaining work, blockers, risks and concrete next steps/);
    assert.equal(info.prompt, '- Fix the login');
    const originalTask = info.task;

    // Providers echo the entire injected prompt through their hooks. Keep it off task cards.
    const token = env.AGENT_OFFICE_HOOK_TOKEN;
    const accepted = provider === 'codex'
      ? workers.handleCodexHook(info.id, token, 'UserPromptSubmit', { session_id: 'test-session', prompt: submitted })
      : provider === 'opencode'
        ? workers.handleOpenCodeHook(info.id, token, { type: 'prompt', sessionId: 'test-session', status: 'working', prompt: submitted })
        : workers.handleHook(info.id, token, 'UserPromptSubmit', { session_id: 'test-session', prompt: submitted });
    assert.equal(accepted, true);
    assert.equal(info.activity, '- Fix the login');
    assert.deepEqual(info.task, originalTask);

    assert.equal(workers.prompt(info.id, 'Check the redirect', 'Tester'), undefined);
    assert.match(launches[0].input[0], /^\x1b\[200~Check the redirect\n\n/);
    assert.match(launches[0].input[0], /<agent-office-handoff>/);
    assert.equal(info.activity, 'Check the redirect');
    t.mock.timers.tick(120);
    assert.equal(launches[0].input.at(-1), '\r');

    assert.equal(workers.prompt(info.id, '/compact'), undefined);
    assert.equal(launches[0].input.at(-1), '\x1b[200~/compact\x1b[201~');
  });
}

test('a worker hired without a task learns the rule without gaining a task card', (t) => {
  const { workers, launches } = fixture(t, 'opencode');
  const info = worker(workers.spawn('desk-1', 'Tester'));
  const { args, env } = launches[0].opts;
  const submitted = args.at(-1)!;
  assert.match(submitted, /No task has been assigned yet/);
  assert.match(submitted, /wait for the user's request/);
  assert.match(submitted, /<agent-office-handoff>/);
  workers.handleOpenCodeHook(info.id, env.AGENT_OFFICE_HOOK_TOKEN, {
    type: 'prompt', sessionId: 'test-session', status: 'working', prompt: submitted,
  });
  assert.equal(info.prompt, undefined);
  assert.equal(info.task, undefined);
  assert.equal(info.activity, undefined);
});

test('resumes keep the session idle without a prompt, and include the rule with new work', (t) => {
  const { workers, launches } = fixture(t, 'codex');
  const info = worker(workers.spawn('desk-1', 'Tester', 'First task'));
  workers.handleCodexHook(info.id, launches[0].opts.env.AGENT_OFFICE_HOOK_TOKEN, 'SessionStart', { session_id: 'test-session' });
  launches[0].exit();
  assert.equal(workers.resume(info.id), undefined);
  assert.deepEqual(launches[1].opts.args.slice(-2), ['resume', 'test-session']);
  assert.equal(launches[1].opts.args.some((arg) => arg.includes('<agent-office-handoff>')), false);
  launches[1].exit();
  assert.equal(workers.resume(info.id, 'Next task'), undefined);
  assert.match(launches[2].opts.args.at(-1)!, /^Next task\n\n<agent-office-handoff>/);
});

test('board workers get both their role and the shared handoff rule', (t) => {
  const { workers, launches } = fixture(t);
  const hired = workers.station('station-issues', 'Tester', 'Label issue #12');
  assert.notEqual(typeof hired, 'string');
  const submitted = launches[0].opts.args.at(-1)!;
  assert.match(submitted, /Issues agent/);
  assert.match(submitted, /don't switch branches, commit, or leave edits/);
  assert.match(submitted, /Label issue #12/);
  assert.match(submitted, /<agent-office-handoff>/);
});

test('shell launch and input do not receive agent instructions', (t) => {
  const { workers, launches } = fixture(t);
  const info = worker(workers.spawn('desk-1', 'Tester', undefined, false, 'shell'));
  assert.deepEqual(launches[0].opts.args, process.platform === 'win32' && !process.env.SHELL ? [] : ['-l']);
  workers.prompt(info.id, 'git status');
  assert.equal(launches[0].input[0], '\x1b[200~git status\x1b[201~');
});

test('handoff decoration preserves literal request text and native commands', () => {
  const request = 'Update "login"\nKeep $PATH and `backticks` literal.';
  assert.equal(withoutWorkerHandoff(withWorkerHandoff(request)!), request);
  assert.equal(withoutWorkerHandoff('Existing plain prompt'), 'Existing plain prompt');
  assert.equal(withWorkerHandoff('/model example'), '/model example');
  assert.match(withWorkerHandoff('/src/login.ts needs a fix')!, /<agent-office-handoff>/);
  assert.equal(withWorkerHandoff(undefined, 'session'), undefined);
});
