import test from 'node:test';
import assert from 'node:assert/strict';
import { floorRoster, rosterByRepo, rosterEntry, rosterFloors, ROSTER_DOING_MAX } from '../src/shared/roster.js';
import type { FloorInfo, WorkerInfo } from '../src/shared/protocol.js';

const worker = (id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id, name: id, deskId: `desk-${id}`, kind: 'agent', provider: 'claude', color: '#ff8a5b', status: 'working',
  acked: false, createdBy: 'Test', createdAt: 1, viewers: [], cols: 80, rows: 24, ...extra,
});
const floor = (id: string, extra: Partial<FloorInfo> = {}): FloorInfo => ({
  id, name: id, dir: `/projects/${id}`, palette: 0, addedBy: 'Test', addedAt: 1, people: 0,
  workers: 0, busy: 0, waiting: 0, attention: [], ...extra,
});

test('an entry names the floor repository and the worker task, falling back to what it was asked', () => {
  const tasked = rosterEntry(worker('a', { task: { name: 'Fix login', summary: 'Retries the token refresh' }, prompt: 'ignored' }), 'owner/app');
  assert.deepEqual(tasked.repos, ['owner/app']);
  assert.equal(tasked.doing, 'Fix login: Retries the token refresh');

  assert.equal(rosterEntry(worker('b', { title: 'Tidy CSS', prompt: 'ignored' }), 'owner/app').doing, 'Tidy CSS');
  assert.equal(rosterEntry(worker('c', { prompt: '  Add\n a   test  ' }), 'owner/app').doing, 'Add a test');
  assert.equal(rosterEntry(worker('d'), 'owner/app').doing, '');
});

test('a long summary is clipped and a single worktree keeps its branch', () => {
  const e = rosterEntry(worker('a', { prompt: 'x'.repeat(500), worktree: { path: 'wt/a', branch: 'office/a', base: 'abc' } }), 'repo');
  assert.equal(e.doing.length, ROSTER_DOING_MAX);
  assert.ok(e.doing.endsWith('…'));
  assert.equal(e.branch, 'office/a');
});

test('a multi-repository desk lists each of its repositories instead of the floor', () => {
  const e = rosterEntry(worker('a', {
    worktree: { path: 'wt/a', branch: 'office/a', base: 'abc' },
    workspace: {
      path: 'ws/a',
      repositories: [
        { repository: 'api', name: 'api', path: 'ws/a/api', branch: 'office/a', base: 'x' },
        { repository: 'web', name: 'web', path: 'ws/a/web', branch: 'office/a', base: 'y' },
      ],
    },
  }), 'floor-repo');
  assert.deepEqual(e.repos, ['api', 'web']);
  assert.equal(e.branch, undefined);
});

test('board agents are marked with their station and the roster runs oldest first', () => {
  const roster = floorRoster([worker('late', { createdAt: 5 }), worker('queue', { deskId: 'station-queue', createdAt: 2 })], 'r');
  assert.deepEqual(roster.map((e) => e.id), ['queue', 'late']);
  assert.equal(roster[0].station, 'queue');
  assert.equal(roster[1].station, undefined);
});

test('your floor uses live workers, other floors their broadcast roster, and repos group in floor order', () => {
  const stale = [floor('a', { repo: 'me/a', roster: [rosterEntry(worker('old'), 'me/a')] }), floor('b', { roster: [rosterEntry(worker('b1'), 'b')] }), floor('c')];
  const floors = rosterFloors(stale, 'a', [worker('new')]);
  assert.deepEqual(floors.map((f) => f.roster.map((e) => e.id)), [['new'], ['b1'], []]);
  assert.equal(floors[0].roster[0].repos[0], 'me/a');
  assert.deepEqual(rosterFloors(stale, null, [worker('new')])[0].roster.map((e) => e.id), ['old'], 'the lobby reads every broadcast');

  const multi = rosterEntry(worker('m', { workspace: { path: 'p', repositories: [{ repository: 'x', name: 'x', path: 'p/x', branch: 'b', base: 'c' }, { repository: 'y', name: 'y', path: 'p/y', branch: 'b', base: 'c' }] } }), 'me/a');
  const groups = rosterByRepo([...floors, { roster: [multi, rosterEntry(worker('a2'), 'me/a')] }]);
  assert.deepEqual(groups.map((g) => [g.repo, g.entries.map((e) => e.id)]), [['me/a', ['new', 'a2']], ['b', ['b1']], ['x + y', ['m']]]);
});
