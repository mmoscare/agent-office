import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RESTART_ERROR, recoveryTitle, taskStatus, unshippedText } from '../src/shared/task-status.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import { formatQueue } from '../bin/office-queue.js';
import type { QueueTask } from '../src/shared/protocol.js';

const pr = { number: 4, url: 'u', state: 'OPEN', title: 'x' };

test('a finished task says honestly what it left behind', () => {
  assert.deepEqual(taskStatus({ status: 'running' }), { text: 'running', warn: false });
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'done' }), { text: 'done', warn: false });
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'killed' }), { text: 'done (killed)', warn: false });
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'done', unshipped: { dirty: 3, commits: 0 } }), { text: 'done — no PR (unshipped work)', warn: true });
  // A linked historical PR must not conceal work found by the scanner.
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'done', pr, unshipped: { dirty: 0, commits: 1 } }), { text: 'done — work outside PR (unshipped work)', warn: true });
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'exited', error: RESTART_ERROR }), { text: 'stopped by restart', warn: true });
  assert.deepEqual(taskStatus({ status: 'done', outcome: 'exited', error: RESTART_ERROR, unshipped: { dirty: 0, commits: 1 } }), { text: 'stopped by restart — no PR (unshipped work)', warn: true });
  assert.equal(unshippedText({ dirty: 1, commits: 2 }), '1 uncommitted file, 2 unshipped commits');
  assert.equal(recoveryTitle('office/a', 'frontend'), 'Recover unshipped work from office/a (frontend)');
});

function queueIn(dir: string) {
  const workers: QueueWorkers = { defaultProvider: 'claude', list: () => [], deskOccupied: () => false, spawn: () => 'no desks', kill: async () => ({}) };
  return new TaskQueue(dir, workers, true, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => 'paused', emptied() {} });
}

test('old state files load; a restart-stopped task is flagged, then its unshipped work', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-task-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // As an office from before this change saved it: no `unshipped` anywhere.
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({
    maxWorkers: 2,
    tasks: [
      { id: 'a', title: 'Was running', prompt: 'p', addedBy: 'x', addedAt: 1, status: 'running', workerName: 'Gizmo', branch: 'office/gizmo-bff0' },
      { id: 'b', title: 'Stopped by an old restart', prompt: 'p', addedBy: 'x', addedAt: 1, status: 'done', outcome: 'exited', error: RESTART_ERROR, branch: 'office/old-1' },
      { id: 'c', title: 'Done', prompt: 'p', addedBy: 'x', addedAt: 1, status: 'done', outcome: 'done', branch: 'office/nibble-aec2' },
      { id: 'd', title: 'Shipped', prompt: 'p', addedBy: 'x', addedAt: 1, status: 'done', outcome: 'done', branch: 'office/ok-2', pr },
    ],
  }));
  const q = queueIn(dir);
  t.after(() => q.shutdown());
  const byId = (id: string) => q.state().tasks.find((x) => x.id === id)!;
  assert.equal(taskStatus(byId('a')).text, 'stopped by restart');
  assert.equal(taskStatus(byId('b')).text, 'stopped by restart');
  assert.equal(taskStatus(byId('c')).text, 'done');

  q.onUnshipped(new Map([
    ['office/gizmo-bff0', { dirty: 0, commits: 1 }],
    ['office/nibble-aec2', { dirty: 4, commits: 0 }],
    ['office/ok-2', { dirty: 1, commits: 0 }],
  ]));
  assert.equal(taskStatus(byId('a')).text, 'stopped by restart — no PR (unshipped work)');
  assert.equal(taskStatus(byId('c')).text, 'done — no PR (unshipped work)');
  assert.equal(taskStatus(byId('d')).text, 'done — work outside PR (unshipped work)');
  assert.deepEqual(byId('d').unshipped, { dirty: 1, commits: 0 });

  // Kept across a restart, and cleared once the work is shipped.
  const again = queueIn(dir);
  t.after(() => again.shutdown());
  assert.deepEqual(again.state().tasks.find((x) => x.id === 'c')!.unshipped, { dirty: 4, commits: 0 });
  again.onUnshipped(new Map());
  assert.equal(taskStatus(again.state().tasks.find((x) => x.id === 'c')!).text, 'done');
});

test('office-queue list shows the honest status and what was left behind', () => {
  const text = formatQueue({
    maxWorkers: 1,
    tasks: [
      { id: 'aaa111', title: 'Nibble', status: 'done', outcome: 'done', state: 'done — no PR (unshipped work)', worker: 'Nibble', branch: 'office/nibble-aec2', unshipped: '4 uncommitted files' },
      { id: 'bbb222', title: 'Gizmo', status: 'done', outcome: 'exited', state: 'stopped by restart', error: RESTART_ERROR },
      // An older office sends no `state`: the old wording stays.
      { id: 'ccc333', title: 'Old', status: 'done', outcome: 'killed' },
    ] as Partial<QueueTask>[],
  });
  const lines = text.split('\n');
  assert.match(lines[1], /^aaa111 {2}done — no PR \(unshipped work\) {2}Nibble · worker Nibble on office\/nibble-aec2 · ⚠ left behind: 4 uncommitted files/);
  assert.match(lines[2], /^bbb222 {2}stopped by restart +Gizmo · error: The office restarted/);
  assert.match(lines[3], /^ccc333 {2}done \(killed\) +Old$/);
});
