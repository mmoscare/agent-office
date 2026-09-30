import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAsk, requestOf, savedAsk } from '../src/server/asks.js';
import { CHECKPOINT_NOTE, WORKTREE_NOTE, withWorkerHandoff } from '../src/server/handoff.js';
import { briefLines } from '../src/client/ui/terminal-brief-model.js';

test('an ask drops the notes the office adds around a request', () => {
  const queued = `Add a brief to the terminal${WORKTREE_NOTE}${CHECKPOINT_NOTE}`;
  assert.equal(requestOf(queued), 'Add a brief to the terminal');
  assert.equal(requestOf(withWorkerHandoff(queued)!), 'Add a brief to the terminal');
  assert.equal(requestOf('Line one\r\n\r\n\r\n\r\nLine two  '), 'Line one\n\nLine two');
  assert.equal(requestOf('x'.repeat(2000)).length, 1000);
});

test('the first request stays and later ones become the latest ask', () => {
  let ask = nextAsk(undefined, 'Fix the login redirect after sign-in');
  assert.deepEqual(ask, { first: 'Fix the login redirect after sign-in' });
  // A hook echoes it back with the handoff, or with a desk brief in front of it.
  assert.equal(nextAsk(ask, withWorkerHandoff('Fix the login redirect after sign-in')!), ask);
  assert.equal(nextAsk(ask, 'You work across these repositories: a, b\nFix the login redirect after sign-in'), ask);
  ask = nextAsk(ask, 'Also keep the return URL when the session expires');
  assert.deepEqual(ask, { first: 'Fix the login redirect after sign-in', latest: 'Also keep the return URL when the session expires' });
  // Short replies and slash commands keep the latest request.
  assert.equal(nextAsk(ask, 'yes, go ahead'), ask);
  assert.equal(nextAsk(ask, '/compact'), ask);
});

test('workers saved before asks were kept get one from their prompt', () => {
  assert.deepEqual(savedAsk(undefined, `Write the docs${WORKTREE_NOTE}`), { first: 'Write the docs' });
  assert.deepEqual(savedAsk({ first: 'A', latest: 'B' }), { first: 'A', latest: 'B' });
  assert.equal(savedAsk({ first: 3 }), undefined);
});

test('the brief shows the asks, the task and what the agent is doing', () => {
  const lines = briefLines({
    kind: 'agent',
    status: 'working',
    ask: { first: 'Please add a summary at the top of the terminal', latest: 'Make it collapsible too' },
    task: { name: 'Add Terminal Brief', summary: 'Wiring the brief into the terminal header' },
    activity: 'Editing src/client/ui/terminal.ts',
  });
  assert.deepEqual(lines.map((l) => [l.label, l.text]), [
    ['You asked', 'Please add a summary at the top of the terminal'],
    ['Latest ask', 'Make it collapsible too'],
    ['Working on', 'Add Terminal Brief — Wiring the brief into the terminal header'],
    ['Now', 'Editing src/client/ui/terminal.ts'],
  ]);
});

test('the brief leaves out lines that only repeat the request', () => {
  const lines = briefLines({
    kind: 'agent',
    status: 'done',
    ask: { first: 'please add a summary at the top of the terminal whenever it is open and more words here to clip' },
    // What a provider without a task namer shows: the prompt itself.
    task: { name: 'Add a summary at', summary: 'Please add a summary at the top of the terminal whenever it is…' },
    activity: 'please add a summary at the top of the terminal…',
  });
  assert.deepEqual(lines.map((l) => [l.key, l.text]), [
    ['asked', 'please add a summary at the top of the terminal whenever it is open and more words here to clip'],
    ['task', 'Add a summary at'],
  ]);
  assert.deepEqual(briefLines({ kind: 'agent', status: 'needs_input', activity: 'Wants permission: Bash' }).map((l) => l.text), ['Wants permission: Bash']);
  assert.deepEqual(briefLines({ kind: 'agent', status: 'idle', activity: 'yes' }), []);
  assert.deepEqual(briefLines({ kind: 'shell', status: 'working', activity: 'ls' }), []);
});
