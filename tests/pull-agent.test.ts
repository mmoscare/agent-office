import test from 'node:test';
import assert from 'node:assert/strict';
import { branchWorker } from '../src/shared/pulls.js';

test('names the worker an office branch was made for', () => {
  assert.equal(branchWorker('office/widget-0200'), 'Widget');
  assert.equal(branchWorker('office/sprocket-f07b'), 'Sprocket');
  assert.equal(branchWorker('office/byte-1a2b3c4d5e6f'), 'Byte');
});

test('names no worker for other branches', () => {
  assert.equal(branchWorker('main'), undefined);
  assert.equal(branchWorker('feature/widget-0200'), undefined);
  assert.equal(branchWorker('office/test'), undefined);
  assert.equal(branchWorker('office/meeting-plan-ab12'), undefined);
  assert.equal(branchWorker('office/meeting-ab12'), undefined);
});
