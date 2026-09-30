import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContentKanban } from '../src/server/content-kanban.js';
import {
  applyContent,
  checkContentAction,
  checkContentItem,
  CONTENT_DUMP_MAX,
  CONTENT_LIMIT,
  CONTENT_STAGES,
  contentIn,
  hasContentKanban,
  piecesDone,
  type ContentAction,
  type ContentItem,
} from '../src/shared/content-kanban.js';

const id = (n: number) => `card${String(n).padStart(4, '0')}`;
const run = (...changes: ContentAction[]) => changes.reduce<readonly ContentItem[]>((items, a) => applyContent(items, a, 1000, 'Michael'), []);
const titles = (items: readonly ContentItem[], stage: ContentItem['stage']) => contentIn(items, stage).map((t) => t.title);

test('only the Autonomous-Dev-Projects floor has a Content Kanban', () => {
  assert.equal(hasContentKanban('autonomous-dev-projects'), true);
  assert.equal(hasContentKanban('agent-office'), false);
  assert.equal(hasContentKanban(null), false);
});

test('six stages, from an idea to published', () => {
  assert.deepEqual(Object.keys(CONTENT_STAGES), ['idea', 'script', 'create', 'edit', 'scheduled', 'published']);
});

test('a dump adds each idea to the top of Ideas, in order, with a checklist of the formats picked', () => {
  let items = run({ action: 'add', cards: [{ id: id(1), title: 'older idea' }], formats: [] });
  items = applyContent(items, { action: 'add', cards: [{ id: id(2), title: 'one' }, { id: id(3), title: 'two' }], formats: ['short', 'youtube'] }, 2000, 'Michael');
  assert.deepEqual(titles(items, 'idea'), ['one', 'two', 'older idea']);
  const one = items.find((t) => t.id === id(2))!;
  // In the formats' own order, none made yet.
  assert.deepEqual(one.pieces, [{ format: 'youtube' }, { format: 'short' }]);
  assert.equal(one.by, 'Michael');
  assert.equal(one.at, 2000);
  assert.deepEqual(piecesDone(one), { done: 0, total: 2 });
});

test('ticking the checklist stamps when, and unticking clears it', () => {
  let items = run({ action: 'add', cards: [{ id: id(1), title: 'video' }], formats: ['youtube', 'short'] });
  items = applyContent(items, { action: 'check', id: id(1), format: 'short', done: true }, 5000);
  assert.deepEqual(items[0].pieces, [{ format: 'youtube' }, { format: 'short', done: true, doneAt: 5000 }]);
  assert.deepEqual(piecesDone(items[0]), { done: 1, total: 2 });
  // Ticking what's already ticked, or a format it isn't being made into, changes nothing.
  assert.equal(applyContent(items, { action: 'check', id: id(1), format: 'short', done: true }), items);
  assert.equal(applyContent(items, { action: 'check', id: id(1), format: 'article', done: true }), items);
  items = applyContent(items, { action: 'check', id: id(1), format: 'short', done: false });
  assert.deepEqual(items[0].pieces, [{ format: 'youtube' }, { format: 'short' }]);
});

test('changing the formats keeps the boxes already ticked for the ones kept', () => {
  let items = run({ action: 'add', cards: [{ id: id(1), title: 'video' }], formats: ['youtube', 'short'] }, { action: 'check', id: id(1), format: 'youtube', done: true });
  items = applyContent(items, { action: 'formats', id: id(1), formats: ['thread', 'youtube'] });
  assert.deepEqual(items[0].pieces, [{ format: 'youtube', done: true, doneAt: 1000 }, { format: 'thread' }]);
  assert.equal(applyContent(items, { action: 'formats', id: id(1), formats: ['youtube', 'thread'] }), items);
});

test('moving a card along the pipeline, and publishing it stamps when', () => {
  let items = run(
    { action: 'add', cards: [{ id: id(1), title: 'a' }, { id: id(2), title: 'b' }], formats: [] },
  );
  items = applyContent(items, { action: 'move', id: id(2), stage: 'script' });
  items = applyContent(items, { action: 'move', id: id(1), stage: 'script', index: 1 });
  assert.deepEqual(titles(items, 'script'), ['b', 'a']);
  assert.deepEqual(titles(items, 'idea'), []);
  items = applyContent(items, { action: 'move', id: id(1), stage: 'published' }, 7000);
  assert.equal(items.find((t) => t.id === id(1))!.publishedAt, 7000);
  items = applyContent(items, { action: 'move', id: id(1), stage: 'edit' });
  assert.equal(items.find((t) => t.id === id(1))!.publishedAt, undefined);
});

test('editing the title, notes and day; empty clears the notes and the day', () => {
  let items = run({ action: 'add', cards: [{ id: id(1), title: 'idea' }], formats: [] });
  items = applyContent(items, { action: 'edit', id: id(1), title: 'better idea', notes: 'Hook: …\nOutline', due: '2026-10-03' });
  assert.equal(items[0].title, 'better idea');
  assert.equal(items[0].notes, 'Hook: …\nOutline');
  assert.equal(items[0].due, '2026-10-03');
  items = applyContent(items, { action: 'edit', id: id(1), notes: '', due: '' });
  assert.equal(items[0].notes, undefined);
  assert.equal(items[0].due, undefined);
  assert.equal(applyContent(items, { action: 'edit', id: id(1), title: 'better idea' }), items);
});

test('removing and putting back with Undo keeps the checklist', () => {
  let items = run(
    { action: 'add', cards: [{ id: id(1), title: 'a' }, { id: id(2), title: 'b' }], formats: ['article'] },
    { action: 'check', id: id(2), format: 'article', done: true },
  );
  const was = items[1];
  items = applyContent(items, { action: 'remove', id: id(2) });
  assert.deepEqual(titles(items, 'idea'), ['a']);
  items = applyContent(items, { action: 'restore', item: was, index: 1 });
  assert.deepEqual(titles(items, 'idea'), ['a', 'b']);
  assert.deepEqual(items[1], was);
  // A name that's taken isn't added twice.
  assert.equal(applyContent(items, { action: 'restore', item: was }), items);
  assert.equal(applyContent(items, { action: 'add', cards: [{ id: id(1), title: 'again' }], formats: [] }), items);
});

test('what a browser sends is checked', () => {
  assert.deepEqual(checkContentAction({ action: 'add', cards: [{ id: id(1), title: '  lots   of space ' }], formats: ['short', 'youtube'] }), { action: 'add', cards: [{ id: id(1), title: 'lots of space' }], formats: ['youtube', 'short'] });
  assert.equal(checkContentAction({ action: 'add', cards: [{ id: id(1), title: 'x' }], formats: ['myspace'] }), null);
  assert.equal(checkContentAction({ action: 'add', cards: [], formats: [] }), null);
  assert.equal(checkContentAction({ action: 'add', cards: Array.from({ length: CONTENT_DUMP_MAX + 1 }, (_, i) => ({ id: id(i), title: 'x' })), formats: [] }), null);
  assert.equal(checkContentAction({ action: 'add', cards: [{ id: id(1), title: 'x' }, { id: id(1), title: 'y' }], formats: [] }), null);
  assert.equal(checkContentAction({ action: 'add', cards: [{ id: 'BAD ID', title: 'x' }], formats: [] }), null);
  assert.equal(checkContentAction({ action: 'move', id: id(1), stage: 'viral' }), null);
  assert.equal(checkContentAction({ action: 'edit', id: id(1), due: '2026-02-30' }), null);
  assert.equal(checkContentAction({ action: 'edit', id: id(1) }), null);
  assert.deepEqual(checkContentAction({ action: 'edit', id: id(1), due: '' }), { action: 'edit', id: id(1), due: '' });
  assert.equal(checkContentAction({ action: 'check', id: id(1), format: 'youtube', done: 'yes' }), null);
  assert.equal(checkContentAction({ action: 'drop tables', id: id(1) }), null);
});

test('the board keeps at most its limit, letting the longest-published go first', () => {
  let items: readonly ContentItem[] = [];
  for (let i = 0; i < CONTENT_LIMIT; i++) items = applyContent(items, { action: 'add', cards: [{ id: id(i), title: `idea ${i}` }], formats: [] }, i);
  items = applyContent(items, { action: 'move', id: id(5), stage: 'published' }, 50_000);
  items = applyContent(items, { action: 'move', id: id(6), stage: 'published' }, 40_000);
  items = applyContent(items, { action: 'add', cards: [{ id: id(9999), title: 'one more' }], formats: [] }, 60_000);
  assert.equal(items.length, CONTENT_LIMIT);
  assert.ok(!items.some((t) => t.id === id(6)));
  assert.ok(items.some((t) => t.id === id(5)));
});

test('cards read back from disk are checked', () => {
  assert.equal(checkContentItem({ id: id(1), title: 'x', stage: 'nope', pieces: [], at: 1 }), null);
  assert.deepEqual(checkContentItem({ id: id(1), title: 'x', stage: 'idea', pieces: [{ format: 'tiktok', done: true, doneAt: 3 }, { format: 'fax' }, { format: 'youtube' }], at: 1, due: 'someday' }), {
    id: id(1),
    title: 'x',
    stage: 'idea',
    pieces: [{ format: 'youtube' }, { format: 'tiktok', done: true, doneAt: 3 }],
    at: 1,
  });
});

test('the office keeps a floor’s board in its content-kanban.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'content-kanban-'));
  try {
    const board = new ContentKanban(dir);
    assert.deepEqual(board.list(), []);
    const items = board.apply({ action: 'add', cards: [{ id: id(1), title: 'Why agents need offices' }], formats: ['youtube', 'short', 'thread'] }, 'Michael');
    assert.ok(items);
    assert.equal(board.apply({ action: 'remove', id: id(9) }), null);
    board.apply({ action: 'check', id: id(1), format: 'short', done: true });
    const again = new ContentKanban(dir);
    assert.deepEqual(again.list(), board.list());
    assert.equal(again.list()[0].by, 'Michael');
    const saved = JSON.parse(readFileSync(path.join(dir, 'content-kanban.json'), 'utf8'));
    assert.equal(saved[0].pieces.length, 3);
    // A broken file starts an empty board rather than stopping the floor.
    writeFileSync(path.join(dir, 'content-kanban.json'), '{nope');
    assert.deepEqual(new ContentKanban(dir).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
