import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { PtyHost, type PtyExit } from '../src/server/ptys.js';
import { TaskNamer } from '../src/server/tasks.js';
import { Ledger } from '../src/server/usage.js';
import { summarizeWorkers } from '../src/shared/attention.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

/** Exercise the real worker lifecycle without starting an agent or using provider credentials. */
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-attention-'));
  const data = path.join(root, 'data');
  mkdirSync(data);
  const command = path.join(root, 'custom-agent').replaceAll('\\', '/');
  writeFileSync(command, '', { mode: 0o700 });
  const exits: ((event: PtyExit) => void)[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(TaskNamer.prototype, 'request', () => {});
  t.mock.method(PtyHost.prototype, 'spawn', () => ({
    pid: 1, write() {}, resize() {}, kill() {}, onData() {},
    onExit: (callback: (event: PtyExit) => void) => exits.push(callback),
  }));
  const workers = new WorkerManager(root, data, command, [], { url: 'http://127.0.0.1:1', token: '' }, {
    update() {}, remove() {}, data() {}, screen() {}, toast() {},
  }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => {
    workers.shutdown();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('office-attention-'));
    rmSync(root, { recursive: true, force: true });
  });
  const info = workers.spawn('desk-1', 'Test', 'Test task');
  assert.notEqual(typeof info, 'string');
  return { workers, info: info as WorkerInfo, exits, count: () => summarizeWorkers(workers.list()).waiting };
}

test('a process failure becomes unread, clears on viewing, and notifies again after a failed retry', (t) => {
  const { workers, info, exits, count } = fixture(t);
  exits[0]({ exitCode: 2 });
  assert.equal(info.acked, false);
  assert.equal(count(), 1);
  workers.attach(info.id, 'reader', 'Test');
  assert.equal(count(), 0);
  workers.detach(info.id, 'reader');
  assert.equal(workers.resume(info.id), undefined);
  assert.equal(count(), 0);
  exits[1]({ exitCode: 3 });
  assert.equal(count(), 1);
});

test('a startup error becomes a notification, while a normal exit does not', (t) => {
  const { workers, info, exits, count } = fixture(t);
  exits[0]({ exitCode: -1, error: 'Test launch failed' });
  assert.equal(info.exitCode, -1);
  assert.equal(count(), 1);
  assert.equal(workers.resume(info.id), undefined);
  exits[1]({ exitCode: 0 });
  assert.equal(count(), 0);
});

test('errors already seen in an open terminal do not leave an unread badge', (t) => {
  const { workers, info, exits, count } = fixture(t);
  workers.attach(info.id, 'reader', 'Test');
  exits[0]({ exitCode: 2 });
  assert.equal(count(), 0);
  assert.equal(workers.resume(info.id), undefined);
  exits[1]({ exitCode: -1, error: 'Test launch failed' });
  assert.equal(count(), 0);
});
