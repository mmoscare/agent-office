import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { codexInputPrompt } from '../src/server/codex-input.js';
import { WorkerManager } from '../src/server/workers.js';

const approval = 'Would you like to run the following command?\r\n  $ npm test\r\n  1. Yes, proceed\r\n  2. No, and tell Codex what to do differently\r\nPress enter to confirm or esc to cancel';
const question = 'Question 1/1 (1 unanswered)\r\nWhich folder should I use?\r\n  1. Current folder\r\n  2. Another folder\r\nenter to submit answer | esc to interrupt';
const working = 'I will check the files and continue.\r\nWorking (12s · esc to interrupt)\r\n› Send a message\r\n? for shortcuts';

test('Codex input detection distinguishes interactive questions and approvals from messages', () => {
  assert.match(codexInputPrompt(approval)!, /approval/);
  assert.match(codexInputPrompt(question)!, /answer/);
  assert.match(codexInputPrompt(question.replace('enter to submit answer', 'ctrl+j to submit all'))!, /answer/);
  assert.equal(codexInputPrompt(working), undefined);
  assert.equal(codexInputPrompt('Do you want me to check this?\n' + working), undefined);
  assert.equal(codexInputPrompt('Would you like to run the following command?\n' + working), undefined);
  assert.equal(codexInputPrompt(approval + '\r\n' + working), undefined);
  assert.equal(codexInputPrompt(approval + '\r\n› Send a message'), undefined);
  assert.equal(codexInputPrompt(question + '\r\n› Send a message'), undefined);
  assert.equal(codexInputPrompt('Choose a model\nPress enter to confirm or esc to cancel'), undefined);
  assert.match(codexInputPrompt('Do you trust this folder?\n1. Yes\n2. No\nPress enter to continue')!, /setup/);
  assert.equal(codexInputPrompt('Loading Codex...'), undefined);
});

/** Exercise the real hook/status/screen path without launching an authenticated CLI. */
function fixture(t: { after(fn: () => void): void }) {
  const term = new headless.Terminal({ cols: 100, rows: 24, allowProposedApi: true });
  t.after(() => term.dispose());
  const updates: string[] = [];
  const w: any = {
    info: { id: 'worker', kind: 'agent', provider: 'codex', status: 'working', sessionId: 'root', acked: true },
    term, pty: {}, hookToken: 'test-token', viewers: new Map(),
  };
  const manager: any = Object.create(WorkerManager.prototype);
  Object.assign(manager, {
    workers: new Map([['worker', w]]),
    events: { update: (info: any) => updates.push(info.status) },
    persist() {}, scheduleScan() {},
  });
  const hook = (event: string, extra = {}) => manager.handleCodexHook('worker', 'test-token', event, { session_id: 'root', ...extra });
  const screen = async (text: string) => {
    await new Promise<void>(resolve => term.write('\x1b[2J\x1b[H' + text, resolve));
    manager.checkBlocked(w);
  };
  return { w, updates, hook, screen };
}

test('auto-approved or uncorrelated permission hooks and progress never produce input alerts', async t => {
  const f = fixture(t);
  f.hook('PermissionRequest', { tool_name: 'Bash' });
  f.hook('PreToolUse', { tool_name: 'exec_command', tool_use_id: 'call-1' });
  await f.screen(working);
  f.hook('PostToolUse', { tool_name: 'exec_command', tool_use_id: 'call-1' });
  assert.equal(f.w.info.status, 'working');
  assert.ok(!f.updates.includes('needs_input'));
  f.hook('Stop');
  assert.equal(f.w.info.status, 'done');
});

test('a genuine question remains visible during parallel work, then clears when answered', async t => {
  const f = fixture(t);
  f.hook('PreToolUse', { tool_name: 'request_user_input', tool_use_id: 'question' });
  assert.equal(f.w.info.status, 'working');
  await f.screen(question);
  assert.equal(f.w.info.status, 'needs_input');
  assert.equal(f.w.info.acked, false);
  f.hook('PreToolUse', { tool_name: 'read_file', tool_use_id: 'other' });
  f.hook('PostToolUse', { tool_name: 'read_file', tool_use_id: 'other' });
  assert.equal(f.w.info.status, 'needs_input');
  await f.screen(working);
  assert.equal(f.w.info.status, 'working');
  assert.equal(f.w.info.acked, true);
});

test('approval dismissal clears needs_input even without a matching post-tool hook', async t => {
  const f = fixture(t);
  f.hook('PermissionRequest', { tool_name: 'Bash' });
  await f.screen(approval);
  assert.equal(f.w.info.status, 'needs_input');
  await f.screen(working);
  assert.equal(f.w.info.status, 'working');
  f.hook('Interrupt');
  await f.screen(approval);
  assert.equal(f.w.info.status, 'interrupted', 'stale controls cannot undo cancellation');
  await f.screen('Task interrupted\r\n› Send a message\r\n? for shortcuts');
  assert.equal(f.w.info.status, 'interrupted');
});

test('old stuck alerts clear, while other providers retain their status', async t => {
  const f = fixture(t);
  f.w.info.status = 'needs_input';
  await f.screen(working);
  assert.equal(f.w.info.status, 'working');
  f.w.info.provider = 'opencode';
  f.w.info.status = 'needs_input';
  await f.screen(working);
  assert.equal(f.w.info.status, 'needs_input');
});

test('a question in scrollback is not an active prompt', async t => {
  const f = fixture(t);
  await f.screen(question + '\r\n' + 'More progress\r\n'.repeat(30) + working);
  assert.equal(f.w.info.status, 'working');
});
