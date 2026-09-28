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
