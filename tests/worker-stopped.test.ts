import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IDLE_DONE_GRACE_MS, WorkerManager } from '../src/server/workers.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import { Plans } from '../src/server/plans.js';
import { isAsleep, isBusy, isStopped } from '../src/shared/status.js';
import { workerAttention } from '../src/shared/attention.js';
import type { AgentProvider, WorkerInfo } from '../src/shared/protocol.js';

function fixture(provider: AgentProvider) {
  const updates: string[] = [];
  const w: any = {
    info: { id: 'worker', kind: 'agent', provider, sessionId: 'root', status: 'working', action: 'test', acked: true },
    pty: { id: 'live-terminal' }, hookToken: 'token', viewers: new Map(), tracker: {}, leftNeedsInputAt: 0,
    turnSeq: 0, cancelledTurns: new Set(),
  };
  const manager: any = Object.create(WorkerManager.prototype);
  Object.assign(manager, {
    workers: new Map([['worker', w]]),
    events: { update: (info: any) => updates.push(info.status) },
    persist() {}, scheduleScan() {}, notePrompt() {}, noteTool() {},
  });
  const hook = (event: string, extra = {}) => provider === 'codex'
    ? manager.handleCodexHook('worker', 'token', event, { session_id: 'root', ...extra })
    : manager.handleHook('worker', 'token', event, { session_id: 'root', ...extra });
  const openCode = (status: string, type = 'session', extra = {}) =>
    manager.handleOpenCodeHook('worker', 'token', { sessionId: 'root', status, type, ...extra });
  return { w, manager, hook, openCode, updates };
}

test('Codex interruption survives late completion, tool results and child hooks until a new prompt', () => {
  const f = fixture('codex');
  f.w.codexInput = { status: 'working' };
  f.w.info.status = 'needs_input';
  f.hook('Interrupt');
  assert.equal(f.w.info.status, 'interrupted');
  assert.equal(f.w.codexInput, undefined);
  assert.equal(f.w.info.action, undefined);
  f.hook('PostToolUse');
  f.hook('Stop');
  assert.equal(f.hook('PreToolUse', { agent_id: 'child' }), false);
  assert.equal(f.w.info.status, 'interrupted');
  assert.ok(!f.updates.includes('done'));
  f.hook('UserPromptSubmit', { prompt: 'continue' });
  assert.equal(f.w.info.status, 'working');
  f.hook('Stop');
  assert.equal(f.w.info.status, 'done');
});

test('a delayed Stop from an interrupted turn cannot complete a newer prompt', () => {
  const codex = fixture('codex');
  codex.hook('UserPromptSubmit', { prompt: 'first', turn_id: 'turn-1' });
  codex.hook('Interrupt', { turn_id: 'turn-1' });
  codex.hook('UserPromptSubmit', { prompt: 'second', turn_id: 'turn-2' });
  assert.equal(codex.w.info.status, 'working');
  codex.hook('PostToolUse', { turn_id: 'turn-1' });
  codex.hook('Stop', { turn_id: 'turn-1' });
  assert.equal(codex.w.info.status, 'working', 'stale Stop must not complete the new turn');
  assert.ok(!codex.updates.includes('done'));
  codex.hook('Stop', { turn_id: 'turn-2' });
  assert.equal(codex.w.info.status, 'done');

  const claude = fixture('claude');
  claude.hook('UserPromptSubmit', { prompt: 'first', turn_id: 'turn-1' });
  claude.hook('PostToolUseFailure', { is_interrupt: true, turn_id: 'turn-1' });
  claude.hook('UserPromptSubmit', { prompt: 'second', turn_id: 'turn-2' });
  claude.hook('Stop', { turn_id: 'turn-1' });
  claude.hook('Notification', { notification_type: 'idle_prompt', turn_id: 'turn-1' });
  assert.equal(claude.w.info.status, 'working');
  assert.ok(!claude.updates.includes('done'));
  claude.hook('Stop', { turn_id: 'turn-2' });
  assert.equal(claude.w.info.status, 'done');

  const grok = fixture('opencode');
  grok.openCode('working', 'prompt', { prompt: 'first', turnId: '1' });
  grok.openCode('interrupted', 'error', { turnId: '1' });
  grok.openCode('working', 'prompt', { prompt: 'second', turnId: '2' });
  grok.openCode('done', 'session', { turnId: '1' });
  assert.equal(grok.w.info.status, 'working');
  assert.ok(!grok.updates.includes('done'));
  grok.openCode('done', 'session', { turnId: '2' });
  assert.equal(grok.w.info.status, 'done');
});

test('Claude progress idle pauses a turn; only Stop marks it complete in either event order', () => {
  const f = fixture('claude');
  f.manager.onProgress(f.w, false);
  assert.equal(f.w.info.status, 'paused');
  assert.equal(f.w.info.action, undefined);
  f.hook('Notification', { notification_type: 'idle_prompt' });
  assert.equal(f.w.info.status, 'paused');
  f.hook('Stop');
  f.manager.onProgress(f.w, false);
  assert.equal(f.w.info.status, 'done');
  f.hook('UserPromptSubmit');
  f.w.info.status = 'needs_input';
  f.manager.onProgress(f.w, false);
  assert.equal(f.w.info.status, 'paused');
  f.manager.onProgress(f.w, true);
  assert.equal(f.w.info.status, 'working');
});

test('Claude explicit tool cancellation is interrupted; setup and live questions remain needs_input', () => {
  const f = fixture('claude');
  f.hook('PostToolUseFailure', { is_interrupt: true });
  f.manager.onProgress(f.w, false);
  f.hook('Stop');
  assert.equal(f.w.info.status, 'interrupted');
  f.hook('UserPromptSubmit');
  assert.equal(f.w.info.status, 'working');
  f.w.info.status = 'needs_input';
  f.manager.onProgress(f.w, true);
  assert.equal(f.w.info.status, 'needs_input');
  f.w.bootBlocked = true;
  f.manager.onProgress(f.w, false);
  assert.equal(f.w.info.status, 'needs_input');
});

test('Grok/OpenCode abort survives idle and usage reports, then resumes and completes normally', () => {
  const f = fixture('opencode');
  assert.equal(f.openCode('interrupted', 'error'), true);
  f.openCode('done');
  assert.equal(f.w.info.status, 'interrupted');
  assert.equal(f.w.info.action, undefined);
  f.manager.handleOpenCodeHook('worker', 'token', {
    type: 'usage', sessionId: 'root', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 1 },
  });
  assert.equal(f.w.info.status, 'interrupted');
  assert.ok(!f.updates.includes('done'));
  f.openCode('working', 'prompt', { prompt: 'continue' });
  assert.equal(f.w.info.status, 'working');
  f.openCode('done');
  assert.equal(f.w.info.status, 'done');
  f.openCode('needs_input', 'error', { detail: 'API unavailable' });
  f.openCode('done');
  assert.equal(f.w.info.status, 'needs_input', 'real errors keep their existing input alert');
});

test('stopped statuses mean an awake, promptable worker without a false completion notification', () => {
  const f = fixture('codex');
  for (const status of ['paused', 'interrupted'] as const) {
    assert.equal(isStopped(status), true);
    assert.equal(isBusy(status), false);
    assert.equal(isAsleep(status), false);
    f.w.info.status = status;
    f.w.info.acked = false;
    assert.equal(workerAttention(f.w.info), undefined);
  }
});


test('Claude terminal OSC progress really pauses and resumes the worker', async () => {
  const f = fixture('claude');
  f.w.info.cols = 80;
  f.w.info.rows = 24;
  const term = f.manager.newTerm(f.w);
  try {
    const output = (text: string) => new Promise<void>(resolve => term.write(text, resolve));
    await output('\x1b]9;4;0\x07');
    assert.equal(f.w.info.status, 'paused');
    await output('\x1b]9;4;3\x07');
    assert.equal(f.w.info.status, 'working');
    f.hook('Stop');
    await output('\x1b]9;4;0\x07');
    assert.equal(f.w.info.status, 'done');
  } finally {
    term.dispose();
  }
});

/** A real headless screen for a Claude worker, and a way to print to it. */
function claudeScreen() {
  const f = fixture('claude');
  f.w.info.cols = 80;
  f.w.info.rows = 24;
  const term = f.manager.newTerm(f.w);
  const output = (text: string) => new Promise<void>(resolve => term.write(text, resolve));
  return { ...f, term, output };
}

// Claude's input box at the foot of its screen, with the cursor left on its last row.
const INPUT_BOX = '\r\n╭────────╮\r\n│ >      │\r\n╰────────╯\r\n  ? for shortcuts';
// Claude redraws in place: back up over the input box and print the turn where it stood.
const OVER_INPUT_BOX = '\x1b[3A\r\x1b[J';
const ESC_NOTICE = '  ⎿  Interrupted · What should Claude do instead?';

test('Claude Esc with no tool running reads as interrupted from its screen notice, until a new prompt', async () => {
  const f = claudeScreen();
  try {
    await f.output(`● Ready.${INPUT_BOX}`);
    f.hook('UserPromptSubmit', { prompt: 'fix it' });
    // Esc while Claude thinks: no hook at all, just the notice, printed above where the cursor was.
    await f.output(`${OVER_INPUT_BOX}> fix it\r\n${ESC_NOTICE}${INPUT_BOX}\x1b]9;4;0\x07`);
    assert.equal(f.w.info.status, 'paused');
    f.manager.checkBlocked(f.w);
    assert.equal(f.w.info.status, 'interrupted');
    f.hook('Stop');
    assert.equal(f.w.info.status, 'interrupted');
    f.hook('UserPromptSubmit', { prompt: 'try again' });
    assert.equal(f.w.info.status, 'working');
    assert.ok(!f.updates.includes('done'));
  } finally {
    f.term.dispose();
  }
});

test('an interrupt notice from an earlier turn, or quoted in the output, leaves a quiet turn paused until Stop', async () => {
  const f = claudeScreen();
  try {
    await f.output(`> first\r\n${ESC_NOTICE}${INPUT_BOX}`);
    f.hook('UserPromptSubmit', { prompt: 'second' });
    await f.output(`${OVER_INPUT_BOX}> second\r\n● Claude prints "Interrupted by user" when you press Esc.\r\n`
      + `+const NOTICE = /Interrupted · What should Claude do instead?/;${INPUT_BOX}\x1b]9;4;0\x07`);
    assert.equal(f.w.info.status, 'paused');
    f.manager.checkBlocked(f.w);
    assert.equal(f.w.info.status, 'paused', 'the notice above the turn start belongs to the first turn');
    f.hook('Stop');
    assert.equal(f.w.info.status, 'done');
    // Claude redraws its whole screen (a resize, say), reprinting the first turn's notice below the
    // row this turn started on: that start is gone, so the notice can't be placed.
    f.hook('UserPromptSubmit', { prompt: 'third' });
    await f.output(`\x1b[H\x1b[2J> first\r\n${ESC_NOTICE}\r\n> second\r\n> third${INPUT_BOX}\x1b]9;4;0\x07`);
    f.manager.checkBlocked(f.w);
    assert.equal(f.w.info.status, 'paused');
  } finally {
    f.term.dispose();
  }
});

/** Past the wait before Claude's idle notification counts as a finished turn. */
const afterIdleGrace = () => new Promise<void>(resolve => setTimeout(resolve, IDLE_DONE_GRACE_MS + 200));

/** A turn under way, reported busy on the screen, whose idle notification has just come in. */
async function idleNotified(f: ReturnType<typeof claudeScreen>, prompt = 'fix it') {
  f.hook('UserPromptSubmit', { prompt });
  await f.output(`> ${prompt}\x1b]9;4;3\x07`);
  // Hooks and terminal output travel separately, so the idle notification can be handled first.
  f.hook('Notification', { notification_type: 'idle_prompt' });
}

test('Claude idle notification that beats the progress marker publishes nothing, so an Esc never reads as done', async () => {
  // Whichever reads the notice first: the screen check (every 250 ms) or the waiting notification.
  const flushed = claudeScreen();
  const waited = claudeScreen();
  try {
    for (const f of [flushed, waited]) {
      await idleNotified(f);
      assert.equal(f.w.info.status, 'working');
      await f.output(`\r\n${ESC_NOTICE}${INPUT_BOX}\x1b]9;4;0\x07`);
      assert.equal(f.w.info.status, 'paused');
    }
    flushed.manager.checkBlocked(flushed.w);
    assert.equal(flushed.w.info.status, 'interrupted');
    await afterIdleGrace();
    for (const f of [flushed, waited]) {
      assert.equal(f.w.info.status, 'interrupted');
      assert.ok(!f.updates.includes('done'), 'the queue and plans never see a finished turn');
      f.hook('Stop');
      assert.equal(f.w.info.status, 'interrupted');
    }
  } finally {
    flushed.term.dispose();
    waited.term.dispose();
  }
});

test('a finished turn whose idle notification beats its idle marker still ends done with no Stop', async () => {
  const f = claudeScreen();
  try {
    await idleNotified(f);
    await f.output(`\r\n● Fixed.${INPUT_BOX}\x1b]9;4;0\x07`);
    f.manager.checkBlocked(f.w);
    assert.equal(f.w.info.status, 'paused', 'nothing shows it finished yet');
    await afterIdleGrace();
    assert.equal(f.w.info.status, 'done', 'the notification stands in for the Stop that never came');
    f.hook('Stop');
    assert.deepEqual(f.updates.filter((s) => s === 'done'), ['done']);
  } finally {
    f.term.dispose();
  }
});

test('a Stop, more work or a new prompt while the idle notification waits wins over it', async () => {
  const stopped = claudeScreen();
  const tool = claudeScreen();
  const busy = claudeScreen();
  const prompted = claudeScreen();
  const all = [stopped, tool, busy, prompted];
  try {
    for (const f of all) await idleNotified(f);
    stopped.hook('Stop');
    assert.equal(stopped.w.info.status, 'done');
    tool.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await busy.output('\x1b]9;4;0\x07\x1b]9;4;3\x07');
    prompted.hook('UserPromptSubmit', { prompt: 'and one more thing' });
    await afterIdleGrace();
    assert.deepEqual(stopped.updates.filter((s) => s === 'done'), ['done'], 'a Stop reports done once, right away');
    for (const f of [tool, busy, prompted]) {
      assert.equal(f.w.info.status, 'working');
      assert.ok(!f.updates.includes('done'));
    }
  } finally {
    for (const f of all) f.term.dispose();
  }
});

test('with no progress reports from Claude, the idle notification reads an Esc off the screen and otherwise completes the turn', async () => {
  const f = claudeScreen();
  try {
    await f.output(`● Ready.${INPUT_BOX}`);
    f.hook('UserPromptSubmit', { prompt: 'fix it' });
    await f.output(`${OVER_INPUT_BOX}> fix it\r\n${ESC_NOTICE}${INPUT_BOX}`);
    f.hook('Notification', { notification_type: 'idle_prompt' });
    assert.equal(f.w.info.status, 'working');
    await afterIdleGrace();
    assert.equal(f.w.info.status, 'interrupted');
    f.hook('Stop');
    assert.equal(f.w.info.status, 'interrupted');
    f.hook('UserPromptSubmit', { prompt: 'again' });
    await f.output(`${OVER_INPUT_BOX}> again\r\n● Done.${INPUT_BOX}`);
    f.hook('Notification', { notification_type: 'idle_prompt' });
    await afterIdleGrace();
    assert.equal(f.w.info.status, 'done', 'with no Stop and no progress marker, the notification still stands in for Stop');
    assert.equal(f.updates.filter((s) => s === 'done').length, 1);
  } finally {
    f.term.dispose();
  }
});

test('an Esc-cancelled queue worker whose idle notification beats its idle marker keeps its task and its plan', async (t) => {
  const f = claudeScreen();
  const dir = mkdtempSync(path.join(tmpdir(), 'office-stopped-queue-'));
  const plans = new Plans(dir);
  const plan = plans.apply({ action: 'add', text: 'Fix the login' }).items[0].id;
  // Wired the way Floor wires them: every worker update goes straight to the queue and the plans.
  let queue: TaskQueue | undefined;
  f.manager.events = {
    update: (info: WorkerInfo) => {
      f.updates.push(info.status);
      queue?.onWorker(info);
      plans.onWorker(info);
    },
  };
  f.manager.workers.clear();
  const workers: QueueWorkers = {
    defaultProvider: 'claude',
    list: () => f.manager.list(),
    deskOccupied: (desk) => f.manager.list().some((w: WorkerInfo) => w.deskId === desk),
    spawn(deskId) {
      Object.assign(f.w.info, { deskId, name: 'Test' });
      f.manager.workers.set(f.w.info.id, f.w);
      return f.w.info;
    },
    kill: () => Promise.resolve({}),
  };
  queue = new TaskQueue(dir, workers, false, {
    update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {},
    startPlan: (id, worker, task) => void plans.start(id, worker, task),
    endPlan: (id, outcome) => plans.end(id, outcome),
  });
  t.after(() => {
    queue?.shutdown();
    f.term.dispose();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(queue.add('Fix the login', 'Tester', undefined, undefined, 'claude', undefined, undefined, undefined, plan), undefined);
  const task = () => queue!.state().tasks[0];
  const planStatus = () => plans.state().items[0].status;
  assert.equal(task().status, 'running');
  assert.equal(planStatus(), 'progress');

  await idleNotified(f, 'Fix the login');
  await f.output(`\r\n${ESC_NOTICE}${INPUT_BOX}\x1b]9;4;0\x07`);
  f.manager.checkBlocked(f.w);
  await afterIdleGrace();
  assert.equal(f.w.info.status, 'interrupted');
  assert.equal(task().status, 'running', 'the Esc did not finish the queue task');
  assert.equal(task().outcome, undefined);
  assert.equal(planStatus(), 'progress', 'nor its To Do Next item');

  // Told to carry on, it finishes for real: that is what completes the task and the plan.
  f.hook('UserPromptSubmit', { prompt: 'carry on' });
  f.hook('Stop');
  assert.equal(task().outcome, 'done');
  assert.equal(planStatus(), 'finished');
});

test('a child Claude cancellation does not stop its parent', () => {
  const f = fixture('claude');
  f.hook('PostToolUseFailure', { is_interrupt: true, agent_id: 'child' });
  assert.equal(f.w.info.status, 'working');
});

test('stopped workers restore offline and retain their stopped state when a live terminal is adopted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-stopped-'));
  try {
    for (const status of ['paused', 'interrupted'] as const) {
      const f = fixture('claude');
      f.manager.statePath = path.join(dir, 'workers.json');
      writeFileSync(f.manager.statePath, JSON.stringify([{
        id: 'worker', kind: 'agent', provider: 'claude', deskId: 'desk-1',
        sessionId: 'root', pty: { id: 'live-terminal', status, acked: true },
      }]));
      f.manager.workers.clear();
      f.manager.restore();
      const restored = f.manager.workers.get('worker');
      assert.equal(restored.info.status, 'offline');
      assert.equal(restored.saved.status, status);
      // Test the restore/adoption state machine without spawning a real agent.
      f.manager.newTerm = () => ({ write(_text: string, done: () => void) { done(); } });
      f.manager.follow = () => {};
      f.manager.adopt(restored, {
        pty: { id: 'live-terminal' }, cols: 80, rows: 24, snapshot: '', title: '', busy: false,
      }, restored.saved);
      assert.equal(restored.info.status, status);
      assert.equal(restored.info.acked, true);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});
