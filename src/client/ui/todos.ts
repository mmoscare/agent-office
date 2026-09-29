import './todos.css';
import { applyTodo, newTodoId, TODO_COLUMNS, TODO_TEXT_MAX, todosIn, type TodoAction, type TodoColumn, type TodoItem } from '../../shared/todos';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';

/** Makes a change to your 🔥 To Do board: on screen straight away, and on to the office, whose copy wins once it answers (see state.ts). */
export function changeTodo(net: Net, change: TodoAction) {
  const next = applyTodo(store.todos, change);
  if (next === store.todos) return;
  store.todos = next;
  store.todosPending++;
  store.emit('todos');
  net.send({ t: 'todo', change });
}

/** What's Active, for the 🔥 button on the top bar. */
export function activeTodos(): TodoItem[] {
  return todosIn(store.todos, 'active');
}

const COLUMN_HINT: Record<TodoColumn, string> = {
  active: 'What you’re on right now',
  todo: 'Up next',
  done: 'Finished, to look back on',
};
const EMPTY: Record<TodoColumn, string> = {
  active: 'Nothing active. Hit 🔥 on a to-do (or drag it here) when you start on it.',
  todo: 'All clear. Type above and press Enter to add one.',
  done: 'Completed items land here.',
};
const FOLD_KEY = 'agent-office.todo.doneOpen';
const readFold = (): boolean => {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
};
const saveFold = (open: boolean) => {
  try {
    localStorage.setItem(FOLD_KEY, open ? '1' : '0');
  } catch {
    // just not remembered
  }
};

export interface TodoBoard {
  el: HTMLElement;
  /** Puts the cursor in the add box. */
  focus(): void;
  destroy(): void;
}

/**
 * Your own 🔥 To Do board, the same on every floor: Active (red: what you're on right now), To Do,
 * and Completed (folded away until you want to look back). Type and press Enter to add; drag cards
 * between columns and up and down, or use their buttons, or the arrow keys on a focused card.
 */
export function mountTodoBoard(net: Net): TodoBoard {
  let doneOpen = readFold();
  /** The card being edited, and what's typed in it so far. */
  let editing: { id: string; text: string } | undefined;
  /** The card being dragged. */
  let dragging: string | undefined;
  /** What the last ✕ took off, to put back with Undo. */
  let removed: { item: TodoItem; index: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const change = (a: TodoAction) => changeTodo(net, a);
  const indexOf = (item: TodoItem) => todosIn(store.todos, item.column).indexOf(item);

  const input = h('input.todo-input', { type: 'text', maxlength: TODO_TEXT_MAX, placeholder: 'What needs doing? Enter adds it to To Do · Shift+Enter starts it now', 'aria-label': 'New to-do' });
  const add = (column: TodoColumn) => {
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (!text) return input.focus();
    // Active goes on top: it's what you just started.
    change({ action: 'add', id: newTodoId(), text, column, ...(column === 'active' ? { index: 0 } : {}) });
    input.value = '';
    input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    add(e.shiftKey ? 'active' : 'todo');
  });
  const undo = h('div.todo-undo', { role: 'status', 'aria-live': 'polite' });
  const bar = h(
    'div.todo-add',
    {},
    input,
    h('button.btn', { type: 'button', title: 'Add it to To Do (Enter)', onclick: () => add('todo') }, '＋ To Do'),
    h('button.btn.todo-hot', { type: 'button', title: 'Add it straight to Active (Shift+Enter)', onclick: () => add('active') }, '🔥 Start now'),
    undo,
  );
  const cols = h('div.todo-cols');
  const el = h('div.todo-board', {}, bar, cols);

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
        change({ action: 'add', id: item.id, text: item.text, column: item.column, index });
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
  /** To the top of `column` (Completed and Active show the newest first), or `index` in it. */
  const move = (item: TodoItem, column: TodoColumn, index = 0) => change({ action: 'move', id: item.id, column, index });
  const focusCard = (id: string) => cols.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();

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
        const text = box.value.replace(/\s+/g, ' ').trim();
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
        ? [btn('✓ Complete', 'Complete it', () => move(item, 'done'), '.todo-complete'), btn('⏸', 'Back to To Do', () => move(item, 'todo'))]
        : column === 'todo'
          ? [btn('🔥 Start', 'Start it now: move it to Active', () => move(item, 'active'), '.todo-start'), btn('✓', 'Complete it', () => move(item, 'done'))]
          : [btn('↩ Reopen', 'Put it back on To Do', () => move(item, 'todo'))];
    actions.push(btn('✏️', 'Edit', () => ((editing = { id: item.id, text: item.text }), render(), cols.querySelector<HTMLTextAreaElement>('.todo-edit')?.focus())), btn('✕', 'Remove', () => remove(item), '.todo-x'));
    const card = h(
      'li.todo-card',
      { 'data-id': item.id, tabindex: 0, draggable: 'true', title: 'Drag to move · double-click to edit · ←/→ between columns · Alt+↑/↓ to reorder' },
      h('div.todo-text', {}, item.text),
      column === 'done' && item.doneAt ? h('div.todo-when', {}, `✅ ${timeAgo(item.doneAt)}`) : null,
      h('div.todo-actions', {}, ...actions),
    );
    card.addEventListener('dblclick', () => {
      editing = { id: item.id, text: item.text };
      render();
      cols.querySelector<HTMLTextAreaElement>('.todo-edit')?.focus();
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
      if (e.target !== card) return;
      const order = Object.keys(TODO_COLUMNS) as TodoColumn[];
      const i = order.indexOf(column);
      const here = indexOf(item);
      const list = todosIn(store.todos, column);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const to = order[i + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (!to) return;
        e.preventDefault();
        if (to === 'done') doneOpen = true;
        move(item, to);
        focusCard(item.id);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        const to = here + (e.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= list.length) return;
        move(item, column, to);
        focusCard(item.id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = list[here + (e.key === 'ArrowUp' ? -1 : 1)];
        if (next) focusCard(next.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        editing = { id: item.id, text: item.text };
        render();
        cols.querySelector<HTMLTextAreaElement>('.todo-edit')?.focus();
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
    const items = todosIn(store.todos, column);
    const folded = column === 'done' && !doneOpen;
    const toggle =
      column === 'done'
        ? h('button.btn.todo-mini', { type: 'button', 'aria-expanded': String(doneOpen), title: doneOpen ? 'Fold Completed away' : 'Show what you’ve completed', onclick: () => ((doneOpen = !doneOpen), saveFold(doneOpen), render()) }, doneOpen ? 'Hide' : 'Show')
        : null;
    const list = h('ul.todo-list', { 'aria-label': TODO_COLUMNS[column] });
    if (!folded) {
      for (const item of items) list.append(cardFor(item, column));
      if (!items.length) list.append(h('li.todo-empty', {}, EMPTY[column]));
    }
    const section = h(
      'section.todo-col',
      { class: `todo-${column}${folded ? ' folded' : ''}`, 'data-column': column },
      h('h3', {}, h('span.todo-title', {}, column === 'active' ? '🔥 ' : column === 'todo' ? '📝 ' : '✅ ', TODO_COLUMNS[column]), h('span.todo-count', {}, String(items.length)), toggle),
      folded ? h('button.todo-fold', { type: 'button', onclick: () => ((doneOpen = true), saveFold(true), render()) }, items.length ? `${items.length} completed — show them` : 'Nothing completed yet') : h('p.todo-hint', {}, COLUMN_HINT[column]),
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
      const item = store.todos.find((t) => t.id === dragging);
      const id = dragging;
      dragging = undefined;
      clearMarks();
      if (!item) return;
      change({ action: 'move', id, column, index: folded ? 0 : dropIndex(list, e.clientY) });
    });
    return section;
  }

  function render() {
    // Mid-edit, a change from another window mustn't throw away what's typed.
    const typing = editing && document.activeElement instanceof HTMLTextAreaElement && cols.contains(document.activeElement);
    if (typing && store.todos.some((t) => t.id === editing!.id)) return;
    const focused = document.activeElement instanceof HTMLElement && cols.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('.todo-card')?.dataset.id : undefined;
    const scrolled = [...cols.querySelectorAll('.todo-list')].map((ul) => ul.scrollTop);
    cols.replaceChildren(...(Object.keys(TODO_COLUMNS) as TodoColumn[]).map(columnFor));
    cols.querySelectorAll('.todo-list').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    if (focused) focusCard(focused);
  }

  const unsub = store.on('todos', render);
  render();
  return {
    el,
    focus: () => input.focus(),
    destroy: () => {
      unsub();
      if (removed) clearTimeout(removed.timer);
    },
  };
}
