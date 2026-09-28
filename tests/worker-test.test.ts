import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { workerTestPrompt, workerTestUnavailable } from '../src/shared/worker-test.js';

const worker = { id: 'test-worker', name: 'Pixel', kind: 'agent', status: 'idle' } as WorkerInfo;

test('testing a task includes both repository worktrees, their branches and their starting commits', () => {
  const prompt = workerTestPrompt({ ...worker, workspace: {
    path: '.agent-office/workspaces/pixel', repositories: [
      { name: 'Frontend', repository: 'frontend', path: '.agent-office/workspaces/pixel/frontend', branch: 'feature/login', base: 'front-base' },
      { name: 'Backend', repository: 'backend', path: '.agent-office/workspaces/pixel/backend', branch: 'feature/login-api', base: 'back-base' },
    ],
  } }, 'C:\\Projects\\My Portfolio');
  assert.match(prompt, /C:\/Projects\/My Portfolio\/\.agent-office\/workspaces\/pixel\/frontend/);
  assert.match(prompt, /C:\/Projects\/My Portfolio\/\.agent-office\/workspaces\/pixel\/backend/);
  assert.match(prompt, /feature\/login-api/);
  assert.match(prompt, /front-base/); assert.match(prompt, /back-base/);
  assert.match(prompt, /test them together/);
  assert.match(prompt, /committed changes/);
  assert.match(prompt, /blocked or untested/);
});

test('single-worktree and shared-folder tasks include additional worktrees created manually by the agent', () => {
  const own = workerTestPrompt({ ...worker, worktree: { path: '.agent-office/worktrees/pixel', branch: 'office/pixel', base: 'base-commit' } }, '/projects/app');
  assert.match(own, /\/projects\/app\/\.agent-office\/worktrees\/pixel/);
  assert.match(own, /additional worktrees you created/);
  const shared = workerTestPrompt(worker, 'C:\\Projects\\Portfolio');
  assert.match(shared, /shared folders, preserve existing uncommitted work/);
  assert.match(shared, /do not limit testing/);
  assert.match(shared, /Do not switch branches, reset, stash, discard changes, commit, push, merge or delete worktrees/);
});

test('test requests cannot be typed into shells, busy agents or agents asking for input', () => {
  assert.ok(workerTestUnavailable(undefined));
  assert.ok(workerTestUnavailable({ ...worker, kind: 'shell' }));
  for (const status of ['starting', 'working', 'needs_input', 'exited', 'offline'] satisfies WorkerStatus[]) {
    assert.ok(workerTestUnavailable({ ...worker, status }), status);
  }
  assert.ok(workerTestUnavailable({ ...worker, prOpening: true }));
  assert.equal(workerTestUnavailable(worker), undefined);
  assert.equal(workerTestUnavailable({ ...worker, status: 'done' }), undefined);
});
