import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPullWork, pullWorkers, workerForPull, pullWorkStatus, pullBoardKey } from '../src/shared/pull-work.js';
import type { PullWork, WorkerInfo } from '../src/shared/protocol.js';
import { WorkerManager } from '../src/server/workers.js';
import { PtyHost } from '../src/server/ptys.js';
import { TaskNamer } from '../src/server/tasks.js';
import { Ledger } from '../src/server/usage.js';

const pr = { number: 12, url: 'https://github.com/example/project/pull/12', headRefName: 'office/original' };
const link: PullWork = { number: pr.number, url: pr.url, action: 'comments' };
const worker = (id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id, name: id, kind: 'agent', deskId: 'desk-1', color: '#123456', status: 'working', acked: true,
  createdBy: 'Test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], ...extra,
});

test('assignments validate and normalize repository-qualified PR URLs', () => {
  assert.deepEqual(readPullWork({ ...link, url: `${link.url}/?tab=files#comment` }), link);
  for (const value of [null, {}, { ...link, number: 0 }, { ...link, number: 1.2 }, { ...link, action: '__proto__' }, { ...link, action: { toString: 1 } },
    { ...link, url: 'javascript:alert(1)' }, { ...link, url: link.url.replace('/12', '/13') }]) {
    assert.equal(readPullWork(value), undefined);
  }
});

test('new fixers win over the original desk, without mixing same-number PRs across repositories', () => {
  const original = worker('original', { pr, worktree: { branch: pr.headRefName, path: '.', base: 'abc' } });
  const fixer = worker('fixer', { pullWork: { ...link, assignedAt: 10 } });
  const otherRepo = { ...pr, repo: 'example/other', url: 'https://github.com/example/other/pull/12' };
  assert.equal(workerForPull([original, fixer], pr), fixer);
  assert.equal(workerForPull([original, fixer], otherRepo), undefined);
  const finished = worker('previous', { status: 'done', pullWork: { ...link, assignedAt: 20 } });
  assert.deepEqual(pullWorkers([finished, fixer, original], pr), [fixer, finished]);
  assert.equal(workerForPull([original], pr), original);
  assert.equal(workerForPull([original], { number: 12, headRefName: pr.headRefName }), original);
  assert.equal(workerForPull([original], { ...pr, url: undefined, repo: 'example/other' }), undefined);
});

test('status distinguishes submission, activity, questions, completion and stopped sessions', () => {
  const w = worker('fixer', { pullWork: { ...link, assignedAt: 10 } });
  for (const [status, text, active] of [
    ['starting', 'Starting', true], ['working', 'Working', true], ['needs_input', 'Needs input', false],
    ['idle', 'Assigned', false], ['offline', 'Offline', false], ['exited', 'Stopped', false],
  ] as const) {
    assert.equal(pullWorkStatus({ ...w, status }).text, text);
    assert.equal(pullWorkStatus({ ...w, status }).active, active);
  }
  assert.equal(pullWorkStatus({ ...w, status: 'done', waitingSince: 5 }).text, 'Assigned');
  assert.equal(pullWorkStatus({ ...w, status: 'done', waitingSince: 15 }).text, 'Turn finished');
});

test('the 3D board redraws for assignments and their status, not for unrelated worker updates', () => {
  const original = worker('original', { pr, worktree: { branch: pr.headRefName, path: '.', base: 'abc' } });
  const fixer = worker('fixer', { status: 'idle' });
  const key = pullBoardKey([original, fixer]);
  // An existing worker without a worktree is handed the PR.
  const assigned = { ...fixer, pullWork: { ...link, assignedAt: 10 } };
  assert.notEqual(pullBoardKey([original, assigned]), key);
  const working = { ...assigned, status: 'working' as const };
  assert.notEqual(pullBoardKey([original, working]), pullBoardKey([original, assigned]));
  const finished = { ...working, status: 'done' as const, waitingSince: 20 };
  assert.notEqual(pullBoardKey([original, finished]), pullBoardKey([original, working]));
  // Busy/idle churn on unassigned workers, and other fields, don't redraw it.
  assert.equal(pullBoardKey([{ ...original, status: 'idle', title: 'Something else' }, fixer]), key);
  assert.equal(pullBoardKey([original, { ...fixer, status: 'working' }]), key);
});

test('new/existing workers broadcast and persist assignments only after accepted requests', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-pull-work-'));
  const data = path.join(root, 'data');
  mkdirSync(data);
  const command = path.join(root, 'custom-agent').replaceAll('\\', '/');
  writeFileSync(command, '', { mode: 0o700 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(TaskNamer.prototype, 'request', () => {});
  t.mock.method(PtyHost.prototype, 'spawn', () => ({ pid: 1, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
  const updates: WorkerInfo[] = [];
  const managers: WorkerManager[] = [];
  const open = () => {
    const workers = new WorkerManager(root, data, command, [], { url: 'http://127.0.0.1:1', token: '' }, {
      update: w => updates.push(w), remove() {}, data() {}, screen() {}, toast() {},
    }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    managers.push(workers);
    return workers;
  };
  t.after(async () => {
    managers.forEach(m => m.shutdown());
    t.mock.timers.reset();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('office-pull-work-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const workers = open();
  const result = workers.spawn('desk-1', 'Test', 'Fix comments', false, 'agent', undefined, undefined, undefined, undefined, undefined, link);
  assert.notEqual(typeof result, 'string');
  const w = result as WorkerInfo;
  assert.equal(w.pullWork?.action, 'comments');
  assert.equal(updates.at(-1)?.pullWork?.url, pr.url);
  assert.equal(w.pr, undefined, 'assignment must not replace the worker branch PR');
  const next = { ...link, action: 'conflicts' };
  assert.equal(workers.prompt(w.id, '', 'Test', next), 'Empty prompt');
  assert.equal(w.pullWork?.action, 'comments');
  assert.equal(workers.prompt(w.id, 'Resolve conflicts', 'Test', next), undefined);
  assert.equal(updates.at(-1)?.pullWork?.action, 'conflicts');
  assert.equal(JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8'))[0].pullWork.action, 'conflicts');
  const restored = open();
  assert.equal(restored.get(w.id)?.pullWork?.action, 'conflicts');
  assert.equal(pullWorkStatus(restored.get(w.id)!).text, 'Offline');
  assert.equal(restored.prompt(w.id, 'Cannot submit', 'Test', link), 'Worker is not running');
  assert.equal(restored.get(w.id)?.pullWork?.action, 'conflicts');
  workers.prompt(w.id, 'Continue', 'Test');
  assert.equal(w.pullWork?.action, 'conflicts', 'follow-ups retain context');
  workers.prompt(w.id, 'A different board task', 'Test', null);
  assert.equal(w.pullWork, undefined, 'explicit reassignment clears the old PR');
  assert.equal(JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8'))[0].pullWork, undefined);
});
