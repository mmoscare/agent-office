// Your own 🔥 To Do board: one list that follows you onto every floor (it's the building's, not a
// floor's), shown first on the issues board. Shared by the office (which keeps it, see
// server/todos.ts) and the browser, which makes each change straight away with applyTodo and lets
// the office's copy win when it comes back. The 🏢 Autonomous Tasks whiteboard is the same kind of
// board, with one list for the whole office.

/**
 * The columns, left to right: Active (red: what you're on right now), Urgent, Not urgent, and
 * Completed. Not urgent keeps the 'todo' key the board started with, so lists saved then still read.
 */
export const TODO_COLUMNS = { active: 'Active', urgent: 'Urgent', todo: 'Not urgent', done: 'Completed' } as const;
export type TodoColumn = keyof typeof TODO_COLUMNS;
export const TODO_TEXT_MAX = 500;
/** Items a list keeps, at most; past it the oldest Completed ones go first. */
export const TODO_LIMIT = 1000;
/** A card's notes, its subtasks and its pictures: hidden until you double-click the board (see ui/todos.ts). */
export const TODO_NOTES_MAX = 20_000;
export const TODO_SUBTASKS_MAX = 100;
export const TODO_IMAGES_MAX = 20;

/**
 * The boards drawn this way: your own 🔥 To Do (one list each, on the issues board), and 🏢
 * Autonomous Tasks (one list for the whole office, on its own whiteboard). Same columns, same cards.
 */
export type TodoBoardId = 'mine' | 'autonomous';
export function isTodoBoard(value: unknown): value is TodoBoardId {
  return value === 'mine' || value === 'autonomous';
}

export interface TodoSubtask {
  id: string;
  text: string;
  done: boolean;
}

/** A card's extras, all optional: what `details` changes, and what `add` brings back with Undo. */
export interface TodoDetails {
  /** Free text, line breaks and all. */
  notes?: string;
  subtasks?: TodoSubtask[];
  /** Picture names, served from /api/todo-image (see server/todo-images.ts). */
  images?: string[];
}

export interface TodoItem extends TodoDetails {
  id: string;
  text: string;
  column: TodoColumn;
  /** When it was added. */
  at: number;
  /** When it last went to Completed. */
  doneAt?: number;
  /** Where it was before it went to Completed, for Reopen. */
  from?: Exclude<TodoColumn, 'done'>;
}

export type TodoAction =
  /** A new item, at `index` in its column (the end if left out). The browser names it, so it can show it before the office answers. */
  | ({ action: 'add'; id: string; text: string; column: TodoColumn; index?: number } & TodoDetails)
  /** Moved to `index` in `column` (counted without it), from wherever it was. */
  | { action: 'move'; id: string; column: TodoColumn; index?: number }
  | { action: 'edit'; id: string; text: string }
  /** Replaces whichever of the card's notes, subtasks and pictures it names; an empty one takes it off. */
  | ({ action: 'details'; id: string } & TodoDetails)
  | { action: 'remove'; id: string };

const ID_RE = /^[a-z0-9]{6,32}$/;
/** A picture's name: a hash of what's in it, and its type. */
export const TODO_IMAGE_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

export function isTodoColumn(value: unknown): value is TodoColumn {
  return value === 'active' || value === 'urgent' || value === 'todo' || value === 'done';
}

/** A name for a new item (or subtask). */
export function newTodoId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= TODO_TEXT_MAX ? text : null;
};
const cleanNotes = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const notes = value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return notes.length <= TODO_NOTES_MAX ? notes : null;
};
/** Subtasks as sent or saved, if they all read; null if any doesn't. */
export const cleanSubtasks = (value: unknown): TodoSubtask[] | null => {
  if (!Array.isArray(value) || value.length > TODO_SUBTASKS_MAX) return null;
  const seen = new Set<string>();
  const out: TodoSubtask[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const text = cleanText(s.text);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id) || seen.has(s.id) || !text) return null;
    seen.add(s.id);
    out.push({ id: s.id, text, done: s.done === true });
  }
  return out;
};
/** Picture names as sent or saved, each once, if they all read; null if any doesn't. */
export const cleanImages = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > TODO_IMAGES_MAX) return null;
  if (!value.every((v) => typeof v === 'string' && TODO_IMAGE_RE.test(v))) return null;
  return [...new Set(value as string[])];
};
/** The extras in `raw` that it has; null when one it has isn't good. */
function cleanDetails(raw: Record<string, unknown>): TodoDetails | null {
  const d: TodoDetails = {};
  if (raw.notes !== undefined) {
    const notes = cleanNotes(raw.notes);
    if (notes === null) return null;
    d.notes = notes;
  }
  if (raw.subtasks !== undefined) {
    const subtasks = cleanSubtasks(raw.subtasks);
    if (!subtasks) return null;
    d.subtasks = subtasks;
  }
  if (raw.images !== undefined) {
    const images = cleanImages(raw.images);
    if (!images) return null;
    d.images = images;
  }
  return d;
}
/** `item` with `d` put on it; empty extras come off, so a plain card stays plain. */
function withDetails(item: TodoItem, d: TodoDetails): TodoItem {
  const next: TodoItem = { ...item };
  if (d.notes !== undefined) next.notes = d.notes;
  if (d.subtasks !== undefined) next.subtasks = d.subtasks;
  if (d.images !== undefined) next.images = d.images;
  if (!next.notes) delete next.notes;
  if (!next.subtasks?.length) delete next.subtasks;
  if (!next.images?.length) delete next.images;
  return next;
}
/** Whether a card has any notes, subtasks or pictures. */
export function hasDetails(item: TodoDetails): boolean {
  return !!(item.notes || item.subtasks?.length || item.images?.length);
}
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
      const details = cleanDetails(a);
      if (!details) return null;
      return { action: 'add', id, text, column: a.column, ...(index === undefined ? {} : { index }), ...details };
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
    case 'details': {
      const details = cleanDetails(a);
      return details && Object.keys(details).length ? { action: 'details', id, ...details } : null;
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
  // Extras that don't read are left off, not the card.
  const notes = cleanNotes(t.notes);
  const subtasks = t.subtasks === undefined ? null : cleanSubtasks(t.subtasks);
  const images = t.images === undefined ? null : cleanImages(t.images);
  return {
    id: t.id,
    text,
    column: t.column,
    at: t.at,
    ...(typeof t.doneAt === 'number' && Number.isFinite(t.doneAt) ? { doneAt: t.doneAt } : {}),
    ...(t.column === 'done' && isTodoColumn(t.from) && t.from !== 'done' ? { from: t.from } : {}),
    ...(notes ? { notes } : {}),
    ...(subtasks?.length ? { subtasks } : {}),
    ...(images?.length ? { images } : {}),
  };
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
      const item = withDetails({ id: a.id, text: a.text, column: a.column, at: now, ...(a.column === 'done' ? { doneAt: now } : {}) }, a);
      next = insertAt([...items], item, a.column, a.index);
      break;
    }
    case 'move': {
      if (!was) return items;
      const moved: TodoItem = { ...was, column: a.column };
      if (a.column === 'done' && was.column !== 'done') {
        moved.doneAt = now;
        moved.from = was.column;
      }
      if (a.column !== 'done') {
        delete moved.doneAt;
        delete moved.from;
      }
      next = insertAt(items.filter((t) => t !== was), moved, a.column, a.index);
      break;
    }
    case 'edit':
      if (!was || was.text === a.text) return items;
      next = items.map((t) => (t === was ? { ...t, text: a.text } : t));
      break;
    case 'details': {
      if (!was) return items;
      const changed = withDetails(was, a);
      if (JSON.stringify(changed) === JSON.stringify(was)) return items;
      next = items.map((t) => (t === was ? changed : t));
      break;
    }
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
