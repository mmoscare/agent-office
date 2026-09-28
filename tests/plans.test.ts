import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Plans, PlansError } from '../src/server/plans.js';

function fixture(t: any) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-plans-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
test('plans persist edits and moves, remain isolated per folder, and delete explicitly', t => {
  const dir = fixture(t);
  const other = path.join(dir, 'other'); mkdirSync(other);
  const plans = new Plans(dir);
  assert.deepEqual(plans.read(), { revision: 0, items: [] });
  let s = plans.change({ revision: 0, action: 'add', text: '  My plan\nwith notes  ' });
  const id = s.items[0].id;
  assert.equal(s.items[0].text, 'My plan\nwith notes');
  assert.equal(s.items[0].status, 'todo');
  for (const status of ['progress', 'finished', 'todo']) {
    s = plans.change({ revision: s.revision, action: 'edit', id, status });
    assert.deepEqual(new Plans(dir).read(), s);
  }
  s = plans.change({ revision: s.revision, action: 'edit', id, text: 'Updated plan' });
  assert.equal(s.items[0].text, 'Updated plan');
  assert.deepEqual(new Plans(other).read().items, []);
  assert.deepEqual(plans.change({ revision: s.revision, action: 'remove', id }).items, []);
});
test('stale writes and invalid input leave saved plans untouched', t => {
  const dir = fixture(t); const plans = new Plans(dir);
  const s = plans.change({ revision: 0, action: 'add', text: 'Keep this' });
  assert.throws(() => plans.change({ revision: 0, action: 'add', text: 'Stale' }), (e: unknown) => e instanceof PlansError && e.status === 409);
  for (const input of [null, { action: 'add', text: '' }, { action: 'add', text: 'x'.repeat(10001) }, { action: 'edit', id: s.items[0].id, status: 'invalid' }, { action: 'remove', id: 'missing' }]) {
    assert.throws(() => plans.change(input && { revision: s.revision, ...input }));
    assert.deepEqual(plans.read(), s);
  }
});
test('corrupt storage is never replaced with an empty binder', t => {
  const dir = fixture(t); const file = path.join(dir, 'plans.json');
  writeFileSync(file, 'broken but recoverable');
  const plans = new Plans(dir);
  assert.throws(() => plans.read(), /left untouched/);
  assert.throws(() => plans.change({ revision: 0, action: 'add', text: 'New' }));
  assert.equal(readFileSync(file, 'utf8'), 'broken but recoverable');
});
test('failed storage does not acknowledge a saved change', t => {
  const plans = new Plans(path.join(fixture(t), 'missing'));
  assert.throws(() => plans.change({ revision: 0, action: 'add', text: 'Unsaved' }), /not saved/);
  assert.deepEqual(plans.read(), { revision: 0, items: [] });
});

import type { WorkerInfo } from '../src/shared/protocol.js';
function worker(id: string, status: WorkerInfo['status']): WorkerInfo {
  return { id, deskId: 'desk-1', kind: 'agent', provider: 'claude', name: id, color: '#fff', status, acked: false, createdBy: 'x', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
}
test('workers and the queue move plans along: to Progress when handed over, to Finished when the worker is done', t => {
  const dir = fixture(t);
  const changes: number[] = [];
  const plans = new Plans(dir, s => changes.push(s.revision));
  const s = plans.apply({ action: 'add', text: 'Renew the insurance' });
  const id = s.items[0].id;
  assert.equal(plans.start(id, { id: 'w1', name: 'Byte' }, 'task1'), true);
  let p = plans.read().items[0];
  assert.equal(p.status, 'progress');
  assert.deepEqual(p.worker, { id: 'w1', name: 'Byte' });
  assert.equal(p.task, 'task1');
  // Its worker finishing its turn finishes the plan; other workers, and other statuses, don't.
  plans.onWorker(worker('w2', 'done'));
  plans.onWorker(worker('w1', 'working'));
  assert.equal(plans.read().items[0].status, 'progress');
  plans.onWorker(worker('w1', 'done'));
  p = plans.read().items[0];
  assert.equal(p.status, 'finished');
  assert.ok(p.finishedAt);
  assert.deepEqual(p.worker, { id: 'w1', name: 'Byte' });
  plans.onWorkerGone('w1');
  assert.equal(plans.read().items[0].worker, undefined);
  // Back to To Do by hand is a fresh start; a queue task that never started does the same by itself.
  plans.change({ revision: plans.read().revision, action: 'edit', id, status: 'todo' });
  p = plans.read().items[0];
  assert.equal(p.status, 'todo');
  assert.equal(p.task, undefined);
  assert.equal(p.finishedAt, undefined);
  plans.start(id, { id: 'w3', name: 'Pixel' }, 'task2');
  plans.end(id, 'exited');
  p = plans.read().items[0];
  assert.equal(p.status, 'progress');
  assert.equal(p.worker, undefined);
  assert.equal(p.task, 'task2');
  plans.end(id, 'failed');
  assert.equal(plans.read().items[0].status, 'todo');
  plans.start(id, { id: 'w4', name: 'Dot' }, 'task3');
  plans.end(id, 'done');
  assert.equal(plans.read().items[0].status, 'finished');
  assert.equal(plans.start('missing', { id: 'w', name: 'x' }), false);
  assert.ok(changes.length >= 8, 'every change tells the floor');
  // A malformed link in the file is dropped rather than refusing the whole binder.
  const raw = JSON.parse(readFileSync(path.join(dir, 'plans.json'), 'utf8'));
  raw.items[0].worker = { id: 42 };
  writeFileSync(path.join(dir, 'plans.json'), JSON.stringify(raw));
  assert.equal(new Plans(dir).read().items[0].worker, undefined);
  assert.equal(new Plans(dir).read().items[0].status, 'finished');
});
test('board agents change the binder without a revision, and a broken binder reads as empty for the floor view', t => {
  const dir = fixture(t);
  const plans = new Plans(dir);
  assert.deepEqual(plans.state(), { revision: 0, items: [] });
  const added = plans.apply({ action: 'add', text: '  Buy milk  ' });
  assert.equal(added.items[0].text, 'Buy milk');
  const moved = plans.apply({ action: 'edit', id: added.items[0].id, status: 'progress' });
  assert.equal(moved.items[0].status, 'progress');
  assert.equal(moved.revision, 2);
  assert.throws(() => plans.apply({ action: 'edit', id: 'missing', status: 'todo' }), (e: unknown) => e instanceof PlansError && e.status === 404);
  assert.throws(() => plans.apply({ action: 'edit', id: added.items[0].id, status: 'later' as any }), /To Do, Progress or Finished/);
  assert.deepEqual(plans.apply({ action: 'remove', id: added.items[0].id }).items, []);
  writeFileSync(path.join(dir, 'plans.json'), 'broken');
  assert.deepEqual(new Plans(dir).state(), { revision: 0, items: [] });
});
