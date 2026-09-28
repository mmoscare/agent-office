import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardAction, type ClipboardKey } from '../src/client/ui/terminal-clipboard.js';

const key = (key: string, more: Partial<ClipboardKey> = {}): ClipboardKey => ({
  type: 'keydown',
  key,
  code: `Key${key.toUpperCase()}`,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...more,
});

test('Ctrl+C copies a selection and interrupts without one', () => {
  assert.equal(clipboardAction(key('c'), true, false), 'copy');
  assert.equal(clipboardAction(key('c'), false, false), null);
});

test('Ctrl+Shift+C always copies', () => {
  assert.equal(clipboardAction(key('C', { shiftKey: true }), false, false), 'copy');
});

test('Ctrl+V and Ctrl+Shift+V paste', () => {
  assert.equal(clipboardAction(key('v'), false, false), 'paste');
  assert.equal(clipboardAction(key('V', { shiftKey: true }), true, false), 'paste');
});

test('other keys, key releases and plain letters are left to the terminal', () => {
  assert.equal(clipboardAction(key('x'), true, false), null);
  assert.equal(clipboardAction(key('c', { type: 'keyup' }), true, false), null);
  assert.equal(clipboardAction(key('v', { ctrlKey: false }), true, false), null);
  assert.equal(clipboardAction(key('v', { altKey: true }), true, false), null);
});

test('on a Mac, Ctrl stays with the program (⌘C/⌘V already copy and paste)', () => {
  assert.equal(clipboardAction(key('c'), true, true), null);
  assert.equal(clipboardAction(key('v'), false, true), null);
});

test('a non-Latin layout uses the key where C or V would be', () => {
  assert.equal(clipboardAction(key('с', { code: 'KeyC' }), true, false), 'copy');
  assert.equal(clipboardAction(key('м', { code: 'KeyV' }), false, false), 'paste');
});

test('a Latin layout goes by the letter typed, not where the key sits', () => {
  // Dvorak: the key in QWERTY's V spot types K, which is not paste; V is on the period key.
  assert.equal(clipboardAction(key('k', { code: 'KeyV' }), false, false), null);
  assert.equal(clipboardAction(key('v', { code: 'Period' }), false, false), 'paste');
});
