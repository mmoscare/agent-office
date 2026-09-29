// Your own 🔥 To Do board: one list that follows you onto every floor (it's the building's, not a
// floor's), shown first on the issues board. Shared by the office (which keeps it, see
// server/todos.ts) and the browser, which makes each change straight away with applyTodo and lets
// the office's copy win when it comes back.

/** The columns, left to right: Active (what you're on right now), then To Do, then Completed. */
export const TODO_COLUMNS = { active: 'Active', todo: 'To Do', done: 'Completed' } as const;
export type TodoColumn = keyof typeof TODO_COLUMNS;
export const TODO_TEXT_MAX = 500;
/** Items a list keeps, at most; past it the oldest Completed ones go first. */
export const TODO_LIMIT = 1000;

export interface TodoItem {
  id: string;
  text: string;
  column: TodoColumn;
  /** When it was added. */
  at: number;
  /** When it last went to Completed. */
  doneAt?: number;
}

export type TodoAction =
  /** A new item, at `index` in its column (the end if left out). The browser names it, so it can show it before the office answers. */
  | { action: 'add'; id: string; text: string; column: TodoColumn; index?: number }
  /** Moved to `index` in `column` (counted without it), from wherever it was. */
  | { action: 'move'; id: string; column: TodoColumn; index?: number }
  | { action: 'edit'; id: string; text: string }
  | { action: 'remove'; id: string };

const ID_RE = /^[a-z0-9]{6,32}$/;

export function isTodoColumn(value: unknown): value is TodoColumn {
  return value === 'active' || value === 'todo' || value === 'done';
}

/** A name for a new item. */
export function newTodoId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= TODO_TEXT_MAX ? text : null;
};
const cleanIndex = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/** A change a browser sent, if it is one. */
export function checkTodoAction(raw: unknown): TodoAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return null;
  const id = a.id;
  switch (a.action) {
    case 'add': {
      const text = cleanText(a.text);
      if (!text || !isTodoColumn(a.column)) return null;
      const index = cleanIndex(a.index);
      return { action: 'add', id, text, column: a.column, ...(index === undefined ? {} : { index }) };
    }
    case 'move': {
      if (!isTodoColumn(a.column)) return null;
      const index = cleanIndex(a.index);
      return { action: 'move', id, column: a.column, ...(index === undefined ? {} : { index }) };
    }
    case 'edit': {
      const text = cleanText(a.text);
      return text ? { action: 'edit', id, text } : null;
    }
    case 'remove':
      return { action: 'remove', id };
    default:
      return null;
  }
}

/** An item read back from disk, if it is one. */
export function checkTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const text = cleanText(t.text);
  if (typeof t.id !== 'string' || !ID_RE.test(t.id) || !text || !isTodoColumn(t.column) || typeof t.at !== 'number' || !Number.isFinite(t.at)) return null;
  return { id: t.id, text, column: t.column, at: t.at, ...(typeof t.doneAt === 'number' && Number.isFinite(t.doneAt) ? { doneAt: t.doneAt } : {}) };
}

/** The items in `column`, in their order. */
export function todosIn(items: readonly TodoItem[], column: TodoColumn): TodoItem[] {
  return items.filter((t) => t.column === column);
}

/** `item` put at `index` among `column`'s items (the end if past it), keeping everything else where it was. */
function insertAt(items: TodoItem[], item: TodoItem, column: TodoColumn, index: number | undefined): TodoItem[] {
  const inColumn = items.filter((t) => t.column === column);
  if (index === undefined || index >= inColumn.length) {
    const last = inColumn.at(-1);
    const at = last ? items.indexOf(last) + 1 : items.length;
    return [...items.slice(0, at), item, ...items.slice(at)];
  }
  const at = items.indexOf(inColumn[index]);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/**
 * The list after `a`. The same list back when it changes nothing (an item that's already gone, a
 * name that's taken). Completed items come off the far end once there are too many.
 */
export function applyTodo(items: readonly TodoItem[], a: TodoAction, now = Date.now()): readonly TodoItem[] {
  const was = items.find((t) => t.id === a.id);
  let next: TodoItem[];
  switch (a.action) {
    case 'add': {
      if (was) return items;
      const item: TodoItem = { id: a.id, text: a.text, column: a.column, at: now, ...(a.column === 'done' ? { doneAt: now } : {}) };
      next = insertAt([...items], item, a.column, a.index);
      break;
    }
    case 'move': {
      if (!was) return items;
      const moved: TodoItem = { ...was, column: a.column };
      if (a.column === 'done' && was.column !== 'done') moved.doneAt = now;
      if (a.column !== 'done') delete moved.doneAt;
      next = insertAt(items.filter((t) => t !== was), moved, a.column, a.index);
      break;
    }
    case 'edit':
      if (!was || was.text === a.text) return items;
      next = items.map((t) => (t === was ? { ...t, text: a.text } : t));
      break;
    case 'remove':
      if (!was) return items;
      next = items.filter((t) => t !== was);
      break;
  }
  while (next.length > TODO_LIMIT) {
    const oldest = todosIn(next, 'done').sort((x, y) => (x.doneAt ?? x.at) - (y.doneAt ?? y.at))[0] ?? next[next.length - 1];
    next = next.filter((t) => t !== oldest);
  }
  return next;
}
