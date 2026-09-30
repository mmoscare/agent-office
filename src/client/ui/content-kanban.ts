import './content-kanban.css';
import { cardDetails, onTodoDetails, setTodoDetailsShown, todoDetailsShown } from './todo-details';
import {
  CONTENT_DUMP_MAX,
  CONTENT_FORMATS,
  CONTENT_NOTES_MAX,
  CONTENT_STAGES,
  CONTENT_TITLE_MAX,
  contentIn,
  FORMAT_ICON,
  FORMAT_ORDER,
  newContentId,
  piecesDone,
  STAGE_ICON,
  STAGE_ORDER,
  type ContentAction,
  type ContentFormat,
  type ContentItem,
  type ContentStage,
} from '../../shared/content-kanban';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, toast, type Modal } from './dom';

// The 🎬 Content Kanban (see shared/content-kanban.ts): on its floor, the whiteboard's stand is a
// content pipeline. Dump ideas in (one per line), toggle what you'll make of them (a YouTube video,
// a Short, an article, an X thread…), and each card keeps those as a checklist to tick off while it
// moves from 💡 Ideas through Scripting, Creating, Editing and Scheduled to 🚀 Published.

/** Makes a change to the floor's Content Kanban: on screen straight away, and on to the office, whose copy wins once it answers (see state.ts). */
export function changeContent(net: Net, change: ContentAction) {
  if (store.changeContent(change)) net.send({ t: 'content', change });
}

/** What each stage is for, under its name. */
const STAGE_HINT: Record<ContentStage, string> = {
  idea: 'The dump: every idea lands here',
  script: 'Hook, outline and script',
  create: 'Filming, recording, writing',
  edit: 'Cutting, polishing, thumbnails',
  scheduled: 'Ready, with a day to go out',
  published: 'Out in the world 🎉',
};
const EMPTY: Record<ContentStage, string> = {
  idea: 'Dump your ideas in the box above.',
  script: 'Pick an idea and start its hook and outline.',
  create: 'Nothing being made right now.',
  edit: 'Nothing in the edit.',
  scheduled: 'Nothing scheduled. Give a card a day to go out.',
  published: 'Published pieces land here.',
};
/** The button that moves a card on to the next stage. */
const NEXT_LABEL: Record<ContentStage, string> = {
  idea: '✍️ Script it',
  script: '🎥 Create',
  create: '✂️ Edit',
  edit: '📅 Schedule',
  scheduled: '🚀 Published',
  published: '',
};

// ---- Days ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (due: string) => {
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysUntil = (due: string, now: Date) => Math.round((dayOf(due).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY_MS);

/** Whether a card's day to go out has passed ('late'), is within two days ('soon'), or isn't close yet. */
export function dueState(due: string, now = new Date()): 'late' | 'soon' | 'ok' {
  const days = daysUntil(due, now);
  return days < 0 ? 'late' : days <= 2 ? 'soon' : 'ok';
}

/** A card's day to go out, the way you'd say it: Today, Tomorrow, or Fri, Oct 3. */
export function dueLabel(due: string, now = new Date()): string {
  const days = daysUntil(due, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return dayOf(due).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(Math.abs(days) > 300 ? { year: 'numeric' } : {}) });
}

// ---- The window -----------------------------------------------------------------------------------

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // just not remembered
  }
};
const FILTER_KEY = 'agent-office.content.filter';

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The ideas in a dump: one per line, without the bullets or numbers a pasted list comes with. */
export function dumpedIdeas(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => clean(line.replace(/^\s*(?:[-*•–+]|\d+[.)]|\[[ xX]?\])\s+/, '')))
    .filter(Boolean)
    .map((line) => line.slice(0, CONTENT_TITLE_MAX));
}

/** A row of format toggles; `picked` is changed in place as they're pressed. */
function formatToggles(picked: Set<ContentFormat>, label: string, onChange?: () => void): HTMLElement {
  const row = h('div.ck-formats', { role: 'group', 'aria-label': label });
  for (const format of FORMAT_ORDER) {
    const b = h('button.ck-format', { type: 'button', 'data-format': format, 'aria-pressed': String(picked.has(format)), title: CONTENT_FORMATS[format] }, h('span.ck-icon', {}, FORMAT_ICON[format]), CONTENT_FORMATS[format]);
    b.addEventListener('click', () => {
      if (picked.has(format)) picked.delete(format);
      else picked.add(format);
      b.setAttribute('aria-pressed', String(picked.has(format)));
      onChange?.();
    });
    row.append(b);
  }
  return row;
}

let modal: Modal | undefined;

/** Opens the floor's 🎬 Content Kanban. */
export function openContentKanban(net: Net) {
  if (modal) return;
  if (!store.content) return toast('This floor has the whiteboard, not a Content Kanban', 'warn');
  const floor = store.floor;
  const info = store.currentFloor();
  /** Formats the next dump's ideas get. */
  const picked = new Set<ContentFormat>();
  /** Only cards with this format on their checklist show, when it's set. */
  let filter: ContentFormat | null = FORMAT_ORDER.find((f) => f === read(FILTER_KEY)) ?? null;
  /** The card being edited, and what's in its boxes so far. */
  let editing: { id: string; title: string; notes: string; due: string; formats: Set<ContentFormat> } | undefined;
  let dragging: string | undefined;
  /** What the last ✕ took off, to put back with Undo. */
  let removed: { item: ContentItem; index: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const change = (a: ContentAction) => changeContent(net, a);
  const items = () => store.content ?? [];
  const find = (id: string) => items().find((t) => t.id === id);
  const indexOf = (item: ContentItem) => contentIn(items(), item.stage).indexOf(item);

  // The dump: a big box for ideas, and toggles for what you'll make of them.
  const dump = h('textarea.ck-dump-text', { rows: 4, placeholder: 'Dump your content ideas here, one per line…\nCtrl+Enter drops them in 💡 Ideas with a checklist of what you picked below.', 'aria-label': 'Content ideas, one per line' });
  const addButton = h('button.btn.primary.ck-dump-add', { type: 'submit' }, 'Add to 💡 Ideas');
  const dumpNote = h('span.ck-dump-note', { 'aria-live': 'polite' });
  const paintDump = () => {
    const n = dumpedIdeas(dump.value).length;
    addButton.textContent = n > 1 ? `Add ${Math.min(n, CONTENT_DUMP_MAX)} ideas to 💡 Ideas` : 'Add to 💡 Ideas';
    addButton.disabled = !n;
    const what = [...picked].map((f) => `${FORMAT_ICON[f]} ${CONTENT_FORMATS[f]}`).join(' · ');
    dumpNote.textContent = what ? `Checklist: ${what}` : 'Pick what you’ll make — or leave it for later';
  };
  const toggles = formatToggles(picked, 'I’ll make it into', paintDump);
  const form = h(
    'form.ck-dump',
    {},
    dump,
    h('div.ck-dump-side', {}, h('div.ck-dump-label', {}, 'I’ll make it into:'), toggles, h('div.ck-dump-go', {}, dumpNote, addButton)),
  );
  const submit = () => {
    const ideas = dumpedIdeas(dump.value);
    if (!ideas.length) return dump.focus();
    const taking = ideas.slice(0, CONTENT_DUMP_MAX);
    change({ action: 'add', cards: taking.map((title) => ({ id: newContentId(), title })), formats: FORMAT_ORDER.filter((f) => picked.has(f)), stage: 'idea', index: 0 });
    // More than one dump takes: the rest stay in the box for the next.
    dump.value = ideas.slice(CONTENT_DUMP_MAX).join('\n');
    if (ideas.length > CONTENT_DUMP_MAX) toast(`Added ${CONTENT_DUMP_MAX}; the other ${ideas.length - CONTENT_DUMP_MAX} are still in the box`, 'warn');
    picked.clear();
    toggles.querySelectorAll('[aria-pressed]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    paintDump();
    dump.focus();
  };
  form.addEventListener('submit', (e) => (e.preventDefault(), submit()));
  dump.addEventListener('input', paintDump);
  dump.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  const summary = h('div.ck-summary', { 'aria-live': 'polite' });
  const filters = h('div.ck-filter', { role: 'group', 'aria-label': 'Show only' });
  const undo = h('div.ck-undo', { role: 'status', 'aria-live': 'polite' });
  const cols = h('div.ck-cols');
  const body = h('div.body.ck-body', {}, form, h('div.ck-bar', {}, summary, undo), filters, cols);
  const el = h(
    'div.modal.board.ck-modal',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Content Kanban' },
    h('header', {}, h('h2', {}, '🎬 Content Kanban'), info ? h('span.ck-floor', {}, info.name) : null),
    body,
  );
  // Double-click the board around the cards to show every card's subtasks and pictures (ui/todo-details.ts), and again to put them away.
  const revealHint = h('span.todo-reveal-hint');
  body.querySelector('.ck-bar')?.append(revealHint);
  body.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.ck-card, input, textarea, button, a, label, select, form')) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    setTodoDetailsShown('content', !todoDetailsShown('content'));
  });

  const showUndo = () => {
    if (!removed) return undo.replaceChildren();
    const title = removed.item.title.length > 40 ? `${removed.item.title.slice(0, 39)}…` : removed.item.title;
    undo.replaceChildren(
      h('span', {}, `Removed “${title}”`),
      h('button.btn.ck-mini', { type: 'button', onclick: () => {
        if (!removed) return;
        const { item, index, timer } = removed;
        clearTimeout(timer);
        removed = undefined;
        change({ action: 'restore', item, index });
        showUndo();
      } }, 'Undo'),
    );
  };
  const remove = (item: ContentItem) => {
    if (removed) clearTimeout(removed.timer);
    removed = { item, index: indexOf(item), timer: setTimeout(() => ((removed = undefined), showUndo()), 8000) };
    change({ action: 'remove', id: item.id });
    showUndo();
  };
  const move = (item: ContentItem, stage: ContentStage, index = 0) => change({ action: 'move', id: item.id, stage, index });
  const focusCard = (id: string) => cols.querySelector<HTMLElement>(`.ck-card[data-id="${CSS.escape(id)}"]`)?.focus();
  const startEdit = (item: ContentItem) => {
    editing = { id: item.id, title: item.title, notes: item.notes ?? '', due: item.due ?? '', formats: new Set(item.pieces.map((p) => p.format)) };
    render();
    cols.querySelector<HTMLInputElement>('.ck-edit-title')?.focus();
  };
  const saveEdit = (item: ContentItem) => {
    if (!editing) return;
    const e = editing;
    editing = undefined;
    const title = clean(e.title).slice(0, CONTENT_TITLE_MAX);
    const notes = e.notes.trim().slice(0, CONTENT_NOTES_MAX);
    const changes: { title?: string; notes?: string; due?: string } = {};
    if (title && title !== item.title) changes.title = title;
    if (notes !== (item.notes ?? '')) changes.notes = notes;
    if (e.due !== (item.due ?? '')) changes.due = e.due;
    const formats = FORMAT_ORDER.filter((f) => e.formats.has(f));
    if (Object.keys(changes).length) change({ action: 'edit', id: item.id, ...changes });
    if (formats.join() !== item.pieces.map((p) => p.format).join()) change({ action: 'formats', id: item.id, formats });
    render();
    focusCard(item.id);
  };

  /** The card a drop at `y` in `list` lands before, or null for the end. */
  const dropBefore = (list: HTMLElement, y: number): string | null => {
    const cards = [...list.querySelectorAll<HTMLElement>('.ck-card')].filter((c) => c.dataset.id !== dragging);
    return cards.find((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    })?.dataset.id ?? null;
  };
  /** Where that is among all the stage's cards (with a filter on, some aren't showing). */
  const dropIndex = (stage: ContentStage, before: string | null): number => {
    const all = contentIn(items(), stage).filter((t) => t.id !== dragging);
    const at = before ? all.findIndex((t) => t.id === before) : -1;
    return at < 0 ? all.length : at;
  };
  const clearMarks = () => cols.querySelectorAll('.ck-drop-before, .ck-drop-end, .ck-over').forEach((n) => n.classList.remove('ck-drop-before', 'ck-drop-end', 'ck-over'));

  function editorFor(item: ContentItem): HTMLElement {
    const e = editing!;
    const title = h('input.ck-edit-title', { type: 'text', maxlength: CONTENT_TITLE_MAX, 'aria-label': 'Title' });
    title.value = e.title;
    title.addEventListener('input', () => (e.title = title.value));
    title.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        saveEdit(item);
      }
    });
    const notes = h('textarea.ck-edit-notes', { rows: 4, maxlength: CONTENT_NOTES_MAX, placeholder: 'Hook, angle, outline, links…', 'aria-label': 'Notes' });
    notes.value = e.notes;
    notes.addEventListener('input', () => (e.notes = notes.value));
    notes.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
        ev.preventDefault();
        saveEdit(item);
      }
    });
    const due = h('input.ck-edit-due', { type: 'date', 'aria-label': 'Goes out on' });
    due.value = e.due;
    due.addEventListener('input', () => (e.due = due.value));
    return h(
      'li.ck-card.editing',
      { 'data-id': item.id },
      title,
      notes,
      h('div.ck-edit-label', {}, 'Make it into:'),
      formatToggles(e.formats, 'Make it into'),
      h('label.ck-edit-label', {}, '📅 Goes out ', due, h('button.btn.ck-mini', { type: 'button', title: 'No day yet', onclick: () => ((due.value = ''), (e.due = '')) }, 'Clear')),
      h('div.ck-actions', {},
        h('button.btn.primary.ck-mini', { type: 'button', onclick: () => saveEdit(item) }, 'Save'),
        h('button.btn.ck-mini', { type: 'button', onclick: () => ((editing = undefined), render(), focusCard(item.id)) }, 'Cancel')),
    );
  }

  function cardFor(item: ContentItem): HTMLElement {
    if (editing?.id === item.id) return editorFor(item);
    const stage = item.stage;
    const i = STAGE_ORDER.indexOf(stage);
    const prev = STAGE_ORDER[i - 1];
    const next = STAGE_ORDER[i + 1];
    const { done, total } = piecesDone(item);
    const btn = (label: string, title: string, run: () => void, cls = '') =>
      h(`button.btn.ck-mini${cls}` as `button.${string}`, { type: 'button', title, 'aria-label': title, onclick: (e: Event) => (e.stopPropagation(), run()) }, label);

    const checklist = h('ul.ck-checklist', { 'aria-label': 'Checklist' });
    for (const p of item.pieces) {
      const box = h('input', { type: 'checkbox', 'aria-label': `${CONTENT_FORMATS[p.format]} made` });
      box.checked = !!p.done;
      box.addEventListener('change', () => change({ action: 'check', id: item.id, format: p.format, done: box.checked }));
      checklist.append(h('li', { class: p.done ? 'done' : '' }, h('label', { title: p.done && p.doneAt ? `Made ${timeAgo(p.doneAt)}` : 'Tick it once it’s made' }, box, h('span.ck-icon', {}, FORMAT_ICON[p.format]), h('span', {}, CONTENT_FORMATS[p.format]))));
    }
    const meta: HTMLElement[] = [];
    if (item.due) {
      const state = stage === 'published' ? 'ok' : dueState(item.due);
      meta.push(h('span.ck-due', { class: `due-${state}`, title: `Goes out ${item.due}` }, `📅 ${dueLabel(item.due)}${state === 'late' ? ' · late' : ''}`));
    }
    meta.push(h('span', {}, stage === 'published' && item.publishedAt ? `🚀 ${timeAgo(item.publishedAt)}` : `${item.by ? `${item.by} · ` : ''}${timeAgo(item.at)}`));

    const actions: HTMLElement[] = [];
    if (prev) actions.push(btn('←', `Back to ${CONTENT_STAGES[prev]}`, () => move(item, prev)));
    if (next) actions.push(btn(NEXT_LABEL[stage], `On to ${CONTENT_STAGES[next]}`, () => move(item, next), '.ck-next'));
    actions.push(btn('✏️', 'Edit: title, notes, formats and day', () => startEdit(item)), btn('✕', 'Remove', () => remove(item), '.ck-x'));

    const card = h(
      'li.ck-card',
      { 'data-id': item.id, tabindex: 0, draggable: 'true', class: total && done === total ? 'all-made' : '', title: 'Drag to move · double-click to edit · ←/→ move it on or back · Alt+↑/↓ reorder' },
      h('div.ck-title', {}, item.title),
      h('div.ck-meta', {}, ...meta),
      item.notes ? h('div.ck-notes', {}, item.notes) : null,
      total ? checklist : h('button.ck-pick', { type: 'button', onclick: (e: Event) => (e.stopPropagation(), startEdit(item)) }, '＋ What will you make of it?'),
      total ? h('div.ck-progress', { title: `${done} of ${total} made`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done }, h('span', { style: `width:${Math.round((done / total) * 100)}%` }), h('b', {}, `${done}/${total} made`)) : null,
      total && done === total && stage !== 'published' ? btn('🚀 All made — mark it published', 'All made — mark it published: everything on its checklist is made',() => move(item, 'published'), '.ck-ship') : null,
      h('div.ck-actions', {}, ...actions),
    );
    // Its subtasks and pictures, while the board shows them (its notes are on it already).
    if (todoDetailsShown('content')) {
      const details = cardDetails(item, {
        key: `content:${floor}:${item.id}`,
        save: (d) => change({ action: 'details', id: item.id, ...(d.subtasks ? { subtasks: d.subtasks } : {}), ...(d.images ? { images: d.images } : {}) }),
        current: () => find(item.id),
        redraw: render,
        notes: false,
      });
      details.addEventListener('pointerdown', () => (card.draggable = false));
      card.addEventListener('pointerup', () => (card.draggable = true));
      card.addEventListener('focusout', () => (card.draggable = true));
      card.append(details);
    }
    card.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('input, label, button, .todo-details')) startEdit(item);
    });
    card.addEventListener('dragstart', (e) => {
      dragging = item.id;
      e.dataTransfer?.setData('text/plain', item.title);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    card.addEventListener('dragend', () => {
      dragging = undefined;
      card.classList.remove('dragging');
      clearMarks();
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || e.ctrlKey || e.metaKey) return;
      const list = contentIn(items(), stage).filter(shown);
      const here = list.indexOf(item);
      if ((e.key === 'ArrowLeft' && prev) || (e.key === 'ArrowRight' && next && !e.altKey)) {
        e.preventDefault();
        move(item, e.key === 'ArrowLeft' ? prev! : next!);
        focusCard(item.id);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        const other = list[here + (e.key === 'ArrowUp' ? -1 : 1)];
        if (!other) return;
        move(item, stage, contentIn(items(), stage).indexOf(other));
        focusCard(item.id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const other = list[here + (e.key === 'ArrowUp' ? -1 : 1)];
        if (other) focusCard(other.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        startEdit(item);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const other = list[here + 1] ?? list[here - 1];
        remove(item);
        if (other) focusCard(other.id);
      }
    });
    return card;
  }

  const shown = (item: ContentItem) => !filter || item.pieces.some((p) => p.format === filter);

  function columnFor(stage: ContentStage): HTMLElement {
    const all = contentIn(items(), stage);
    const cards = all.filter(shown);
    const list = h('ul.ck-list', { 'aria-label': CONTENT_STAGES[stage] });
    for (const item of cards) list.append(cardFor(item));
    if (!cards.length) list.append(h('li.ck-empty', {}, filter && all.length ? `Nothing here for ${CONTENT_FORMATS[filter]}` : EMPTY[stage]));
    const section = h(
      'section.ck-col',
      { class: `ck-${stage}`, 'data-stage': stage },
      h('h3', {}, h('span.ck-col-title', {}, `${STAGE_ICON[stage]} `, CONTENT_STAGES[stage]), h('span.ck-count', {}, filter ? `${cards.length}/${all.length}` : String(all.length))),
      h('p.ck-hint', {}, STAGE_HINT[stage]),
      list,
    );
    section.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearMarks();
      section.classList.add('ck-over');
      const before = dropBefore(list, e.clientY);
      const mark = before && list.querySelector(`.ck-card[data-id="${CSS.escape(before)}"]`);
      if (mark) mark.classList.add('ck-drop-before');
      else list.classList.add('ck-drop-end');
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget as Node | null)) section.classList.remove('ck-over');
    });
    section.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const item = find(dragging);
      const index = dropIndex(stage, dropBefore(list, e.clientY));
      dragging = undefined;
      clearMarks();
      if (item) move(item, stage, index);
    });
    return section;
  }

  function renderFilters() {
    const counts = new Map(FORMAT_ORDER.map((f) => [f, items().filter((t) => t.stage !== 'published' && t.pieces.some((p) => p.format === f)).length]));
    const chip = (f: ContentFormat | null) =>
      h('button.ck-chip', { type: 'button', 'aria-pressed': String(filter === f), onclick: () => {
        filter = filter === f ? null : f;
        write(FILTER_KEY, filter ?? '');
        render();
      } }, f ? `${FORMAT_ICON[f]} ${counts.get(f)}` : 'All');
    filters.replaceChildren(h('span.ck-filter-label', {}, 'Show:'), chip(null), ...FORMAT_ORDER.filter((f) => counts.get(f) || filter === f).map((f) => {
      const c = chip(f);
      c.title = `Only cards with ${CONTENT_FORMATS[f]} on their checklist (${counts.get(f)} in the works)`;
      return c;
    }));
  }

  function renderSummary() {
    const all = items();
    const n = (s: ContentStage) => contentIn(all, s).length;
    const working = n('script') + n('create') + n('edit');
    const open = all.filter((t) => t.stage !== 'published');
    const made = open.reduce((s, t) => s + piecesDone(t).done, 0);
    const pieces = open.reduce((s, t) => s + t.pieces.length, 0);
    const late = open.filter((t) => t.due && dueState(t.due) === 'late').length;
    const stats = [
      h('span.ck-stat', {}, `💡 ${n('idea')} idea${n('idea') === 1 ? '' : 's'}`),
      h('span.ck-stat', {}, `🛠️ ${working} in the works`),
      h('span.ck-stat', {}, `📅 ${n('scheduled')} scheduled`),
      h('span.ck-stat', {}, `🚀 ${n('published')} published`),
    ];
    if (pieces) stats.push(h('span.ck-stat.stat-made', {}, `✅ ${made}/${pieces} pieces made`));
    if (late) stats.push(h('span.ck-stat.stat-late', {}, `⏰ ${late} past their day`));
    summary.replaceChildren(...stats);
  }

  function render() {
    if (!store.content || store.floor !== floor) return modal?.close();
    renderSummary();
    renderFilters();
    // Mid-edit, a change from someone else mustn't throw away what's typed.
    if (editing && find(editing.id) && cols.querySelector('.ck-card.editing')?.contains(document.activeElement)) return;
    if (editing && !find(editing.id)) editing = undefined;
    const active = document.activeElement instanceof HTMLElement && cols.contains(document.activeElement) ? document.activeElement : null;
    const focused = active?.closest<HTMLElement>('.ck-card')?.dataset.id;
    const scrolled = [...cols.querySelectorAll('.ck-list')].map((ul) => ul.scrollTop);
    revealHint.textContent = todoDetailsShown('content') ? 'Double-click the board to tuck subtasks away' : 'Double-click the board for subtasks & pictures';
    // A box in a card's details keeps the cursor and what's typed in it.
    const keep = active instanceof HTMLInputElement ? active.dataset.keep : undefined;
    const kept = keep ? { value: (active as HTMLInputElement).value, start: (active as HTMLInputElement).selectionStart, end: (active as HTMLInputElement).selectionEnd } : undefined;
    const drafts = new Map([...cols.querySelectorAll<HTMLInputElement>('[data-draft]')].map((d) => [d.dataset.draft, d.value]));
    cols.replaceChildren(...STAGE_ORDER.map(columnFor));
    cols.querySelectorAll<HTMLInputElement>('[data-draft]').forEach((d) => (d.value = drafts.get(d.dataset.draft) ?? ''));
    cols.querySelectorAll('.ck-list').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    const again = keep ? cols.querySelector<HTMLInputElement>(`[data-keep="${CSS.escape(keep)}"]`) : null;
    if (again && kept) {
      again.value = kept.value;
      again.focus({ preventScroll: true });
      again.setSelectionRange(kept.start, kept.end);
    } else if (focused && !editing) focusCard(focused);
  }

  const unsubs = [store.on('content', render), store.on('floor', render), onTodoDetails('content', render)];
  modal = openModal(el, {
    doing: 'planning content',
    onClose: () => {
      unsubs.forEach((u) => u());
      if (removed) clearTimeout(removed.timer);
      modal = undefined;
    },
  });
  paintDump();
  render();
  dump.focus();
}

/** For the stand's hint: what's on the board, in a few words. */
export function contentGlance(items: readonly ContentItem[]): string {
  const ideas = contentIn(items, 'idea').length;
  const working = items.filter((t) => t.stage !== 'idea' && t.stage !== 'published').length;
  if (!ideas && !working) return 'dump your content ideas';
  return [ideas ? `💡 ${ideas} idea${ideas === 1 ? '' : 's'}` : '', working ? `🛠️ ${working} in the works` : ''].filter(Boolean).join(' · ');
}
