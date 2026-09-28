import test from 'node:test';
import assert from 'node:assert/strict';
import { guessWorkKind, isWorkKind, WORK_KINDS } from '../src/shared/work-kind.js';
import { fallbackTask, withGuessedKind } from '../src/server/tasks.js';

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

test('a card saved before kinds existed gets one from its prompt, card or branch', () => {
  const card = { name: 'Sidebar tweaks', summary: 'Working on the sidebar' };
  assert.equal(withGuessedKind(card, 'the sidebar crashes on resize').kind, 'bug');
  // The card is newer than the first prompt, so it wins.
  assert.equal(withGuessedKind({ name: 'Merge conflicts', summary: 'Resolving the conflicts in protocol.ts' }, 'add a sidebar').kind, 'merge');
  assert.equal(withGuessedKind(card, undefined, 'office/docs/setup').kind, 'docs');
  assert.ok(!('kind' in withGuessedKind(card, 'hello', 'office/lumen-b730')));
  // A kind it already has is kept.
  assert.equal(withGuessedKind({ ...card, kind: 'review' }, 'fix the crash').kind, 'review');
});
