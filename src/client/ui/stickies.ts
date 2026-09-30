import './stickies.css';
import { applySticky, newStickyId, nextStickySpot, STICKY_COLORS, STICKY_H_MAX, STICKY_H_MIN, STICKY_NUDGE, STICKY_TEXT_MAX, STICKY_W_MAX, STICKY_W_MIN, type StickyAction, type StickyColor, type StickyNote } from '../../shared/stickies';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from './dom';

/** Makes a change to your reminder stickies: on the wall straight away, and on to the office. */
export function changeSticky(net: Net, change: StickyAction) {
  const next = applySticky(store.stickies, change);
  if (next === store.stickies) return;
  store.stickies = next;
  store.stickiesPending++;
  store.emit('stickies');
  net.send({ t: 'sticky', change });
}

const COLORS = Object.keys(STICKY_COLORS) as StickyColor[];
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const tidy = (raw: string) => raw.replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();

function swatches(current: StickyColor, pick: (color: StickyColor) => void): HTMLElement {
  return h('div.sticky-colors', { role: 'group', 'aria-label': 'Color' }, ...COLORS.map((color) => {
    const b = h('button.sticky-swatch', {
      type: 'button',
      title: color,
      'aria-label': color,
      'aria-pressed': color === current,
      style: `background:${STICKY_COLORS[color].paper}`,
    });
    b.addEventListener('click', () => pick(color));
    return b;
  }));
}

/** Point at a note and press E: change what it says, its color and size, nudge it, hide it, or take it down. */
export function openSticky(net: Net, id: string) {
  const note = store.stickies.find((s) => s.id === id);
  if (!note) return;
  const change = (a: StickyAction) => changeSticky(net, a);
  const area = h('textarea', { maxlength: STICKY_TEXT_MAX, 'aria-label': 'Reminder' });
  area.value = note.text;
  let color: StickyColor = note.color;
  let w = note.w;
  let hgt = note.h;
  const colors = swatches(color, (c) => {
    color = c;
    change({ action: 'color', id, color: c });
    colors.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('aria-label') === c ? 'true' : 'false'));
  });
  const width = h('input', { type: 'range', min: STICKY_W_MIN, max: STICKY_W_MAX, step: '0.05', value: String(w), 'aria-label': 'Width' });
  const height = h('input', { type: 'range', min: STICKY_H_MIN, max: STICKY_H_MAX, step: '0.05', value: String(hgt), 'aria-label': 'Height' });
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  const queueSize = () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => change({ action: 'resize', id, w, h: hgt }), 160);
  };
  width.addEventListener('input', () => {
    w = Number(width.value);
    queueSize();
  });
  height.addEventListener('input', () => {
    hgt = Number(height.value);
    queueSize();
  });
  const flushSize = () => {
    clearTimeout(sizeTimer);
    change({ action: 'resize', id, w, h: hgt });
  };
  width.addEventListener('change', flushSize);
  height.addEventListener('change', flushSize);
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  const flushText = () => {
    clearTimeout(textTimer);
    const text = tidy(area.value);
    if (text) change({ action: 'edit', id, text: text.slice(0, STICKY_TEXT_MAX) });
  };
  area.addEventListener('input', () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 400);
  });
  area.addEventListener('blur', flushText);
  const nudge = (du: number, dy: number) => {
    const cur = store.stickies.find((s) => s.id === id);
    if (!cur) return;
    change({ action: 'move', id, u: cur.u + du, y: cur.y + dy });
  };
  const hide = h('button.btn', { type: 'button' }, 'Hide for now');
  const remove = h('button.btn.danger', { type: 'button' }, 'Take it down');
  const el = h('div.modal.sticky-editor', { role: 'dialog', 'aria-label': 'Sticky note' },
    h('header', {}, h('h2', {}, '📝 Sticky note')),
    h('div.body', {},
      area,
      colors,
      h('div.sticky-sizes', {},
        h('label', {}, 'Width', width),
        h('label', {}, 'Height', height),
      ),
      h('div.sticky-nudge', {},
        h('span', {}, 'Move'),
        ...([
          ['←', -STICKY_NUDGE, 0],
          ['→', STICKY_NUDGE, 0],
          ['↑', 0, STICKY_NUDGE],
          ['↓', 0, -STICKY_NUDGE],
        ] as const).map(([label, du, dy]) => {
          const b = h('button.btn', { type: 'button', 'aria-label': `Move ${label}` }, label);
          b.addEventListener('click', () => nudge(du, dy));
          return b;
        }),
      ),
      h('p.hint', {}, 'Hidden notes stay saved. The + on the wall brings them back.'),
    ),
    h('footer', {}, hide, h('span.grow'), remove),
  );
  const modal = openModal(el, { doing: '📝 editing a sticky', onClose: () => { flushText(); flushSize(); } });
  hide.addEventListener('click', () => {
    change({ action: 'hide', id, hidden: true });
    toast('Hidden. Point at the + by the notes to show it again.');
    modal.close();
  });
  remove.addEventListener('click', () => {
    change({ action: 'remove', id });
    modal.close();
  });
  // After the E that opened it, which would otherwise land at the end of the note.
  setTimeout(() => {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, 30);
}

/** The + on the wall: write a new reminder, or show one you hid. */
export function openNewSticky(net: Net) {
  const area = h('textarea', { maxlength: STICKY_TEXT_MAX, placeholder: 'A reminder…', 'aria-label': 'New sticky' });
  let color: StickyColor = 'yellow';
  const colors = swatches(color, (c) => {
    color = c;
    colors.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.getAttribute('aria-label') === c ? 'true' : 'false'));
  });
  const hidden = h('ul.sticky-hidden');
  const fillHidden = () => {
    hidden.replaceChildren();
    for (const note of store.stickies) {
      if (!note.hidden) continue;
      const show = h('button.btn', { type: 'button' }, 'Show');
      show.addEventListener('click', () => {
        changeSticky(net, { action: 'hide', id: note.id, hidden: false });
        fillHidden();
      });
      hidden.append(h('li', {}, h('span', { title: note.text }, clip(note.text.replace(/\s+/g, ' '), 48)), show));
    }
  };
  fillHidden();
  const add = h('button.btn.primary', { type: 'button' }, 'Stick it up');
  const el = h('div.modal.sticky-editor', { role: 'dialog', 'aria-label': 'New sticky note' },
    h('header', {}, h('h2', {}, '📝 New sticky')),
    h('div.body', {},
      area,
      colors,
      h('p.hint', {}, 'It goes up by the To Do board, on every floor. Point at it to edit, resize, or hide it.'),
      h('label', {}, 'Hidden'),
      hidden,
    ),
    h('footer', {}, h('span.grow'), add),
  );
  const off = store.on('stickies', fillHidden);
  const modal = openModal(el, { doing: '📝 writing a sticky', onClose: () => off() });
  const submit = () => {
    const text = tidy(area.value);
    if (!text) return;
    const spot = nextStickySpot(store.stickies);
    changeSticky(net, { action: 'add', id: newStickyId(), text: text.slice(0, STICKY_TEXT_MAX), color, ...spot, w: 1.05, h: 0.82 });
    modal.close();
  };
  add.addEventListener('click', submit);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });
  // After the E that opened it, so the new note doesn't start with an "e".
  setTimeout(() => area.focus(), 30);
}
