import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Notes } from '../src/server/notes.js';
import {
  allLinks,
  applyNote,
  checkNoteAction,
  checkNotesState,
  EMPTY_NOTES,
  FOLDERS_LIMIT,
  isJustALink,
  linkLabel,
  linkNoteTitle,
  linksIn,
  NOTE_TEXT_MAX,
  notePreview,
  notesIn,
  noteTitle,
  TRASH_DAYS,
  type NoteAction,
  type NotesState,
} from '../src/shared/notes.js';

const id = (n: number) => `note${String(n).padStart(4, '0')}`;
const run = (state: NotesState, ...changes: [NoteAction, number?][]) => changes.reduce((s, [a, at]) => applyNote(s, a, at ?? 1000), state);
const titles = (s: NotesState, folder: string) => notesIn(s, folder).map((n) => noteTitle(n.text));
const DAY = 86_400_000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082', 'hex');
const dataURL = (b: Buffer, type = 'image/png') => `data:${type};base64,${b.toString('base64')}`;

test('notes are added, edited, pinned and listed newest first with pinned ones on top', () => {
  let s = run(
    EMPTY_NOTES,
    [{ action: 'add', id: id(1), folder: 'notes', text: 'Groceries\nmilk, eggs' }, 1000],
    [{ action: 'add', id: id(2), folder: 'notes', text: 'Ideas' }, 2000],
    [{ action: 'add', id: id(3), folder: 'notes', text: 'Old one' }, 500],
  );
  assert.deepEqual(titles(s, 'notes'), ['Ideas', 'Groceries', 'Old one']);
  s = run(s, [{ action: 'edit', id: id(3), text: 'Old one, changed' }, 3000]);
  assert.deepEqual(titles(s, 'notes'), ['Old one, changed', 'Ideas', 'Groceries']);
  s = run(s, [{ action: 'pin', id: id(1), pinned: true }, 4000]);
  assert.deepEqual(titles(s, 'notes'), ['Groceries', 'Old one, changed', 'Ideas']);
  assert.equal(notePreview(s.notes.find((n) => n.id === id(1))!.text), 'milk, eggs');
  // Changing nothing hands the same pad back.
  assert.equal(applyNote(s, { action: 'edit', id: id(2), text: 'Ideas' }), s);
  assert.equal(applyNote(s, { action: 'pin', id: id(1), pinned: true }), s);
  assert.equal(applyNote(s, { action: 'add', id: id(1), folder: 'notes', text: 'again' }), s, 'a name that’s taken');
  assert.equal(applyNote(s, { action: 'add', id: id(9), folder: 'nosuchfolder', text: 'x' }), s, 'a folder that isn’t there');
});

test('a note\'s title is its first line with something on it', () => {
  assert.equal(noteTitle('\n\n  Hello  \nworld'), 'Hello');
  assert.equal(noteTitle(''), '');
  assert.equal(notePreview('Title\n\nfirst\nsecond'), 'first second');
});

test('deleting goes to Recently deleted, from where it comes back or goes for good', () => {
  let s = run(
    EMPTY_NOTES,
    [{ action: 'add', id: id(1), folder: 'notes', text: 'Keep me' }, 1000],
    [{ action: 'add', id: id(2), folder: 'notes', text: 'Bin me' }, 2000],
    [{ action: 'pin', id: id(1), pinned: true }],
  );
  s = run(s, [{ action: 'delete', id: id(1) }, 5000]);
  assert.deepEqual(titles(s, 'notes'), ['Bin me']);
  assert.deepEqual(titles(s, 'trash'), ['Keep me']);
  assert.equal(s.notes.find((n) => n.id === id(1))!.pinned, undefined, 'unpinned on the way');
  assert.equal(applyNote(s, { action: 'edit', id: id(1), text: 'no' }), s, 'a deleted note can’t be changed');
  s = run(s, [{ action: 'restore', id: id(1) }]);
  assert.deepEqual(titles(s, 'notes'), ['Bin me', 'Keep me']);
  s = run(s, [{ action: 'delete', id: id(2) }], [{ action: 'delete', id: id(2) }]);
  assert.equal(s.notes.some((n) => n.id === id(2)), false, 'deleted again from Recently deleted: gone');
  s = run(s, [{ action: 'delete', id: id(1) }], [{ action: 'empty' }]);
  assert.deepEqual(s.notes, []);
});

test('a note left empty is gone for good when deleted, not kept in Recently deleted', () => {
  const s = run(EMPTY_NOTES, [{ action: 'add', id: id(1), folder: 'notes', text: '  \n ' }], [{ action: 'delete', id: id(1) }]);
  assert.deepEqual(s.notes, []);
});

test(`Recently deleted keeps notes for ${TRASH_DAYS} days`, () => {
  let s = run(EMPTY_NOTES, [{ action: 'add', id: id(1), folder: 'notes', text: 'old' }, 0], [{ action: 'delete', id: id(1) }, 0], [{ action: 'add', id: id(2), folder: 'notes', text: 'new' }, 1]);
  s = run(s, [{ action: 'add', id: id(3), folder: 'notes', text: 'later' }, TRASH_DAYS * DAY - 10]);
  assert.deepEqual(titles(s, 'trash'), ['old']);
  s = run(s, [{ action: 'edit', id: id(3), text: 'later still' }, TRASH_DAYS * DAY + 10]);
  assert.deepEqual(titles(s, 'trash'), []);
});

test('folders are made, renamed and removed, their notes going to Recently deleted', () => {
  let s = run(
    EMPTY_NOTES,
    [{ action: 'folder.add', id: 'recipes1', name: 'Recipes' }],
    [{ action: 'add', id: id(1), folder: 'recipes1', text: 'Pancakes' }],
    [{ action: 'add', id: id(2), folder: 'notes', text: 'Elsewhere' }],
  );
  assert.deepEqual(s.folders.map((f) => f.name), ['Recipes']);
  assert.deepEqual(titles(s, 'recipes1'), ['Pancakes']);
  s = run(s, [{ action: 'folder.rename', id: 'recipes1', name: 'Cooking' }]);
  assert.deepEqual(s.folders.map((f) => f.name), ['Cooking']);
  s = run(s, [{ action: 'move', id: id(2), folder: 'recipes1' }]);
  assert.deepEqual(titles(s, 'recipes1').sort(), ['Elsewhere', 'Pancakes']);
  s = run(s, [{ action: 'folder.remove', id: 'recipes1' }]);
  assert.deepEqual(s.folders, []);
  assert.deepEqual(titles(s, 'trash').sort(), ['Elsewhere', 'Pancakes']);
  // Its folder has gone, so it comes back to Notes.
  s = run(s, [{ action: 'restore', id: id(1) }]);
  assert.deepEqual(titles(s, 'notes'), ['Pancakes']);
  assert.equal(applyNote(s, { action: 'folder.add', id: 'notes', name: 'Mine' }), s, 'the built-in folders can’t be made again');
  let full = EMPTY_NOTES;
  for (let i = 0; i < FOLDERS_LIMIT; i++) full = applyNote(full, { action: 'folder.add', id: `folder${String(i).padStart(3, '0')}`, name: `F${i}` });
  assert.equal(applyNote(full, { action: 'folder.add', id: 'onetoomany', name: 'X' }), full);
});

test('links are found in text, tidied, and each comes once', () => {
  assert.deepEqual(linksIn('Watch https://youtu.be/abc123, and (see https://en.wikipedia.org/wiki/Foo_(bar)). Also www.example.com/x!'), [
    'https://youtu.be/abc123',
    'https://en.wikipedia.org/wiki/Foo_(bar)',
    'https://www.example.com/x',
  ]);
  assert.deepEqual(linksIn('https://a.com/x https://a.com/x'), ['https://a.com/x']);
  assert.deepEqual(linksIn('nothing here, not even http://localhost'), []);
  assert.equal(isJustALink('  https://www.youtube.com/watch?v=1  '), true);
  assert.equal(isJustALink('look https://x.com/a'), false);
  assert.equal(linkLabel('https://www.youtube.com/watch?v=abc'), 'youtube.com/watch?v=abc');
  assert.equal(linkNoteTitle('\nhttps://youtu.be/abc'), 'youtu.be/abc');
  assert.equal(linkNoteTitle('Great talk\nhttps://youtu.be/abc'), 'Great talk');
  assert.equal(linkNoteTitle('Great talk: https://youtu.be/abc'), 'Great talk');
  assert.equal(linkNoteTitle('https://youtu.be/abc\n\nwatch at lunch'), 'watch at lunch');
});

test('every link goes to Links to watch: the ones added there, then the ones in other notes', () => {
  let s = run(
    EMPTY_NOTES,
    [{ action: 'add', id: id(1), folder: 'links', text: '\nhttps://youtu.be/one' }, 1000],
    [{ action: 'add', id: id(2), folder: 'links', text: 'Second video\nhttps://youtu.be/two' }, 2000],
    [{ action: 'add', id: id(3), folder: 'notes', text: 'Trip\nhotel https://hotel.example.com and https://youtu.be/one again' }, 3000],
    [{ action: 'add', id: id(4), folder: 'notes', text: 'Deleted https://gone.example.com' }, 4000],
    [{ action: 'delete', id: id(4) }, 5000],
  );
  const links = allLinks(s);
  assert.deepEqual(links.map((l) => [l.url, l.title, l.saved, l.noteId]), [
    ['https://youtu.be/two', 'Second video', true, id(2)],
    ['https://youtu.be/one', 'youtu.be/one', true, id(1)],
    ['https://hotel.example.com', 'hotel.example.com', false, id(3)],
  ]);
  s = run(s, [{ action: 'watched', url: 'https://hotel.example.com', watched: true }]);
  assert.deepEqual(allLinks(s).filter((l) => l.watched).map((l) => l.url), ['https://hotel.example.com']);
  assert.equal(applyNote(s, { action: 'watched', url: 'https://hotel.example.com', watched: true }), s);
  s = run(s, [{ action: 'watched', url: 'https://hotel.example.com', watched: false }]);
  assert.deepEqual(s.watched, []);
});

test('changes from a browser are checked', () => {
  assert.deepEqual(checkNoteAction({ action: 'add', id: id(1), folder: 'notes', text: 'a\r\nb', images: ['0123456789abcdef0123456789abcdef.png'] }), {
    action: 'add', id: id(1), folder: 'notes', text: 'a\nb', images: ['0123456789abcdef0123456789abcdef.png'],
  });
  assert.deepEqual(checkNoteAction({ action: 'edit', id: id(1), images: [] }), { action: 'edit', id: id(1), images: [] });
  assert.deepEqual(checkNoteAction({ action: 'empty' }), { action: 'empty' });
  assert.deepEqual(checkNoteAction({ action: 'folder.add', id: 'folder1', name: '  My   stuff ' }), { action: 'folder.add', id: 'folder1', name: 'My stuff' });
  for (const bad of [
    null,
    { action: 'add', id: 'NO!', folder: 'notes', text: '' },
    { action: 'add', id: id(1), folder: '../x', text: '' },
    { action: 'add', id: id(1), folder: 'notes', text: 'x'.repeat(NOTE_TEXT_MAX + 1) },
    { action: 'add', id: id(1), folder: 'notes', text: '', images: ['../../etc/passwd'] },
    { action: 'add', id: id(1), folder: 'notes', text: '', images: ['0123456789abcdef0123456789abcdef.svg'] },
    { action: 'edit', id: id(1) },
    { action: 'pin', id: id(1), pinned: 'yes' },
    { action: 'watched', url: 'javascript:alert(1)', watched: true },
    { action: 'folder.add', id: 'folder1', name: '   ' },
    { action: 'folder.add', id: 'folder1', name: 'x'.repeat(41) },
    { action: 'launch', id: id(1) },
  ]) assert.equal(checkNoteAction(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test('a pad read back from disk keeps what holds up', () => {
  const s = checkNotesState({
    folders: [{ id: 'folder1', name: 'Mine', at: 1 }, { id: 'notes', name: 'clash', at: 1 }, { id: 'bad id', name: 'x', at: 1 }],
    notes: [
      { id: id(1), folder: 'folder1', text: 'ok', images: [], at: 1, editedAt: 2 },
      { id: id(2), folder: 'gonefolder', text: 'orphan', images: [], at: 1 },
      { id: id(1), folder: 'notes', text: 'duplicate', images: [], at: 1 },
      { id: id(3), folder: 'notes', text: 42, images: [], at: 1 },
      { id: id(4), folder: 'notes', text: 'binned', images: [], at: 1, deletedAt: 5, pinned: true },
    ],
    watched: ['https://a.example.com', 'https://a.example.com', 'ftp://nope'],
  });
  assert.deepEqual(s.folders, [{ id: 'folder1', name: 'Mine', at: 1 }]);
  assert.deepEqual(s.notes.map((n) => [n.id, n.folder, n.text]), [[id(1), 'folder1', 'ok'], [id(2), 'notes', 'orphan'], [id(4), 'notes', 'binned']]);
  assert.equal(s.notes[1].editedAt, 1);
  assert.equal(s.notes[2].deletedAt, 5);
  assert.deepEqual(s.watched, ['https://a.example.com']);
  assert.deepEqual(checkNotesState('nonsense'), EMPTY_NOTES);
});

test('the office keeps each person’s pad and pictures apart, and across a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-notes-'));
  try {
    const notes = new Notes(dir);
    assert.ok(notes.apply('shared', { action: 'add', id: id(1), folder: 'notes', text: 'Shared note' }));
    assert.ok(notes.apply('account:a1', { action: 'add', id: id(2), folder: 'links', text: 'https://youtu.be/x' }));
    assert.equal(notes.apply('shared', { action: 'edit', id: id(9), text: 'nobody' }), null, 'a change that does nothing');

    const pic = notes.addImage('shared', { dataURL: dataURL(PNG) });
    assert.ok('id' in pic, JSON.stringify(pic));
    assert.match(pic.id, /^[a-f0-9]{32}\.png$/);
    assert.deepEqual(notes.addImage('shared', { dataURL: dataURL(PNG) }), pic, 'the same picture keeps its name');
    assert.ok(notes.imagePath('shared', pic.id));
    assert.equal(notes.imagePath('account:a1', pic.id), null, 'someone else’s picture');
    assert.equal(notes.imagePath('shared', '../notes.json'), null);
    assert.ok('error' in notes.addImage('shared', { dataURL: dataURL(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml') }));
    assert.ok('error' in notes.addImage('shared', { dataURL: 'data:text/plain,hello' }));
    assert.ok('error' in notes.addImage('shared', {}));
    notes.apply('shared', { action: 'edit', id: id(1), images: [pic.id] });

    const again = new Notes(dir);
    assert.deepEqual(again.pad('shared').notes.map((n) => [n.text, n.images]), [['Shared note', [pic.id]]]);
    assert.deepEqual(again.pad('account:a1').notes.map((n) => n.folder), ['links']);
    assert.deepEqual(again.pad('account:nobody'), EMPTY_NOTES);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(dir, 'notes.json'), 'utf8')));

    // Gone for good, a note's pictures go with it (once they're not brand new).
    const file = again.imagePath('shared', pic.id)!;
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, old, old);
    again.apply('shared', { action: 'delete', id: id(1) });
    assert.ok(existsSync(file), 'still in Recently deleted');
    again.apply('shared', { action: 'empty' });
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a picture nothing uses is cleared away at start-up once it’s old', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-notes-'));
  try {
    const notes = new Notes(dir);
    notes.apply('shared', { action: 'add', id: id(1), folder: 'notes', text: 'x' });
    const pic = notes.addImage('shared', { dataURL: dataURL(PNG) });
    assert.ok('id' in pic);
    const file = notes.imagePath('shared', pic.id)!;
    new Notes(dir);
    assert.ok(existsSync(file), 'just added: it may be on its way into a note');
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(file, old, old);
    new Notes(dir);
    assert.equal(existsSync(file), false);
    assert.deepEqual(readdirSync(path.dirname(file)), []);
    // A broken file starts an empty pad rather than failing.
    writeFileSync(path.join(dir, 'notes.json'), '{broken');
    assert.deepEqual(new Notes(dir).pad('shared'), EMPTY_NOTES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
