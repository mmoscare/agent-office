import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { AgentEffort, AgentProvider, WorkerInfo } from '../src/shared/protocol.js';

function fixture(defaultProvider: AgentProvider = 'claude') {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-queue-'));
  const workers: WorkerInfo[] = [];
  let hired = 0;
  const manager: QueueWorkers = {
    defaultProvider,
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, _worktree, kind, provider, model, effort) {
      const worker: WorkerInfo = {
        id: `worker-${hired++}`, deskId, kind, provider, model, effort, prompt, name: 'Test',
        color: '#ffffff', status: 'working', acked: false, createdBy: by,
        createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [],
      };
      workers.push(worker);
      return worker;
    },
    kill(id) {
      // Gone from the desks right away, the way the real one does it (before its worktree is dealt with).
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      return Promise.resolve({});
    },
  };
  const queues: TaskQueue[] = [];
  let emptied = 0;
  const open = (room?: () => number) => {
    const queue = new TaskQueue(dir, manager, false, {
      update() {}, toast() {}, claimIssue: async () => undefined,
      refreshGitHub() {}, hiringPaused: () => undefined, emptied: () => emptied++, room,
    });
    queues.push(queue);
    return queue;
  };
  return { dir, workers, open, emptied: () => emptied, close() { queues.forEach((q) => q.shutdown()); rmSync(dir, { recursive: true, force: true }); } };
}

test('queue seats the selected provider and preserves it through completion and retry', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.equal(q.add('Fix login', 'Tester', undefined, undefined, 'opencode'), undefined);
  assert.equal(f.workers[0].provider, 'opencode');
  f.workers[0].status = 'needs_input'; q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].status, 'running');
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].outcome, 'done');
  q.retry(q.state().tasks[0].id);
  assert.equal(f.workers[1].provider, 'opencode');
});

test('queued provider survives restart even when the configured default differs', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open(); q.setLimit(0);
  q.add('Fix login', 'Tester', undefined, undefined, 'opencode'); q.shutdown();
  const restored = f.open(); restored.setLimit(1);
  assert.equal(f.workers[0].provider, 'opencode');
});

test('a running task whose worker never reported a session stays running across a restart', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  q.add('Stop the arms moving', 'Tester', undefined, undefined, 'codex'); q.shutdown();
  // The office went down before the agent reported a session; its worker comes back asleep.
  f.workers[0].status = 'offline';
  const restored = f.open();
  assert.equal(restored.state().tasks[0].status, 'running');
  // Not yet woken is not stopped, so there's nothing to requeue.
  restored.onWorker(f.workers[0]);
  assert.equal(restored.state().tasks[0].status, 'running');
  assert.match(restored.retry(restored.state().tasks[0].id) ?? '', /still on the queue/);
  // Woken with its task again, it finishes it the usual way.
  f.workers[0].status = 'starting'; restored.onWorker(f.workers[0]);
  f.workers[0].status = 'done'; restored.onWorker(f.workers[0]);
  assert.equal(restored.state().tasks[0].outcome, 'done');
  assert.equal(f.workers.length, 1);
});

test('a running task whose worker had a session, or is gone, still stops at a restart', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  q.add('With a session', 'Tester'); q.add('Sent home', 'Tester'); q.shutdown();
  f.workers[0].sessionId = 'session-1';
  f.workers[0].status = 'offline';
  f.workers.splice(1, 1);
  const restored = f.open();
  for (const task of restored.state().tasks) {
    assert.equal(task.status, 'done');
    assert.equal(task.outcome, 'exited');
    assert.equal(task.error, 'The office restarted while it was running');
  }
});

test('new and legacy tasks without a provider use the configured agent', (t) => {
  const f = fixture('custom'); t.after(() => f.close());
  writeFileSync(path.join(f.dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [
    { id: 'legacy', title: 'Legacy', prompt: 'Legacy task', status: 'queued' },
  ] }));
  const q = f.open();
  q.add('New task', 'Tester'); q.setLimit(2);
  assert.deepEqual(f.workers.map((w) => w.provider), ['custom', 'custom']);
});

test('invalid or unavailable providers are rejected before a task is queued', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'bad' as AgentProvider) ?? '', /provider/i);
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'custom') ?? '', /provider/i);
  assert.equal(q.state().tasks.length, 0);
});

test('queue preserves the selected OpenCode model through seating, retry, and restart', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.equal(q.add('Fix login', 'Tester', undefined, undefined, 'opencode', 'openai/gpt-5/nested'), undefined);
  assert.equal(f.workers[0].model, 'openai/gpt-5/nested');
  assert.equal(q.state().tasks[0].model, 'openai/gpt-5/nested');
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  q.retry(q.state().tasks[0].id);
  assert.equal(f.workers[1].model, 'openai/gpt-5/nested');

  q.setLimit(0);
  q.add('Queued', 'Tester', undefined, undefined, 'opencode', 'anthropic/claude-sonnet-4');
  q.shutdown();
  const restored = f.open();
  restored.setLimit(2);
  assert.equal(f.workers[2].model, 'anthropic/claude-sonnet-4');
});

test('queue rejects models unless they are valid Claude aliases or OpenCode model ids', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'claude', 'openai/gpt-5') ?? '', /model/i);
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'opencode', 'gpt-5') ?? '', /model|format|provider/i);
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'opencode', 'openai/gpt 5') ?? '', /model|format|whitespace/i);
  assert.equal(q.state().tasks.length, 0);
});

test('queue rejects reasoning effort unless the task is Claude and the level is known', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'opencode', undefined, 'high' as AgentEffort) ?? '', /effort|Claude/i);
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'claude', undefined, 'overdrive' as AgentEffort) ?? '', /effort/i);
  assert.equal(q.state().tasks.length, 0);
});

test('queue preserves a Claude model and effort through seating, retry, and restart', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  assert.equal(q.add('Fix login', 'Tester', undefined, undefined, 'claude', 'haiku', 'low'), undefined);
  assert.equal(f.workers[0].model, 'haiku');
  assert.equal(f.workers[0].effort, 'low');
  assert.equal(q.state().tasks[0].model, 'haiku');
  assert.equal(q.state().tasks[0].effort, 'low');
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  q.retry(q.state().tasks[0].id);
  assert.equal(f.workers[1].model, 'haiku');
  assert.equal(f.workers[1].effort, 'low');

  q.setLimit(0);
  q.add('Queued', 'Tester', undefined, undefined, 'claude', 'opus', 'max');
  q.shutdown();
  const restored = f.open();
  restored.setLimit(2);
  assert.equal(f.workers[2].model, 'opus');
  assert.equal(f.workers[2].effort, 'max');
});

test('queue takes Fable and restores it from queue.json', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  q.setLimit(0);
  assert.equal(q.add('Big task', 'Tester', undefined, undefined, 'claude', 'fable', 'xhigh'), undefined);
  q.shutdown();
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'queue.json'), 'utf8'));
  assert.equal(saved.tasks[0].model, 'fable');
  const restored = f.open();
  assert.equal(restored.state().tasks[0].model, 'fable');
  restored.setLimit(1);
  assert.equal(f.workers[0].model, 'fable');
  assert.equal(f.workers[0].effort, 'xhigh');
});

test('the queue says it emptied once, when its last task gets done', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  q.add('First', 'Tester'); q.add('Second', 'Tester');
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  assert.equal(f.emptied(), 0, 'the second task is still running');
  f.workers[1].status = 'done'; q.onWorker(f.workers[1]);
  assert.equal(f.emptied(), 1);
  q.onWorker({ ...f.workers[1], status: 'idle' }); q.onWorker(f.workers[1]);
  assert.equal(f.emptied(), 1, 'finished tasks never empty it again');
});

test('the queue does not celebrate a task that stopped short, or one taken off it', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open();
  q.add('Crashes', 'Tester');
  f.workers[0].status = 'exited'; q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].outcome, 'exited');
  q.setLimit(0);
  q.add('Never starts', 'Tester');
  q.remove(q.state().tasks[1].id);
  assert.equal(f.emptied(), 0);
});

test('a board agent at work does not hold one of the queue\'s slots', (t) => {
  const f = fixture(); t.after(() => f.close());
  f.workers.push({
    id: 'issues-agent', deskId: 'station-issues', kind: 'agent', provider: 'claude', name: 'Issues agent',
    color: '#ef476f', status: 'working', acked: true, createdBy: 'Ada', createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [],
  });
  const q = f.open(); q.setLimit(1);
  q.add('Fix login', 'Tester');
  assert.equal(q.state().tasks[0].status, 'running');
  // Its seat is a desk, never the kiosk.
  assert.match(f.workers[1].deskId, /^desk-/);
});

test('an office at its worker limit holds the queue, and a finished queue worker makes room', (t) => {
  const f = fixture(); t.after(() => f.close());
  let limit = 1;
  const q = f.open(() => limit - f.workers.length);
  q.add('First', 'Tester'); q.add('Second', 'Tester');
  assert.deepEqual(q.state().tasks.map((t) => t.status), ['running', 'queued']);
  assert.equal(f.workers.length, 1);
  // The first finishes: its worker goes home to make room, and the second task gets the seat.
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  assert.deepEqual(q.state().tasks.map((t) => t.status), ['done', 'running']);
  assert.deepEqual(f.workers.map((w) => w.id), ['worker-1']);
  // The limit lowered past who's there: nobody is sent home and nothing fails, the queue just waits.
  q.add('Third', 'Tester');
  limit = 0;
  f.workers[0].status = 'done'; q.onWorker(f.workers[0]);
  assert.deepEqual(q.state().tasks.map((t) => [t.status, t.outcome]), [['done', 'done'], ['done', 'done'], ['queued', undefined]]);
  assert.equal(f.workers.length, 1);
  // Room again: it carries on.
  limit = 2; q.pump();
  assert.equal(q.state().tasks[2].status, 'running');
});

test('on a floor of several repositories, the same issue number in two of them are two tasks', (t) => {
  const f = fixture(); t.after(() => f.close());
  const q = f.open(); q.setLimit(0);
  assert.equal(q.add('Fix A', 'Tester', undefined, 3, undefined, undefined, undefined, 'me/a'), undefined);
  assert.equal(q.add('Fix B', 'Tester', undefined, 3, undefined, undefined, undefined, 'me/b'), undefined);
  assert.match(q.add('Fix A again', 'Tester', undefined, 3, undefined, undefined, undefined, 'me/a') ?? '', /a#3 is already/);
  assert.equal(q.dropIssue(3, 'me/b'), true);
  assert.deepEqual(q.state().tasks.map((x) => x.repo), ['me/a']);
});

test('a task for a To Do Next item tells the plans board when it starts and how it ends, and goes on the queue once', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-queue-plan-'));
  const workers: WorkerInfo[] = [];
  let hired = 0;
  const manager: QueueWorkers = {
    defaultProvider: 'claude',
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, _worktree, kind, provider) {
      const w = { id: `w${hired++}`, deskId, kind, provider, prompt, name: `Worker ${hired}`, color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      return w;
    },
    kill(id) {
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      return Promise.resolve({});
    },
  };
  const started: [string, string, string][] = [];
  const ended: [string, string][] = [];
  const events = { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} };
  const q = new TaskQueue(dir, manager, false, { ...events, startPlan: (plan, w, task) => started.push([plan, w.name, task]), endPlan: (plan, outcome) => ended.push([plan, outcome]) });
  t.after(() => {
    q.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(q.add('Renew the insurance', 'Ada', 'Renew the insurance', undefined, 'claude', undefined, undefined, undefined, 'plan-1'), undefined);
  assert.equal(q.add('Again', 'Ada', undefined, undefined, 'claude', undefined, undefined, undefined, 'plan-1'), 'That To Do Next item is already on the queue');
  const task = q.state().tasks[0];
  assert.equal(task.plan, 'plan-1');
  assert.equal(task.status, 'running');
  assert.deepEqual(started, [['plan-1', 'Worker 1', task.id]]);
  workers[0].status = 'done';
  q.onWorker(workers[0]);
  assert.deepEqual(ended, [['plan-1', 'done']]);
  // Once it's done the item can go on the queue again, and the link survives a restart.
  assert.equal(q.retry(task.id), undefined);
  assert.equal(q.state().tasks[0].plan, 'plan-1');
  assert.equal(started.length, 2);
  q.shutdown();
  const again = new TaskQueue(dir, manager, false, events);
  t.after(() => again.shutdown());
  assert.equal(again.state().tasks[0].plan, 'plan-1');
});
