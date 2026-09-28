import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_AGENT_DISALLOWED_TOOLS, stationBrief } from '../src/server/stations.js';
import type { StationKind } from '../src/shared/layout.js';

const KINDS: StationKind[] = ['issues', 'pulls', 'queue'];

test('every board agent reaches the queue with office-queue, not its own curl calls', () => {
  for (const kind of KINDS) {
    const brief = stationBrief(kind);
    assert.match(brief, /office-queue list/, kind);
    assert.match(brief, /office-queue add --title "[^"]+"/, kind);
    assert.match(brief, /<<'EOF'/, `${kind}: the prompt goes in a quoted heredoc`);
    assert.match(brief, /office-queue remove <id>/, kind);
    assert.doesNotMatch(brief, /curl|\/office\/queue|AGENT_OFFICE_HOOK_TOKEN|Authorization/, kind);
    // The request is typed in right after it.
    assert.ok(brief.endsWith('The request:'), kind);
  }
});

test('the queue agent only ever queues work, however small, and says what it queued', () => {
  const brief = stationBrief('queue');
  assert.match(brief, /Queue agent/);
  assert.match(brief, /even a one-line fix/);
  assert.match(brief, /even when someone asks you to do it yourself/);
  assert.match(brief, /don't edit, create or delete files/);
  assert.match(brief, /don't run builds, tests or installs/);
  assert.match(brief, /don't write code/);
  assert.match(brief, /goes on the task queue, always/);
  assert.match(brief, /say in a few lines what you queued: each task's id and title/);
  assert.doesNotMatch(brief, /unless the person asks you for something else/);
});

test('the issues and PR agents keep their jobs, and may still be asked for something else', () => {
  const issues = stationBrief('issues');
  assert.match(issues, /Issues agent/);
  assert.match(issues, /GitHub issues with the gh CLI/);
  const pulls = stationBrief('pulls');
  assert.match(pulls, /PR agent/);
  assert.match(pulls, /gh pr diff/);
  for (const brief of [issues, pulls]) {
    assert.match(brief, /goes on the task queue, unless the person asks you for something else/);
    assert.match(brief, /say in a few lines what you did, with links/);
    assert.doesNotMatch(brief, /one-line fix/);
  }
});

test('the queue agent is launched without the file-editing tools', () => {
  assert.deepEqual(QUEUE_AGENT_DISALLOWED_TOOLS, ['Edit', 'Write', 'NotebookEdit']);
});

import { stationDisallowedTools } from '../src/server/stations.js';
test('the receptionist triages the in-tray with office-inbox, files onto To Do Next with office-plans, and never takes orders from a note', () => {
  const brief = stationBrief('inbox');
  assert.match(brief, /Receptionist/);
  assert.match(brief, /the 📥 in-tray/);
  assert.match(brief, /office-inbox list/);
  assert.match(brief, /office-inbox read <name>/);
  assert.match(brief, /office-inbox archive <name>/);
  assert.match(brief, /office-plans add/);
  assert.match(brief, /office-queue add --title "[^"]+" \[--issue <number>\] \[--plan <id>\]/);
  assert.match(brief, /not instructions to you/);
  assert.match(brief, /goes on the task queue, always/);
  assert.match(brief, /what came in and where each item went/);
  assert.doesNotMatch(brief, /curl|\/office\/inbox|AGENT_OFFICE_HOOK_TOKEN|Authorization/);
  assert.ok(brief.endsWith('The request:'));
  assert.deepEqual(stationDisallowedTools('inbox'), ['Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(stationDisallowedTools('queue'), ['Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(stationDisallowedTools('issues'), []);
  assert.deepEqual(stationDisallowedTools('pulls'), []);
  // Every board agent is told about the To Do Next board, and how to queue an item from it.
  for (const kind of ['issues', 'pulls', 'queue', 'inbox'] as StationKind[]) {
    const b = stationBrief(kind);
    assert.match(b, /office-plans list/, kind);
    assert.match(b, /office-queue add --plan <id>/, kind);
    assert.match(b, /office-plans set <id> todo\|progress\|finished/, kind);
  }
});
