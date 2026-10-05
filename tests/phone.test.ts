import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhoneLine, PhoneLog, PHONE_KEEP } from '../src/server/phone.js';
import type { PhoneCall, WorkerInfo } from '../src/shared/protocol.js';

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

const call = (n: number, over: Partial<PhoneCall> = {}): PhoneCall => ({
  at: n,
  floor: 'home',
  name: 'Home',
  workerId: `w${n}`,
  worker: 'Sprocket',
  deskId: 'desk-1',
  color: '#fff',
  task: 'Fix the login',
  ...over,
});

test('keeps who called, across a restart, and only the latest rings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-log-'));
  try {
    const log = new PhoneLog(dir);
    log.add(call(1));
    log.add(call(2, { worker: 'Ada', task: undefined }));
    assert.equal(new PhoneLog(dir).recent().length, 2);
    assert.equal(new PhoneLog(dir).recent()[1].worker, 'Ada');
    assert.equal(new PhoneLog(dir).recent()[1].task, undefined);
    const full = new PhoneLog(dir);
    for (let i = 3; i <= PHONE_KEEP + 5; i++) full.add(call(i));
    const again = new PhoneLog(dir);
    assert.equal(again.recent().length, PHONE_KEEP);
    assert.equal(again.recent()[0].at, 6);
    assert.equal(again.recent().at(-1)?.at, PHONE_KEEP + 5);
    const raw = await readFile(path.join(dir, 'phone.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, PHONE_KEEP);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('forgets a worker sent home', () => {
  const phone = new PhoneLine();
  phone.onWorker(worker('working'));
  phone.onWorkerGone('w1');
  assert.equal(phone.onWorker(worker('done')), false);
});
