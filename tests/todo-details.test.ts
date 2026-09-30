import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Todos } from '../src/server/todos.js';
import { TodoImages } from '../src/server/todo-images.js';
import { applyTodo, checkTodoAction, checkTodoItem, hasDetails, TODO_IMAGES_MAX, TODO_NOTES_MAX, TODO_SUBTASKS_MAX, type TodoAction, type TodoItem } from '../src/shared/todos.js';
import { applyContent, checkContentAction, checkContentItem, type ContentItem } from '../src/shared/content-kanban.js';

// A kanban card's notes, subtasks and pictures (shared/todos.ts, ui/todo-details.ts), on the To Do,
// the Autonomous Tasks and the Content Kanban.

const id = (n: number) => `item${String(n).padStart(4, '0')}`;
const pic = (n: number) => `${String(n).padStart(32, 'a')}.png`;
const run = (...changes: TodoAction[]) => changes.reduce<readonly TodoItem[]>((items, a) => applyTodo(items, a, 1000), []);

test('a card takes notes, subtasks and pictures, and loses each when it is emptied', () => {
  let items = run({ action: 'add', id: id(1), text: 'film the intro', column: 'urgent' });
  assert.equal(hasDetails(items[0]), false);
  items = applyTodo(items, { action: 'details', id: id(1), notes: 'Hook:\n- start cold\n' });
  assert.equal(items[0].notes, 'Hook:\n- start cold\n');
  items = applyTodo(items, { action: 'details', id: id(1), subtasks: [{ id: 'sub001', text: 'script', done: true }, { id: 'sub002', text: 'shoot', done: false }] });
  items = applyTodo(items, { action: 'details', id: id(1), images: [pic(1)] });
  // Each change leaves the others where they were.
  assert.equal(items[0].notes, 'Hook:\n- start cold\n');
  assert.deepEqual(items[0].subtasks?.map((s) => s.done), [true, false]);
  assert.deepEqual(items[0].images, [pic(1)]);
  assert.equal(hasDetails(items[0]), true);
  items = applyTodo(items, { action: 'details', id: id(1), notes: '', subtasks: [], images: [] });
  assert.deepEqual(Object.keys(items[0]).sort(), ['at', 'column', 'id', 'text']);
  // The same again changes nothing.
  assert.equal(applyTodo(items, { action: 'details', id: id(1), notes: '' }), items);
  assert.equal(applyTodo(items, { action: 'details', id: id(9), notes: 'x' }), items);
});

test('a card moved, edited or completed keeps its details, and Undo brings them back', () => {
  let items = run({ action: 'add', id: id(1), text: 'a', column: 'todo', notes: 'n', subtasks: [{ id: 'sub001', text: 's', done: false }], images: [pic(2)] });
  assert.equal(items[0].notes, 'n');
  items = applyTodo(items, { action: 'move', id: id(1), column: 'done' });
  items = applyTodo(items, { action: 'edit', id: id(1), text: 'b' });
  assert.deepEqual([items[0].notes, items[0].subtasks?.length, items[0].images], ['n', 1, [pic(2)]]);
  const card = items[0];
  items = applyTodo(items, { action: 'remove', id: id(1) });
  items = applyTodo(items, { action: 'add', id: card.id, text: card.text, column: card.column, notes: card.notes, subtasks: card.subtasks, images: card.images });
  assert.deepEqual([items[0].notes, items[0].subtasks, items[0].images], [card.notes, card.subtasks, card.images]);
});

test('only well-formed details from a browser are taken', () => {
  assert.deepEqual(checkTodoAction({ action: 'details', id: id(1), notes: 'a\r\nb  ' }), { action: 'details', id: id(1), notes: 'a\nb' });
  assert.deepEqual(checkTodoAction({ action: 'details', id: id(1), subtasks: [{ id: 'sub001', text: '  tidy  up ', done: 'yes' }] }), { action: 'details', id: id(1), subtasks: [{ id: 'sub001', text: 'tidy up', done: false }] });
  assert.deepEqual(checkTodoAction({ action: 'details', id: id(1), images: [pic(1), pic(1)] }), { action: 'details', id: id(1), images: [pic(1)] });
  assert.equal(checkTodoAction({ action: 'details', id: id(1) }), null, 'nothing to change');
  assert.equal(checkTodoAction({ action: 'details', id: id(1), notes: 'x'.repeat(TODO_NOTES_MAX + 1) }), null);
  assert.equal(checkTodoAction({ action: 'details', id: id(1), subtasks: [{ id: 'sub001', text: 'a' }, { id: 'sub001', text: 'b' }] }), null, 'same subtask twice');
  assert.equal(checkTodoAction({ action: 'details', id: id(1), subtasks: Array.from({ length: TODO_SUBTASKS_MAX + 1 }, (_, i) => ({ id: `sub${String(i).padStart(4, '0')}`, text: 'x' })) }), null);
  assert.equal(checkTodoAction({ action: 'details', id: id(1), images: ['../../etc/passwd'] }), null);
  assert.equal(checkTodoAction({ action: 'details', id: id(1), images: Array.from({ length: TODO_IMAGES_MAX + 1 }, (_, i) => pic(i)) }), null);
  assert.equal(checkTodoAction({ action: 'add', id: id(1), text: 'x', column: 'todo', images: ['nope.exe'] }), null);
  // Read back from disk: bad extras are left off, the card stays.
  const card = checkTodoItem({ id: id(1), text: 'x', column: 'todo', at: 1, notes: 5, subtasks: 'junk', images: [pic(3)] });
  assert.deepEqual(card, { id: id(1), text: 'x', column: 'todo', at: 1, images: [pic(3)] });
});

test('the Autonomous Tasks board is its own list, in its own file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-autonomous-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const todos = new Todos(dir);
  const autonomous = new Todos(dir, 'autonomous.json');
  autonomous.apply('office', { action: 'add', id: id(1), text: 'ship the newsletter', column: 'urgent', notes: 'issue 3' });
  todos.apply('shared', { action: 'add', id: id(2), text: 'mine', column: 'todo' });
  const again = new Todos(dir, 'autonomous.json');
  assert.deepEqual(again.list('office').map((x) => [x.text, x.notes]), [['ship the newsletter', 'issue 3']]);
  assert.deepEqual(new Todos(dir).list('shared').map((x) => x.text), ['mine']);
  assert.deepEqual(again.list('shared'), []);
});

test('card pictures are kept by what is in them, and only real pictures are taken', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-todo-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const images = new TodoImages(dir);
  // A 1×1 PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const a = images.add({ dataURL: `data:image/png;base64,${png}` });
  assert.ok('id' in a && /^[a-f0-9]{32}\.png$/.test(a.id));
  const b = images.add({ dataURL: `data:image/jpeg;base64,${png}` });
  assert.deepEqual(b, a, 'the same picture, whatever it claims to be, is one file named for its real type');
  assert.equal(images.get((a as { id: string }).id)?.type, 'image/png');
  assert.ok('error' in images.add({ dataURL: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }));
  assert.ok('error' in images.add({ dataURL: 'javascript:alert(1)' }));
  assert.ok('error' in images.add(null));
  assert.equal(images.get('../todos.json'), undefined);
  assert.equal(images.get(pic(7)), undefined);
});

test('Content Kanban cards take subtasks and pictures too', () => {
  const card: ContentItem = { id: id(1), title: 'A behind-the-scenes clip', stage: 'idea', pieces: [], at: 1 };
  let items: readonly ContentItem[] = [card];
  items = applyContent(items, { action: 'details', id: id(1), subtasks: [{ id: 'sub001', text: 'outline', done: false }], images: [pic(4)] });
  assert.deepEqual([items[0].subtasks?.[0].text, items[0].images], ['outline', [pic(4)]]);
  assert.equal(applyContent(items, { action: 'details', id: id(1), images: [pic(4)] }), items);
  items = applyContent(items, { action: 'details', id: id(1), subtasks: [] });
  assert.equal(items[0].subtasks, undefined);
  assert.deepEqual(checkContentAction({ action: 'details', id: id(1), images: [pic(4)] }), { action: 'details', id: id(1), images: [pic(4)] });
  assert.equal(checkContentAction({ action: 'details', id: id(1) }), null);
  assert.equal(checkContentAction({ action: 'details', id: id(1), images: ['x.svg'] }), null);
  assert.deepEqual(checkContentItem({ ...card, images: [pic(5)], subtasks: [{ id: 'sub001', text: 'x', done: true }] })?.images, [pic(5)]);
});

test('on the shared Autonomous board, your changes stay on screen until the office answers them', async () => {
  const { store } = await import('../src/client/state.js');
  const text = (n: number) => store.autonomous.find((t) => t.id === id(n))?.text;
  store.apply({ t: 'todos', board: 'autonomous', items: [{ id: id(1), text: 'a', column: 'todo', at: 1 }] });
  assert.equal(store.changeAutonomous({ action: 'add', id: id(2), text: 'mine', column: 'urgent' }), true);
  assert.equal(store.changeAutonomous({ action: 'add', id: id(2), text: 'again', column: 'urgent' }), false, 'nothing to send');
  // Someone else's change reaches the office first: its broadcast isn't the answer to yours.
  store.apply({ t: 'todos', board: 'autonomous', items: [{ id: id(1), text: 'a', column: 'todo', at: 1 }, { id: id(3), text: 'theirs', column: 'todo', at: 2 }] });
  assert.deepEqual([text(2), text(3)], ['mine', 'theirs'], 'yours is still there, on top of theirs');
  // A quick follow-up of yours, before the office has answered the first.
  store.changeAutonomous({ action: 'edit', id: id(2), text: 'mine, reworded' });
  const office = [{ id: id(2), text: 'mine', column: 'urgent' as const, at: 3 }, { id: id(1), text: 'a', column: 'todo' as const, at: 1 }, { id: id(3), text: 'theirs', column: 'todo' as const, at: 2 }];
  store.apply({ t: 'todos', board: 'autonomous', items: office, mine: true });
  assert.equal(text(2), 'mine, reworded', 'the follow-up survives the answer to the first change');
  store.apply({ t: 'todos', board: 'autonomous', items: [{ ...office[0], text: 'mine, reworded' }, office[1], office[2]], mine: true });
  assert.deepEqual(store.autonomous.map((t) => t.text), ['mine, reworded', 'a', 'theirs']);
  // All answered: the office's copy is the one on screen.
  store.apply({ t: 'todos', board: 'autonomous', items: [office[1]] });
  assert.deepEqual(store.autonomous.map((t) => t.id), [id(1)]);
});
