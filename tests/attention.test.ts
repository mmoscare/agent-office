import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionFloors, summarizeWorkers, workerAttention } from '../src/shared/attention.js';
import type { FloorInfo, WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';

const worker = (id: string, status: WorkerStatus, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id, name: id, deskId: `desk-${id}`, kind: 'agent', provider: 'codex', color: '#ff8a5b', status,
  acked: false, createdBy: 'Test', createdAt: 1, viewers: [], cols: 80, rows: 24, ...extra,
});
const floor = (id: string, workers: WorkerInfo[]): FloorInfo => ({
  id, name: id, dir: `/projects/${id}`, palette: 0, addedBy: 'Test', addedAt: 1, people: 0,
  ...summarizeWorkers(workers),
});

test('the requested question, completion, and blocker combinations count once per worker', () => {
  const cases = [
    [worker('1', 'needs_input'), worker('2', 'needs_input'), worker('3', 'needs_input')],
    [worker('1', 'done'), worker('2', 'needs_input'), worker('3', 'needs_input')],
    [worker('1', 'done'), worker('2', 'done'), worker('3', 'needs_input'), worker('4', 'exited', { exitCode: 1 })],
  ];
  for (const workers of cases) {
    const floors = attentionFloors([floor('a', workers.slice(0, 1)), floor('b', workers.slice(1))], 'a', workers.slice(0, 1));
    assert.equal(floors.reduce((n, f) => n + f.waiting, 0), workers.length);
    assert.equal(floors.flatMap((f) => f.attention).length, workers.length);
  }
});

test('questions remain pending after typing; completions clear when read and return after another turn', () => {
  const w = worker('1', 'needs_input', { acked: true, activity: 'Approve running tests?' });
  assert.equal(workerAttention(w)?.reason, 'needs_input');
  assert.equal(workerAttention(w)?.detail, 'Approve running tests?');
  w.status = 'working';
  assert.equal(workerAttention(w), undefined);
  w.status = 'done';
  w.acked = false;
  w.task = { name: 'Tests', summary: 'Fixed the failing tests' };
  assert.equal(workerAttention(w)?.detail, 'Fixed the failing tests');
  w.acked = true;
  assert.equal(workerAttention(w), undefined);
  w.acked = false;
  assert.equal(summarizeWorkers([w]).waiting, 1);
});

test('failed and blocked agents count, while shells, normal exits, idle and working agents do not', () => {
  const workers = [
    worker('failed', 'exited', { exitCode: 2 }),
    worker('launch-failed', 'exited', { exitCode: -1 }),
    worker('blocked', 'needs_input', { activity: 'Complete login to continue' }),
    worker('read-error', 'exited', { exitCode: 1, acked: true }),
    worker('normal-exit', 'exited', { exitCode: 0 }),
    worker('unknown-exit', 'exited'),
    worker('shell', 'exited', { kind: 'shell', exitCode: 1 }),
    worker('shell-done', 'done', { kind: 'shell' }),
    worker('read-done', 'done', { acked: true }),
    ...(['starting', 'idle', 'working', 'offline'] as const).map((status) => worker(status, status)),
  ];
  const summary = summarizeWorkers(workers);
  assert.equal(summary.workers, workers.length);
  assert.equal(summary.busy, 1);
  assert.equal(summary.waiting, 3);
  assert.deepEqual(summary.attention.map((w) => w.reason), ['error', 'error', 'needs_input']);
});

test('live current-floor updates override stale summaries without changing or duplicating other floors', () => {
  const stale = [floor('a', [worker('old', 'done')]), floor('b', [worker('remote', 'done')])];
  const live = new Map([['new', worker('new', 'needs_input')], ['busy', worker('busy', 'working')]]);
  const floors = attentionFloors(stale, 'a', live.values());
  assert.deepEqual(floors[0].attention.map((w) => w.id), ['new']);
  assert.equal(floors[0].workers, 2);
  assert.equal(floors[0].busy, 1);
  assert.equal(floors[1], stale[1]);
  assert.equal(floors.reduce((n, f) => n + f.waiting, 0), 2);
  assert.equal(stale[0].attention[0].id, 'old');
  assert.equal(attentionFloors(stale, 'a', [])[0].waiting, 0, 'removed workers disappear immediately');
  assert.deepEqual(attentionFloors(stale, null, []), stale, 'lobby uses all floor summaries');
  assert.deepEqual(attentionFloors([], null, []), []);
});

test('floor totals exclude board agents but retain their activity and attention, while meeting completions stay quiet', () => {
  const workers = [
    worker('desk', 'needs_input', { deskId: 'desk-1' }),
    worker('meeting', 'done', { deskId: 'meeting-1', meeting: 'review', acked: true }),
    worker('board-busy', 'working', { deskId: 'station-issues' }),
    worker('board-waiting', 'needs_input', { deskId: 'station-queue' }),
  ];
  const summary = summarizeWorkers(workers);
  assert.equal(summary.workers, 2);
  assert.equal(summary.busy, 1);
  assert.equal(summary.waiting, 2);
  assert.deepEqual(summary.attention.map((w) => w.id), ['desk', 'board-waiting']);
  const local = attentionFloors([floor('a', [])], 'a', workers)[0];
  assert.equal(local.workers, summary.workers);
  assert.equal(local.busy, summary.busy);
  assert.deepEqual(local.attention, summary.attention);
});

test('the building notification is bounded and omits terminal, session and usage fields', () => {
  const w = worker('1', 'needs_input', { activity: 'a'.repeat(1000), sessionId: 'private-session', prompt: 'full prompt' });
  const entry = workerAttention(w)!;
  assert.equal(entry.detail?.length, 200);
  assert.deepEqual(Object.keys(entry).sort(), ['color', 'detail', 'id', 'name', 'reason']);
});
