import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Stickies } from '../src/server/stickies.js';
import { applySticky, checkStickyAction, checkStickyItem, clampSticky, nextStickySpot, presetStickies, STICKY_LIMIT, STICKY_PRESETS, STICKY_TEXT_MAX, STICKY_ZONE, type StickyAction, type StickyNote } from '../src/shared/stickies.js';

const id = (n: number) => `note${String(n).padStart(4, '0')}`;
const run = (...changes: StickyAction[]) => changes.reduce<readonly StickyNote[]>((items, a) => applySticky(items, a, 1000), []);

test('four reminders start above the To Do board', () => {
  const items = presetStickies(50);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((s) => s.text), [
    'POST 4-5 TIMES A DAY (remember camillla arajuo)',
    'DAILY RECAP VID (see paper cluluoud)',
    'Make the viral short',
    'Show futures traders desk. Sierra chart.',
  ]);
  assert.deepEqual(items.map((s) => s.color), ['yellow', 'pink', 'blue', 'green']);
  for (const s of items) {
    assert.equal(s.hidden, false);
    assert.ok(s.u > STICKY_ZONE.u0 && s.u < STICKY_ZONE.u1);
    assert.ok(s.y > STICKY_ZONE.y0 && s.y < STICKY_ZONE.y1);
  }
  assert.deepEqual(STICKY_PRESETS.map((s) => s.id), ['post45times', 'dailyrecap1', 'viralshort1', 'sierradesk1']);
});

test('edit, recolor, resize, move, hide and remove', () => {
  let items = presetStickies(50);
  items = applySticky(items, { action: 'edit', id: 'post45times', text: 'Post twice' });
  assert.equal(items[0].text, 'Post twice');
  items = applySticky(items, { action: 'color', id: 'post45times', color: 'orange' });
  assert.equal(items[0].color, 'orange');
  items = applySticky(items, { action: 'resize', id: 'post45times', w: 0.8, h: 0.6 });
  assert.equal(items[0].w, 0.8);
  assert.equal(items[0].h, 0.6);
  const moved = applySticky(items, { action: 'move', id: 'dailyrecap1', u: -15, y: 5.5 });
  assert.equal(moved.find((s) => s.id === 'dailyrecap1')?.u, -15);
  items = applySticky(items, { action: 'hide', id: 'viralshort1', hidden: true });
  assert.equal(items.find((s) => s.id === 'viralshort1')?.hidden, true);
  assert.equal(items.length, 4, 'hiding keeps the note');
  items = applySticky(items, { action: 'hide', id: 'viralshort1', hidden: false });
  assert.equal(items.find((s) => s.id === 'viralshort1')?.hidden, false);
  items = applySticky(items, { action: 'remove', id: 'sierradesk1' });
  assert.equal(items.find((s) => s.id === 'sierradesk1'), undefined);
  assert.equal(items.length, 3);
});

test('a change that changes nothing gives back the same list', () => {
  const items = presetStickies(50);
  assert.equal(applySticky(items, { action: 'edit', id: 'post45times', text: items[0].text }), items);
  assert.equal(applySticky(items, { action: 'color', id: 'post45times', color: 'yellow' }), items);
  assert.equal(applySticky(items, { action: 'hide', id: 'missing1', hidden: true }), items);
  assert.equal(applySticky(items, { action: 'remove', id: 'missing1' }), items);
  assert.equal(applySticky(items, { action: 'add', id: 'post45times', text: 'again', color: 'pink', u: -12, y: 5.2, w: 1, h: 0.8 }), items);
});

test('notes stay in the strip above the board, and new ones avoid the ones already up', () => {
  const pulled = clampSticky(-30, 0, 1.2, 1);
  assert.ok(pulled.u >= STICKY_ZONE.u0);
  assert.ok(pulled.y >= STICKY_ZONE.y0);
  const items = presetStickies(50);
  const spot = nextStickySpot(items);
  assert.ok(items.filter((s) => !s.hidden).every((s) => Math.abs(s.u - spot.u) > 0.3 || Math.abs(s.y - spot.y) > 0.3));
  const added = applySticky(items, { action: 'add', id: id(1), text: 'call mum', color: 'purple', u: 40, y: 0, w: 9, h: 9 }, 80);
  const note = added.find((s) => s.id === id(1))!;
  assert.ok(note.w <= 1.7 && note.h <= 1.35);
  assert.ok(note.u >= STICKY_ZONE.u0 && note.u <= STICKY_ZONE.u1);
  assert.equal(note.text, 'call mum');
});

test('a browser change is checked, and junk is refused', () => {
  assert.equal(checkStickyAction({ action: 'edit', id: 'post45times', text: '  keep\n  going  ' })?.text, 'keep\ngoing');
  assert.equal(checkStickyAction({ action: 'edit', id: 'post45times', text: '   ' }), null);
  assert.equal(checkStickyAction({ action: 'edit', id: 'post45times', text: 'x'.repeat(STICKY_TEXT_MAX + 1) }), null);
  assert.equal(checkStickyAction({ action: 'color', id: 'Bad Id!', color: 'pink' }), null);
  assert.equal(checkStickyAction({ action: 'color', id: 'post45times', color: 'plaid' }), null);
  assert.equal(checkStickyAction({ action: 'hide', id: 'post45times', hidden: 'yes' }), null);
  assert.equal(checkStickyAction(null), null);
  const resized = checkStickyAction({ action: 'resize', id: 'post45times', w: 0.2, h: 4 });
  assert.equal(resized && resized.action === 'resize' && resized.w, 0.55);
  assert.equal(resized && resized.action === 'resize' && resized.h, 1.35);
});

test('a saved note is read back, and a broken one is not', () => {
  const ok = checkStickyItem({ id: 'post45times', text: 'hi', color: 'blue', u: -12, y: 5.2, w: 1, h: 0.8, at: 3 });
  assert.equal(ok?.hidden, false);
  assert.equal(ok?.color, 'blue');
  assert.equal(checkStickyItem({ id: 'post45times', text: 'hi', color: 'nope', u: -12, y: 5.2, w: 1, h: 0.8, at: 3 }), null);
  assert.equal(checkStickyItem({ id: 'x', text: 'hi', color: 'blue', u: -12, y: 5.2, w: 1, h: 0.8, at: 3 }), null);
});

test('the office seeds the four notes once, and an emptied list stays empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stickies-'));
  try {
    const first = new Stickies(dir);
    const seeded = first.list('account:ada');
    assert.equal(seeded.length, 4);
    assert.equal(seeded[2].text, 'Make the viral short');
    const edited = first.apply('account:ada', { action: 'hide', id: 'viralshort1', hidden: true });
    assert.equal(edited?.find((s) => s.id === 'viralshort1')?.hidden, true);
    first.apply('account:ada', { action: 'remove', id: 'post45times' });
    first.apply('account:ada', { action: 'remove', id: 'dailyrecap1' });
    first.apply('account:ada', { action: 'remove', id: 'viralshort1' });
    first.apply('account:ada', { action: 'remove', id: 'sierradesk1' });
    assert.deepEqual(first.list('account:ada'), []);
    const again = new Stickies(dir);
    assert.deepEqual(again.list('account:ada'), [], 'taking them all down is remembered');
    assert.equal(again.list('shared').length, 4, 'someone else still gets the reminders');
    const saved = JSON.parse(readFileSync(path.join(dir, 'stickies.json'), 'utf8')) as Record<string, unknown[]>;
    assert.deepEqual(saved['account:ada'], []);
    assert.equal(saved.shared.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('past the limit, a hidden note goes before one still on the wall', () => {
  let items: readonly StickyNote[] = [];
  for (let i = 0; i < STICKY_LIMIT; i++) {
    items = applySticky(items, { action: 'add', id: id(i), text: `n${i}`, color: 'yellow', u: -12, y: 5.2, w: 0.7, h: 0.5 }, i);
  }
  items = applySticky(items, { action: 'hide', id: id(0), hidden: true }, 10);
  items = applySticky(items, { action: 'add', id: id(99), text: 'one more', color: 'pink', u: -12, y: 5.2, w: 0.7, h: 0.5 }, 200);
  assert.equal(items.length, STICKY_LIMIT);
  assert.equal(items.find((s) => s.id === id(0)), undefined);
  assert.equal(items.find((s) => s.id === id(99))?.text, 'one more');
});
