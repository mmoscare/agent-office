import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { WorkerManager } from '../src/server/workers.js';
import { isAsleep, isBusy, isStopped } from '../src/shared/status.js';
import { workerAttention } from '../src/shared/attention.js';
import type { AgentProvider } from '../src/shared/protocol.js';

function fixture(provider: AgentProvider) {
  const updates: string[] = [];
  const w: any = {
    info: { id: 'worker', kind: 'agent', provider, sessionId: 'root', status: 'working', action: 'test', acked: true },
    pty: { id: 'live-terminal' }, hookToken: 'token', viewers: new Map(), tracker: {}, leftNeedsInputAt: 0,
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

test('Claude Esc with no tool running reads as interrupted from the screen, but an older notice does not', async () => {
  const f = fixture('claude');
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  f.w.term = term;
  // An earlier turn was interrupted; this one finishes normally and its screen goes quiet before Stop.
  await write('> first\r\n  ⎿  Interrupted · What should Claude do instead?\r\n');
  f.w.info.status = 'done';
  f.hook('UserPromptSubmit', { prompt: 'second' });
  await write('> second\r\n● All done.\r\n');
  f.manager.onProgress(f.w, false);
  f.manager.checkBlocked(f.w);
  assert.equal(f.w.info.status, 'paused', 'the old notice belongs to an earlier turn');
  f.hook('Stop');
  assert.equal(f.w.info.status, 'done');
  // Next turn: Esc while Claude is thinking.
  f.hook('UserPromptSubmit', { prompt: 'third' });
  await write('> third\r\n  ⎿  Interrupted · What should Claude do instead?\r\n');
  f.manager.onProgress(f.w, false);
  f.manager.checkBlocked(f.w);
  assert.equal(f.w.info.status, 'interrupted');
  assert.equal(f.w.info.action, undefined, 'arms come off the keyboard');
  f.hook('UserPromptSubmit', { prompt: 'try again' });
  assert.equal(f.w.info.status, 'working');
  term.dispose();
});
