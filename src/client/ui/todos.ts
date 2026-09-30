import './todos.css';
import { applyTodo, newTodoId, TODO_COLUMNS, TODO_TEXT_MAX, todosIn, type TodoAction, type TodoBoardId, type TodoColumn, type TodoItem } from '../../shared/todos';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';
import { cardDetails, onTodoDetails, setTodoDetailsShown, todoDetailsShown } from './todo-details';

/** A board's list as it is now: your own 🔥 To Do, or the office's 🏢 Autonomous Tasks. */
export function todoList(board: TodoBoardId): readonly TodoItem[] {
  return board === 'autonomous' ? store.autonomous : store.todos;
}
/** What the store calls a board's changes. */
export const todoTopic = (board: TodoBoardId) => (board === 'autonomous' ? 'autonomous' : 'todos');

/** Makes a change to a board: on screen straight away, and on to the office, whose copy wins once it answers (see state.ts). */
export function changeTodo(net: Net, change: TodoAction, board: TodoBoardId = 'mine') {
  const was = todoList(board);
  const next = applyTodo(was, change);
  if (next === was) return;
  if (board === 'autonomous') {
    store.autonomous = next;
    store.autonomousPending++;
    store.emit('autonomous');
    net.send({ t: 'todo', change, board });
    return;
  }
  store.todos = next;
  store.todosPending++;
  store.emit('todos');
  net.send({ t: 'todo', change });
}

/** What's Active, for the 🔥 button on the top bar. */
export function activeTodos(): TodoItem[] {
  return todosIn(store.todos, 'active');
}

/** The columns in order, left to right. */
export const COLUMN_ORDER = Object.keys(TODO_COLUMNS) as TodoColumn[];
/** Each column's badge, on the board and on the wall. */
export const COLUMN_ICON: Record<TodoColumn, string> = { active: '🔥', urgent: '⚡', todo: '🌱', done: '✅' };
/** Past this many Active at once, the column asks you to finish one first. */
export const ACTIVE_FOCUS = 3;

const COLUMN_HINT: Record<TodoColumn, string> = {
  active: 'What you’re on right now',
  urgent: 'Next up — needs doing soon',
  todo: 'When there’s time',
  done: 'Finished, to look back on',
};
const EMPTY: Record<TodoColumn, string> = {
  active: 'Nothing active. Hit 🔥 Start on a card (or drag it here) when you begin.',
  urgent: 'Nothing urgent. 🎉',
  todo: 'Ideas and someday jobs go here.',
  done: 'Completed cards land here.',
};

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
/** Where a board remembers, in this browser, whether Completed is open and which column Enter adds to. */
const PREFIX: Record<TodoBoardId, string> = { mine: 'agent-office.todo', autonomous: 'agent-office.autonomous' };

// ---- Which side of the issues board faces the room -----------------------------------------------

/** The issues board on the wall shows your To Do board unless you flip it to the floor's issues. */
export type IssuesWallMode = 'todo' | 'issues';
const WALL_KEY = 'agent-office.issuesWall';
let wallMode: IssuesWallMode = read(WALL_KEY) === 'issues' ? 'issues' : 'todo';
const wallListeners = new Set<(m: IssuesWallMode) => void>();
export function issuesWallMode(): IssuesWallMode {
  return wallMode;
}
export function setIssuesWallMode(m: IssuesWallMode) {
  if (m === wallMode) return;
  wallMode = m;
  write(WALL_KEY, m);
  wallListeners.forEach((fn) => fn(m));
}
export function onIssuesWallMode(fn: (m: IssuesWallMode) => void): () => void {
  wallListeners.add(fn);
  return () => wallListeners.delete(fn);
}

// ---- The board --------------------------------------------------------------------------------

export interface TodoBoard {
  el: HTMLElement;
  /** Puts the cursor in the add box. */
  focus(): void;
  destroy(): void;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const startOfToday = () => new Date(new Date().toDateString()).getTime();

/**
 * Your own 🔥 To Do board, the same on every floor: Active (red: what you're on right now), Urgent,
 * Not urgent, and Completed (folded away until you want to look back). Type in the box at the top
 * (Enter adds to the column picked beside it, Shift+Enter starts it now) or in a column's own add
 * box. Drag cards between columns and up and down (the top is what matters most), or use their
 * buttons, or keys on a focused card: 1–4 or ←/→ move it, Alt+↑/↓ reorder, Space completes.
 * Double-click the board around the cards to show (or put away) each card's notes, subtasks and
 * pictures (ui/todo-details.ts). `board` is which list: yours, or the office's Autonomous Tasks.
 */
export function mountTodoBoard(net: Net, board: TodoBoardId = 'mine'): TodoBoard {
  const FOLD_KEY = `${PREFIX[board]}.doneOpen`;
  const TARGET_KEY = `${PREFIX[board]}.addTo`;
  const items = () => todoList(board);
  let doneOpen = read(FOLD_KEY) === '1';
  let target: Exclude<TodoColumn, 'done'> = (['active', 'urgent', 'todo'] as const).find((c) => c === read(TARGET_KEY)) ?? 'urgent';
  /** The card being edited, and what's typed in it so far. */
  let editing: { id: string; text: string } | undefined;
  /** The card being dragged. */
  let dragging: string | undefined;
  /** What the last ✕ took off, to put back with Undo. */
  let removed: { item: TodoItem; index: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const change = (a: TodoAction) => changeTodo(net, a, board);
  const indexOf = (item: TodoItem) => todosIn(items(), item.column).indexOf(item);
  /** New cards go on top: the top of a column is what matters most. */
  const addTo = (column: TodoColumn, raw: string): boolean => {
    const text = clean(raw);
    if (!text) return false;
    change({ action: 'add', id: newTodoId(), text: text.slice(0, TODO_TEXT_MAX), column, index: 0 });
    return true;
  };

  const input = h('input.todo-input', { type: 'text', maxlength: TODO_TEXT_MAX, placeholder: 'Add a card… Enter adds it to the column picked on the right · Shift+Enter starts it now', 'aria-label': 'New to-do' });
  const pick = (column: Exclude<TodoColumn, 'done'>) =>
    h(
      'button.btn.todo-pick',
      { type: 'button', class: `pick-${column}`, 'data-column': column, 'aria-pressed': String(column === target), title: `Add to ${TODO_COLUMNS[column]}${column === target ? ' (Enter)' : ''}`, onclick: () => {
        target = column;
        write(TARGET_KEY, column);
        if (addTo(column, input.value)) input.value = '';
        paintPicks();
        input.focus();
      } },
      `${COLUMN_ICON[column]} ${TODO_COLUMNS[column]}`,
    );
  const picks = h('div.todo-picks', { role: 'group', 'aria-label': 'Add to' }, pick('active'), pick('urgent'), pick('todo'));
  const paintPicks = () =>
    picks.querySelectorAll<HTMLElement>('[data-column]').forEach((b) => {
      const on = b.dataset.column === target;
      b.setAttribute('aria-pressed', String(on));
      b.title = `Add to ${TODO_COLUMNS[b.dataset.column as TodoColumn]}${on ? ' (Enter)' : ''}`;
    });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (addTo(e.shiftKey ? 'active' : target, input.value)) input.value = '';
  });
  const summary = h('div.todo-summary', { 'aria-live': 'polite' });
  const undo = h('div.todo-undo', { role: 'status', 'aria-live': 'polite' });
  const cols = h('div.todo-cols');
  const el = h('div.todo-board', { class: `board-${board}` }, h('div.todo-add', {}, input, picks), h('div.todo-bar', {}, summary, undo), cols);
  // Double-click the board around the cards (the cork) to show every card's notes, subtasks and
  // pictures, and again to put them away. A card, a box or a button keeps its own double-click.
  el.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.todo-card, input, textarea, button, a, label, .todo-stat')) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    setTodoDetailsShown(board, !todoDetailsShown(board));
  });

  const showUndo = () => {
    if (!removed) return undo.replaceChildren();
    const text = removed.item.text.length > 40 ? `${removed.item.text.slice(0, 39)}…` : removed.item.text;
    undo.replaceChildren(
      h('span', {}, `Removed “${text}”`),
      h('button.btn.todo-mini', { type: 'button', onclick: () => {
        if (!removed) return;
        const { item, index, timer } = removed;
        clearTimeout(timer);
        removed = undefined;
        // Back with its notes, subtasks and pictures.
        change({ action: 'add', id: item.id, text: item.text, column: item.column, index, notes: item.notes, subtasks: item.subtasks, images: item.images });
        showUndo();
      } }, 'Undo'),
    );
  };
  const remove = (item: TodoItem) => {
    if (removed) clearTimeout(removed.timer);
    removed = { item, index: indexOf(item), timer: setTimeout(() => ((removed = undefined), showUndo()), 8000) };
    change({ action: 'remove', id: item.id });
    showUndo();
  };
  /** To the top of `column`, or `index` in it. */
  const move = (item: TodoItem, column: TodoColumn, index = 0) => {
    change({ action: 'move', id: item.id, column, index });
    // Completed is folded: it lights up, to say where the card went.
    if (column === 'done' && !doneOpen) cols.querySelector('.todo-fold')?.classList.add('todo-flash');
  };
  const complete = (item: TodoItem) => move(item, 'done');
  const reopen = (item: TodoItem) => move(item, item.from ?? 'urgent');
  const focusCard = (id: string) => cols.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  const startEdit = (item: TodoItem) => {
    editing = { id: item.id, text: item.text };
    render();
    const box = cols.querySelector<HTMLTextAreaElement>('.todo-edit');
    box?.focus();
    box?.select();
  };

  /** Where in `list` a card dropped at `y` goes: before the first card whose middle is below it. */
  const dropIndex = (list: HTMLElement, y: number): number => {
    const cards = [...list.querySelectorAll<HTMLElement>('.todo-card')].filter((c) => c.dataset.id !== dragging);
    const at = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return at < 0 ? cards.length : at;
  };
  const clearMarks = () => cols.querySelectorAll('.todo-drop-before, .todo-drop-end, .todo-over').forEach((n) => n.classList.remove('todo-drop-before', 'todo-drop-end', 'todo-over'));

  function cardFor(item: TodoItem, column: TodoColumn): HTMLElement {
    if (editing?.id === item.id) {
      const box = h('textarea.todo-edit', { rows: 3, maxlength: TODO_TEXT_MAX, 'aria-label': 'Edit to-do' });
      box.value = editing.text;
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const text = clean(box.value);
        editing = undefined;
        if (save && text && text !== item.text) change({ action: 'edit', id: item.id, text });
        else render();
        focusCard(item.id);
      };
      box.addEventListener('input', () => editing && (editing.text = box.value));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          finish(true);
        }
      });
      box.addEventListener('blur', () => finish(true));
      return h('li.todo-card.editing', { 'data-id': item.id }, box);
    }
    const btn = (label: string, title: string, run: () => void, cls = '') =>
      h(`button.btn.todo-mini${cls}` as `button.${string}`, { type: 'button', title, 'aria-label': title, onclick: (e: Event) => (e.stopPropagation(), run()) }, label);
    const actions: HTMLElement[] =
      column === 'active'
        ? [btn('✓ Complete', 'Complete it', () => complete(item), '.todo-complete'), btn('⏸', 'Pause: back to Urgent', () => move(item, 'urgent'))]
        : column === 'urgent'
          ? [btn('🔥 Start', 'Start it now: move it to Active', () => move(item, 'active'), '.todo-start'), btn('🌱', 'Not urgent after all', () => move(item, 'todo')), btn('✓', 'Complete it', () => complete(item))]
          : column === 'todo'
            ? [btn('🔥 Start', 'Start it now: move it to Active', () => move(item, 'active'), '.todo-start'), btn('⚡', 'Make it urgent', () => move(item, 'urgent')), btn('✓', 'Complete it', () => complete(item))]
            : [btn('↩ Reopen', `Put it back on ${TODO_COLUMNS[item.from ?? 'urgent']}`, () => reopen(item))];
    actions.push(btn('✏️', 'Edit', () => startEdit(item)), btn('✕', 'Remove', () => remove(item), '.todo-x'));
    const when = column === 'done' && item.doneAt ? `✅ ${timeAgo(item.doneAt)}` : `added ${timeAgo(item.at)}`;
    const card = h(
      'li.todo-card',
      { 'data-id': item.id, tabindex: 0, draggable: 'true', title: 'Drag to move · double-click to edit · 1–4 or ←/→ move it · Alt+↑/↓ reorder · Space completes' },
      h('div.todo-text', {}, item.text),
      h('div.todo-when', {}, when),
      h('div.todo-actions', {}, ...actions),
    );
    // Notes, subtasks and pictures, while the board shows them. Working in them doesn't pick the card up.
    if (todoDetailsShown(board)) {
      const details = cardDetails(item, {
        key: `${board}:${item.id}`,
        save: (d) => change({ action: 'details', id: item.id, ...d }),
        current: () => items().find((t) => t.id === item.id),
        redraw: render,
      });
      details.addEventListener('pointerdown', () => (card.draggable = false));
      card.addEventListener('pointerup', () => (card.draggable = true));
      card.addEventListener('focusout', () => (card.draggable = true));
      card.append(details);
    }
    card.addEventListener('dblclick', (e) => {
      if (!(e.target as Element).closest('.todo-details')) startEdit(item);
    });
    card.addEventListener('dragstart', (e) => {
      dragging = item.id;
      e.dataTransfer?.setData('text/plain', item.text);
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
      const i = COLUMN_ORDER.indexOf(column);
      const here = indexOf(item);
      const list = todosIn(items(), column);
      const to = /^[1-4]$/.test(e.key) ? COLUMN_ORDER[Number(e.key) - 1] : e.key === 'ArrowLeft' ? COLUMN_ORDER[i - 1] : e.key === 'ArrowRight' && !e.altKey ? COLUMN_ORDER[i + 1] : undefined;
      if (to) {
        e.preventDefault();
        if (to === column) return;
        if (to === 'done') doneOpen = true;
        move(item, to);
        focusCard(item.id);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        const at = here + (e.key === 'ArrowUp' ? -1 : 1);
        if (at < 0 || at >= list.length) return;
        move(item, column, at);
        focusCard(item.id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = list[here + (e.key === 'ArrowUp' ? -1 : 1)];
        if (next) focusCard(next.id);
      } else if (e.key === ' ') {
        e.preventDefault();
        const neighbour = list[here + 1] ?? list[here - 1];
        if (column === 'done') reopen(item);
        else complete(item);
        if (neighbour) focusCard(neighbour.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        startEdit(item);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const neighbour = list[here + 1] ?? list[here - 1];
        remove(item);
        if (neighbour) focusCard(neighbour.id);
        else input.focus();
      }
    });
    return card;
  }

  function columnFor(column: TodoColumn): HTMLElement {
    const cards = todosIn(items(), column);
    const folded = column === 'done' && !doneOpen;
    const busy = column === 'active' && cards.length > ACTIVE_FOCUS;
    const toggle =
      column === 'done'
        ? h('button.btn.todo-mini.todo-toggle', { type: 'button', 'aria-expanded': String(doneOpen), title: doneOpen ? 'Fold Completed away' : 'Show what you’ve completed', onclick: () => ((doneOpen = !doneOpen), write(FOLD_KEY, doneOpen ? '1' : '0'), render()) }, doneOpen ? 'Hide' : 'Show')
        : null;
    const list = h('ul.todo-list', { 'aria-label': TODO_COLUMNS[column] });
    if (!folded) {
      for (const item of cards) list.append(cardFor(item, column));
      if (!cards.length) list.append(h('li.todo-empty', {}, EMPTY[column]));
    }
    // Each column but Completed has its own add box: type straight into the one it belongs in.
    const quick =
      column === 'done'
        ? null
        : h('input.todo-quick', { type: 'text', maxlength: TODO_TEXT_MAX, placeholder: `＋ Add to ${TODO_COLUMNS[column]}`, 'aria-label': `Add to ${TODO_COLUMNS[column]}`, 'data-quick': column });
    quick?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      // Emptied first: adding redraws the columns, and the box is drawn again with what's in it.
      const text = quick.value;
      quick.value = '';
      if (!addTo(column, text)) quick.value = text;
    });
    const section = h(
      'section.todo-col',
      { class: `todo-${column}${folded ? ' folded' : ''}${busy ? ' todo-busy' : ''}`, 'data-column': column },
      h('h3', {}, h('span.todo-title', {}, `${COLUMN_ICON[column]} `, TODO_COLUMNS[column]), h('span.todo-count', {}, String(cards.length)), toggle),
      folded
        ? h('button.todo-fold', { type: 'button', onclick: () => ((doneOpen = true), write(FOLD_KEY, '1'), render()) }, cards.length ? `${cards.length} completed — show them` : 'Nothing completed yet')
        : h('p.todo-hint', {}, busy ? `${cards.length} at once — finish one before starting another?` : COLUMN_HINT[column]),
      quick,
      list,
    );
    // Dropping a card: anywhere on the column, at the spot under the pointer.
    section.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearMarks();
      section.classList.add('todo-over');
      if (folded) return;
      const cards = [...list.querySelectorAll<HTMLElement>('.todo-card')].filter((c) => c.dataset.id !== dragging);
      const at = dropIndex(list, e.clientY);
      if (cards[at]) cards[at].classList.add('todo-drop-before');
      else list.classList.add('todo-drop-end');
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget as Node | null)) section.classList.remove('todo-over');
    });
    section.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const id = dragging;
      dragging = undefined;
      clearMarks();
      if (!items().some((t) => t.id === id)) return;
      change({ action: 'move', id, column, index: folded ? 0 : dropIndex(list, e.clientY) });
    });
    return section;
  }

  function renderSummary() {
    const n = (c: TodoColumn) => todosIn(items(), c).length;
    const today = startOfToday();
    const doneToday = todosIn(items(), 'done').filter((t) => (t.doneAt ?? 0) >= today).length;
    summary.replaceChildren(
      ...(['active', 'urgent', 'todo'] as const).map((c) => h('span.todo-stat', { class: `stat-${c}` }, `${COLUMN_ICON[c]} ${n(c)} ${TODO_COLUMNS[c].toLowerCase()}`)),
      h('span.todo-stat.stat-done', {}, `✅ ${doneToday} done today`),
      h('span.todo-reveal-hint', {}, todoDetailsShown(board) ? 'Double-click the board to tuck notes away' : 'Double-click the board for notes, subtasks & pictures'),
    );
  }

  function render() {
    renderSummary();
    // Mid-edit, a change from another window mustn't throw away what's typed.
    const typing = editing && document.activeElement instanceof HTMLTextAreaElement && cols.contains(document.activeElement);
    if (typing && items().some((t) => t.id === editing!.id)) return;
    const active = document.activeElement instanceof HTMLElement && cols.contains(document.activeElement) ? document.activeElement : null;
    const focused = active?.closest<HTMLElement>('.todo-card')?.dataset.id;
    // A column's add box keeps the cursor and what's typed in it across a redraw.
    const quick = active instanceof HTMLInputElement ? active.dataset.quick : undefined;
    const typed = new Map([...cols.querySelectorAll<HTMLInputElement>('.todo-quick')].map((q) => [q.dataset.quick, q.value]));
    const scrolled = [...cols.querySelectorAll('.todo-list')].map((ul) => ul.scrollTop);
    // A card's notes (or any box in its details) keeps the cursor, the selection and what's typed.
    const keep = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.dataset.keep : undefined;
    const kept = keep ? { value: (active as HTMLInputElement).value, start: (active as HTMLInputElement).selectionStart, end: (active as HTMLInputElement).selectionEnd, top: active!.scrollTop } : undefined;
    const drafts = new Map([...cols.querySelectorAll<HTMLInputElement>('[data-draft]')].map((d) => [d.dataset.draft, d.value]));
    cols.replaceChildren(...COLUMN_ORDER.map(columnFor));
    cols.querySelectorAll<HTMLInputElement>('.todo-quick').forEach((q) => (q.value = typed.get(q.dataset.quick) ?? ''));
    cols.querySelectorAll<HTMLInputElement>('[data-draft]').forEach((d) => (d.value = drafts.get(d.dataset.draft) ?? ''));
    cols.querySelectorAll('.todo-list').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    const again = keep ? cols.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-keep="${CSS.escape(keep)}"]`) : null;
    if (again && kept) {
      again.value = kept.value;
      again.focus({ preventScroll: true });
      again.setSelectionRange(kept.start, kept.end);
      again.scrollTop = kept.top;
    } else if (quick) cols.querySelector<HTMLInputElement>(`[data-quick="${quick}"]`)?.focus();
    else if (focused) focusCard(focused);
  }

  const unsubs = [store.on(todoTopic(board), render), onTodoDetails(board, render)];
  render();
  return {
    el,
    focus: () => input.focus(),
    destroy: () => {
      unsubs.forEach((u) => u());
      if (removed) clearTimeout(removed.timer);
    },
  };
}

/** The 🏢 Autonomous Tasks board, opened from its whiteboard: the To Do board's kanban, with the office's list on it. */
export function openAutonomousBoard(net: Net) {
  const board = mountTodoBoard(net, 'autonomous');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal.board.autonomous-board',
    { role: 'dialog', 'aria-label': 'Autonomous Tasks board' },
    h('header', {}, h('h2', {}, '🏢 Autonomous Tasks'), h('span.board-status', {}, 'One board for the whole office'), close),
    h('div.body.todo-body', {}, board.el),
  );
  const modal = openModal(el, { doing: '🏢 at the Autonomous Tasks board', onClose: () => board.destroy() });
  close.addEventListener('click', () => modal.close());
  // Once the E that opened it is done with, so it isn't typed into the add box.
  requestAnimationFrame(() => board.focus());
}

/** What's Active on the Autonomous Tasks board. */
export function activeAutonomous(): TodoItem[] {
  return todosIn(store.autonomous, 'active');
}
