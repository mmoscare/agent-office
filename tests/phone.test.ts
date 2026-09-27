import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneLine } from '../src/server/phone.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (status: WorkerInfo['status'], over: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id: 'w1',
  kind: 'agent',
  deskId: 'desk-1',
  name: 'Sprocket',
  color: '#fff',
  status,
  acked: false,
  createdBy: 'me',
  createdAt: 0,
  cols: 80,
  rows: 24,
  viewers: [],
  ...over,
});

test('rings when an agent worker finishes a turn, once', () => {
  const phone = new PhoneLine();
  assert.equal(phone.onWorker(worker('working')), false);
  assert.equal(phone.onWorker(worker('done')), true);
  // Someone opening its terminal (acked) is another update, not another finish.
  assert.equal(phone.onWorker(worker('done', { acked: true })), false);
  assert.equal(phone.onWorker(worker('working')), false);
  assert.equal(phone.onWorker(worker('done')), true);
});

test('stays quiet for workers waking up already done, and for shells', () => {
  const phone = new PhoneLine();
  assert.equal(phone.onWorker(worker('done')), false);
  assert.equal(phone.onWorker(worker('working', { id: 'sh', kind: 'shell' })), false);
  assert.equal(phone.onWorker(worker('done', { id: 'sh', kind: 'shell' })), false);
});

test('forgets a worker sent home', () => {
  const phone = new PhoneLine();
  phone.onWorker(worker('working'));
  phone.onWorkerGone('w1');
  assert.equal(phone.onWorker(worker('done')), false);
});
