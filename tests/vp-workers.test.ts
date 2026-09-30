import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, lookAt, DEFAULT_LIMITS, type WorkerLook } from '../src/server/vp-workers.js';
import { RESTART_ERROR } from '../src/shared/task-status.js';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol.js';

const NOW = 10_000_000_000;
const MIN = 60_000;

function look(over: Partial<WorkerLook>): WorkerLook {
  return { id: 'w', name: 'Pixel', seat: 'Pixel at Desk 3 (office/pixel-2587)', status: 'working', since: NOW - MIN, tail: '', checkpointed: false, running: true, ...over };
}

test('a permission prompt is escalated to the owner, never approved or typed into', () => {
  const s = classify(look({ status: 'needs_input', since: NOW - 2 * MIN, task: 'Wants permission: Bash(rm -rf dist)' }), NOW);
  assert.equal(s?.kind, 'permission');
  assert.equal(s?.action, 'escalate');
  assert.equal(s?.say, undefined);
  // OpenCode's external-directory prompt, read off the terminal.
  const oc = classify(look({ status: 'needs_input', tail: 'Access external directory C:\\Users\\Owner\\Documents\n  Allow once   Allow always   Reject' }), NOW);
  assert.equal(oc?.action, 'escalate');
});

test('a question waits ten minutes, then goes to the VP for judgment', () => {
  assert.equal(classify(look({ status: 'needs_input', since: NOW - 5 * MIN, task: 'Which colour?' }), NOW), undefined);
  const s = classify(look({ status: 'needs_input', since: NOW - 11 * MIN, task: 'Which colour?' }), NOW);
  assert.equal(s?.kind, 'question');
  assert.equal(s?.action, 'report');
});

test('asleep with its task unfinished (stopped by a restart): woken and told "continue"', () => {
  const t = { id: 't1', status: 'done', outcome: 'exited', error: RESTART_ERROR };
  const asleep = classify(look({ status: 'exited', queueTask: t }), NOW);
  assert.equal(asleep?.kind, 'asleep-with-task');
  assert.equal(asleep?.action, 'wake');
  assert.equal(asleep?.say, 'continue');
  assert.match(asleep!.detail, /stopped by a restart/);
  // Back idle at its prompt after the restart: the same, after a couple of minutes.
  assert.equal(classify(look({ status: 'idle', since: NOW - 30_000, queueTask: t }), NOW), undefined);
  assert.equal(classify(look({ status: 'idle', since: NOW - 3 * MIN, queueTask: t }), NOW)?.action, 'wake');
  // The office saved its uncommitted work as it went down (Pixel's 20 files): same.
  assert.equal(classify(look({ status: 'idle', since: NOW - 3 * MIN, checkpointed: true }), NOW)?.kind, 'asleep-with-task');
  // Asleep with its PR already open: nothing to carry on.
  assert.equal(classify(look({ status: 'exited', queueTask: t, pr: { number: 3, url: 'u' } }), NOW), undefined);
});

test('paused is nudged to continue; interrupted (someone pressed Esc) or lately typed to is only reported', () => {
  assert.equal(classify(look({ status: 'paused', since: NOW - 11 * MIN }), NOW)?.action, 'nudge');
  assert.equal(classify(look({ status: 'paused', since: NOW - 3 * MIN }), NOW), undefined);
  assert.equal(classify(look({ status: 'interrupted', since: NOW - 11 * MIN }), NOW)?.action, 'report');
  assert.equal(classify(look({ status: 'paused', since: NOW - 11 * MIN, lastInput: { by: 'Michael', at: NOW - 5 * MIN } }), NOW)?.action, 'report');
});

test('the known workarounds: GraphQL rate limit, a hung test run, unshipped work', () => {
  const rl = classify(look({ status: 'done', tail: 'GraphQL: API rate limit exceeded for user ID 62819637.' }), NOW);
  assert.equal(rl?.kind, 'rate-limit');
  assert.match(rl!.say!, /gh api repos/);
  const hung = classify(look({ status: 'working', outputAt: NOW - 12 * MIN, tail: '> npm test\n▶ pull-links' }), NOW);
  assert.equal(hung?.kind, 'hung-test');
  assert.match(hung!.say!, /--test-force-exit/);
  const silent = classify(look({ status: 'working', outputAt: NOW - 31 * MIN, tail: 'Thinking…' }), NOW);
  assert.equal(silent?.kind, 'silent');
  assert.equal(silent?.action, 'report');
  const u = classify(look({ status: 'done', queueTask: { id: 't', status: 'done', outcome: 'done', unshipped: { dirty: 20, commits: 0 } } }), NOW);
  assert.equal(u?.kind, 'unshipped');
  assert.match(u!.detail, /20 uncommitted files/);
  assert.equal(classify(look({ status: 'working', outputAt: NOW - MIN }), NOW), undefined);
});

test('lookAt names each worker by seat and branch, and leaves out the board agents', () => {
  const base = { kind: 'agent', provider: 'claude', color: '#fff', acked: true, createdBy: 'me', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [] };
  const workers = [
    { ...base, id: 'a', name: 'Pixel', deskId: 'desk-3', status: 'exited', worktree: { path: 'x', branch: 'office/pixel-2587', base: 'b' } },
    { ...base, id: 'b', name: 'VP', deskId: 'station-vp', status: 'idle' },
  ] as WorkerInfo[];
  const tasks = [{ id: 't1', title: 'Update walkthrough', prompt: 'p', status: 'done', outcome: 'exited', error: RESTART_ERROR, workerId: 'a', addedBy: 'me', addedAt: 0 }] as QueueTask[];
  const looks = lookAt(workers, tasks, () => ({ since: NOW - MIN, tail: '', running: false }), NOW, DEFAULT_LIMITS);
  assert.equal(looks.length, 1);
  assert.equal(looks[0].seat, 'Pixel at Desk 3 (office/pixel-2587)');
  assert.equal(looks[0].stuck?.action, 'wake');
});
