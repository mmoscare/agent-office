import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import { CHECKPOINT_NOTE, retoldTask, withWorkerHandoff } from '../src/server/handoff.js';
import { stationBrief } from '../src/server/stations.js';
import type { StationKind } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

// The prompt a queued task is started with, with or without its own worktree.
function queuedPrompt(useWorktree: boolean, issue?: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-checkpoint-'));
  const prompts: string[] = [];
  const workers: WorkerInfo[] = [];
  const manager: QueueWorkers = {
    defaultProvider: 'claude',
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, _worktree, kind, provider) {
      prompts.push(prompt);
      const w = { id: `w${workers.length}`, deskId, kind, provider, prompt, name: 'Test', color: '#fff', status: 'working', acked: false, createdBy: by, createdAt: Date.now(), cols: 80, rows: 24, viewers: [], viewerIds: [] } as WorkerInfo;
      workers.push(w);
      return w;
    },
    kill: () => Promise.resolve({}),
  };
  const q = new TaskQueue(dir, manager, useWorktree, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} });
  try {
    assert.equal(q.add('Fix the login redirect', 'Tester', 'Login', issue), undefined);
  } finally {
    q.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(prompts.length, 1);
  return prompts[0];
}

test('a queued task in its own worktree is told to commit and push early and often', () => {
  const prompt = queuedPrompt(true);
  assert.ok(prompt.startsWith('Fix the login redirect\n\n'));
  assert.ok(prompt.includes(CHECKPOINT_NOTE));
  assert.match(prompt, /git add -A && git commit -m "WIP: <task title>"/);
  assert.match(prompt, /git push -u origin HEAD/);
  assert.match(prompt, /leave no uncommitted changes/);
  assert.match(prompt, /commit locally|committing locally/);
  assert.match(prompt, /woken after a restart, first run git status/);
  // The office's handoff rule still goes after it on launch.
  assert.match(withWorkerHandoff(prompt)!, /<\/agent-office-checkpoint>\n\n<agent-office-handoff>/);
});

test('a task started from a GitHub issue gets the checkpoint rule too', () => {
  assert.ok(queuedPrompt(true, 42).includes(CHECKPOINT_NOTE));
});

test('a queued task sharing the main checkout is not told to commit there', () => {
  assert.ok(!queuedPrompt(false).includes(CHECKPOINT_NOTE));
});

test('a worker restarted without a session gets its task back with the checkpoint rule and what to check first', () => {
  const retold = retoldTask(queuedPrompt(true))!;
  assert.ok(retold.includes(CHECKPOINT_NOTE));
  assert.match(retold, /git status and git log @\{u\}\.\.HEAD first/);
});

test('board agents are never given the checkpoint rule, and the queue agent knows the office appends it', () => {
  for (const kind of ['issues', 'pulls', 'queue', 'inbox'] as StationKind[]) {
    const brief = withWorkerHandoff(`${stationBrief(kind)}\n\nDo the thing`)!;
    assert.doesNotMatch(brief, /agent-office-checkpoint|Checkpoint rule/, kind);
    assert.match(brief, /don't switch branches, commit, or leave edits/, kind);
  }
  assert.match(stationBrief('queue'), /needn't repeat when to commit and push: the office appends that rule itself/);
});
