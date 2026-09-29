import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Todos } from '../src/server/todos.js';
import { applyTodo, checkTodoAction, TODO_LIMIT, TODO_TEXT_MAX, todosIn, type TodoAction, type TodoItem } from '../src/shared/todos.js';

const id = (n: number) => `item${String(n).padStart(4, '0')}`;
const run = (...changes: TodoAction[]) => changes.reduce<readonly TodoItem[]>((items, a) => applyTodo(items, a, 1000), []);
const texts = (items: readonly TodoItem[], column: TodoItem['column']) => todosIn(items, column).map((t) => t.text);

test('items are added to the end of their column, or where asked', () => {
  const items = run(
    { action: 'add', id: id(1), text: 'one', column: 'todo' },
    { action: 'add', id: id(2), text: 'two', column: 'todo' },
    { action: 'add', id: id(3), text: 'now', column: 'active' },
    { action: 'add', id: id(4), text: 'first', column: 'todo', index: 0 },
    { action: 'add', id: id(5), text: 'middle', column: 'todo', index: 2 },
  );
  assert.deepEqual(texts(items, 'todo'), ['first', 'one', 'middle', 'two']);
  assert.deepEqual(texts(items, 'active'), ['now']);
});

test('moving an item takes it across columns and reorders within one', () => {
  let items = run(
    { action: 'add', id: id(1), text: 'a', column: 'todo' },
    { action: 'add', id: id(2), text: 'b', column: 'todo' },
    { action: 'add', id: id(3), text: 'c', column: 'todo' },
  );
  items = applyTodo(items, { action: 'move', id: id(3), column: 'todo', index: 0 });
  assert.deepEqual(texts(items, 'todo'), ['c', 'a', 'b']);
  items = applyTodo(items, { action: 'move', id: id(3), column: 'todo', index: 2 });
  assert.deepEqual(texts(items, 'todo'), ['a', 'b', 'c']);
  items = applyTodo(items, { action: 'move', id: id(2), column: 'active' });
  assert.deepEqual(texts(items, 'todo'), ['a', 'c']);
  assert.deepEqual(texts(items, 'active'), ['b']);
});

test('completing an item stamps when, and reopening it clears that', () => {
  let items = run({ action: 'add', id: id(1), text: 'ship it', column: 'active' });
  items = applyTodo(items, { action: 'move', id: id(1), column: 'done', index: 0 }, 5000);
  assert.equal(items[0].column, 'done');
  assert.equal(items[0].doneAt, 5000);
  // Moved about within Completed: still done when it was.
  items = applyTodo(items, { action: 'move', id: id(1), column: 'done', index: 0 }, 9000);
  assert.equal(items[0].doneAt, 5000);
  items = applyTodo(items, { action: 'move', id: id(1), column: 'todo' });
  assert.equal(items[0].column, 'todo');
  assert.equal(items[0].doneAt, undefined);
});

test('changes that change nothing give back the same list', () => {
  const items = run({ action: 'add', id: id(1), text: 'a', column: 'todo' });
  assert.equal(applyTodo(items, { action: 'add', id: id(1), text: 'again', column: 'todo' }), items);
  assert.equal(applyTodo(items, { action: 'move', id: id(9), column: 'done' }), items);
  assert.equal(applyTodo(items, { action: 'edit', id: id(1), text: 'a' }), items);
  assert.equal(applyTodo(items, { action: 'remove', id: id(9) }), items);
  assert.deepEqual(applyTodo(items, { action: 'remove', id: id(1) }), []);
});

test('a full list lets go of its oldest completed item first', () => {
  let items: readonly TodoItem[] = [];
  for (let i = 0; i < TODO_LIMIT; i++) items = applyTodo(items, { action: 'add', id: id(i), text: `t${i}`, column: i < 2 ? 'done' : 'todo' }, i);
  items = applyTodo(items, { action: 'add', id: id(TODO_LIMIT), text: 'new', column: 'active' }, TODO_LIMIT);
  assert.equal(items.length, TODO_LIMIT);
  assert.ok(!items.some((t) => t.id === id(0)));
  assert.ok(items.some((t) => t.id === id(1)));
  assert.ok(items.some((t) => t.text === 'new'));
});

test('only well-formed changes from a browser are taken', () => {
  assert.deepEqual(checkTodoAction({ action: 'add', id: id(1), text: '  tidy   the desk ', column: 'active' }), { action: 'add', id: id(1), text: 'tidy the desk', column: 'active' });
  assert.deepEqual(checkTodoAction({ action: 'move', id: id(1), column: 'done', index: 2 }), { action: 'move', id: id(1), column: 'done', index: 2 });
  assert.deepEqual(checkTodoAction({ action: 'move', id: id(1), column: 'done', index: -1 }), { action: 'move', id: id(1), column: 'done' });
  assert.equal(checkTodoAction({ action: 'add', id: id(1), text: '   ', column: 'todo' }), null);
  assert.equal(checkTodoAction({ action: 'add', id: id(1), text: 'x'.repeat(TODO_TEXT_MAX + 1), column: 'todo' }), null);
  assert.equal(checkTodoAction({ action: 'add', id: 'Bad Id!', text: 'x', column: 'todo' }), null);
  assert.equal(checkTodoAction({ action: 'move', id: id(1), column: 'someday' }), null);
  assert.equal(checkTodoAction({ action: 'wipe', id: id(1) }), null);
  assert.equal(checkTodoAction(null), null);
});

test('each person has their own list, and it is still there after a restart', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-todos-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = new Todos(dir);
  assert.ok(before.apply('shared', { action: 'add', id: id(1), text: 'mine', column: 'active' }));
  assert.ok(before.apply('account:ada', { action: 'add', id: id(2), text: 'hers', column: 'todo' }));
  assert.equal(before.apply('shared', { action: 'remove', id: id(2) }), null);
  const after = new Todos(dir);
  assert.deepEqual(after.list('shared').map((x) => [x.text, x.column]), [['mine', 'active']]);
  assert.deepEqual(after.list('account:ada').map((x) => x.text), ['hers']);
  assert.deepEqual(after.list('account:nobody'), []);
});

test('a broken or tampered file starts empty or keeps just its good items', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-todos-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'todos.json');
  writeFileSync(file, '{ not json');
  assert.deepEqual(new Todos(dir).list('shared'), []);
  writeFileSync(file, JSON.stringify({ shared: [{ id: id(1), text: 'ok', column: 'todo', at: 1 }, { id: id(1), text: 'dupe', column: 'todo', at: 2 }, { id: id(2), text: 'bad', column: 'nope', at: 3 }, 'junk'] }));
  const todos = new Todos(dir);
  assert.deepEqual(todos.list('shared').map((x) => x.text), ['ok']);
  todos.apply('shared', { action: 'edit', id: id(1), text: 'better' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).shared[0].text, 'better');
});
