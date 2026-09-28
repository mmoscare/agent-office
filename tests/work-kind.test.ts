import test from 'node:test';
import assert from 'node:assert/strict';
import { guessWorkKind, isWorkKind, WORK_KINDS } from '../src/shared/work-kind.js';
import { fallbackTask, withKind } from '../src/server/tasks.js';

test('prompts read as the kind of work they ask for', () => {
  const cases: [string, string | undefined][] = [
    ['Resolve the merge conflicts in server.ts', 'merge'],
    ['fix the conflict after rebasing onto main', 'merge'],
    ['Please review PR #42', 'review'],
    ['add tests for the queue ordering', 'test'],
    ['the login page crashes when the session expires', 'bug'],
    ['fix the typo bug in the sidebar', 'bug'],
    ['update the README with setup steps', 'docs'],
    ['refactor the workers module into smaller files', 'refactor'],
    ['brainstorm ways to show what each worker does', 'research'],
    ['bump three to the latest version', 'chore'],
    ['add a dark mode toggle to settings', 'feature'],
    ['hello there', undefined],
  ];
  for (const [prompt, kind] of cases) assert.equal(guessWorkKind([prompt]), kind, prompt);
});

test('the latest prompt that says something wins; the branch name is the last resort', () => {
  assert.equal(guessWorkKind(['add a dark mode toggle', 'now there is a merge conflict, sort it out']), 'merge');
  assert.equal(guessWorkKind(['add a dark mode toggle', 'yes go ahead']), 'feature');
  assert.equal(guessWorkKind(['hello'], 'fix/login-redirect'), 'bug');
  assert.equal(guessWorkKind(['hello'], 'office/feat/sidebar'), 'feature');
  assert.equal(guessWorkKind(['hello'], 'office/lumen-b730'), undefined);
});

test('every kind has a style, and only those are kinds', () => {
  for (const k of Object.keys(WORK_KINDS)) assert.ok(isWorkKind(k));
  assert.equal(isWorkKind('toString'), false);
  assert.equal(isWorkKind('party'), false);
});

test('the fallback label carries a guessed kind when there is one', () => {
  assert.equal(fallbackTask('Fix the broken login redirect').kind, 'bug');
  assert.equal(fallbackTask('hello there').kind, undefined);
  assert.ok(!('kind' in fallbackTask('hello there')));
});

test('a label saved without a kind gets one from the prompts or branch, and a known kind is kept', () => {
  const legacy = { name: 'Login Redirect', summary: 'Working on the login redirect' };
  assert.deepEqual(withKind(legacy, ['Fix the broken login redirect']), { ...legacy, kind: 'bug' });
  assert.deepEqual(withKind(legacy, ['hello'], 'office/docs/setup'), { ...legacy, kind: 'docs' });
  assert.equal(withKind(legacy, ['hello there']), legacy);
  assert.ok(!('kind' in withKind(legacy, ['hello there'])!));
  const known = { ...legacy, kind: 'review' as const };
  assert.equal(withKind(known, ['Fix the broken login redirect']), known);
  assert.equal(withKind(undefined, ['Fix the broken login redirect']), undefined);
});
