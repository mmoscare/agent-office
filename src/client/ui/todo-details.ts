import { newTodoId, TODO_IMAGES_MAX, TODO_NOTES_MAX, TODO_SUBTASKS_MAX, TODO_TEXT_MAX, type TodoAction, type TodoBoardId, type TodoItem, type TodoSubtask } from '../../shared/todos';
import { store } from '../state';
import { h, toast } from './dom';

// A kanban card's notes, subtasks and pictures (see shared/todos.ts). The boards look just as they
// always did until you double-click around the cards: then every card shows its details, until you
// double-click again. Each board (your To Do, the Autonomous Tasks) remembers that on its own, for
// as long as the page is open.

const shown: Record<TodoBoardId, boolean> = { mine: false, autonomous: false };
const listeners = new Set<{ board: TodoBoardId; fn: () => void }>();

/** Whether `board`'s cards show their notes, subtasks and pictures. */
export function todoDetailsShown(board: TodoBoardId): boolean {
  return shown[board];
}
export function setTodoDetailsShown(board: TodoBoardId, on: boolean) {
  if (shown[board] === on) return;
  shown[board] = on;
  for (const l of [...listeners]) if (l.board === board) l.fn();
}
export function onTodoDetails(board: TodoBoardId, fn: () => void): () => void {
  const l = { board, fn };
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Where a card's picture is served from. */
export const todoImageUrl = (id: string) => `/api/todo-image?id=${encodeURIComponent(id)}`;

/** The biggest a picture goes up, on its longer side; bigger ones are shrunk first. */
const IMAGE_EDGE = 1600;
const IMAGE_SEND_MAX = 6 * 1024 * 1024;

const readDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that picture"));
    r.readAsDataURL(blob);
  });

/** `file` as a data: URL the office takes: small ones as they are, big ones shrunk to a JPEG. */
async function prepare(file: File): Promise<string> {
  if (file.type === 'image/gif') {
    if (file.size > IMAGE_SEND_MAX) throw new Error('That GIF is too big (over 6 MB)');
    return readDataURL(file);
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That doesn't look like a picture");
  });
  const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024 && /^image\/(png|jpeg|webp)$/.test(file.type)) {
    bitmap.close();
    return readDataURL(file);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d')!;
  // A see-through PNG goes onto white, not black.
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.87);
}

/** Puts a picture on the office's machine; its name. */
export async function uploadTodoImage(file: File): Promise<string> {
  const dataURL = await prepare(file);
  const res = await fetch('/api/todo-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataURL }) });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `The office said no (${res.status})`);
  return body.id;
}

const listOf = (board: TodoBoardId) => (board === 'autonomous' ? store.autonomous : store.todos);
/** The card as it is now, not as it was when it was drawn. */
const now = (board: TodoBoardId, id: string) => listOf(board).find((t) => t.id === id);

/** Notes typed but not sent yet, per card: sent a moment after typing stops, or when the box loses the cursor. */
const typing = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string; send: () => void }>();
/** Cards with pictures on their way up, and how many. */
const uploading = new Map<string, number>();

export interface DetailsContext {
  board: TodoBoardId;
  change: (a: TodoAction) => void;
}

/** A card's notes, subtasks and pictures, to put on the card while the board shows them. */
export function cardDetails(item: TodoItem, ctx: DetailsContext): HTMLElement {
  const { board, change } = ctx;
  const key = `${board}:${item.id}`;
  const subtasks = item.subtasks ?? [];
  const images = item.images ?? [];
  const setSubs = (next: TodoSubtask[]) => change({ action: 'details', id: item.id, subtasks: next });
  const subsNow = () => now(board, item.id)?.subtasks ?? [];

  // Subtasks: tick them off, double-click one to reword it, ✕ to take it off.
  const done = subtasks.filter((s) => s.done).length;
  const subList = h('ul.todo-subs');
  for (const s of subtasks) {
    const box = h('input', { type: 'checkbox', 'aria-label': `Done: ${s.text}` });
    box.checked = s.done;
    box.addEventListener('change', () => setSubs(subsNow().map((x) => (x.id === s.id ? { ...x, done: box.checked } : x))));
    const text = h('span.todo-sub-text', { title: 'Double-click to reword it' }, s.text);
    text.addEventListener('dblclick', () => {
      const edit = h('input.todo-sub-edit', { type: 'text', maxlength: TODO_TEXT_MAX, 'aria-label': 'Reword subtask', 'data-keep': `${key}:sub:${s.id}` });
      edit.value = s.text;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const t = edit.value.replace(/\s+/g, ' ').trim();
        if (t && t !== s.text) setSubs(subsNow().map((x) => (x.id === s.id ? { ...x, text: t } : x)));
        else edit.replaceWith(text);
      };
      edit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          finish();
        }
      });
      edit.addEventListener('blur', finish);
      text.replaceWith(edit);
      edit.focus();
      edit.select();
    });
    const x = h('button.btn.todo-mini.todo-sub-x', { type: 'button', title: 'Take this subtask off', 'aria-label': `Remove subtask: ${s.text}` }, '✕');
    x.addEventListener('click', () => setSubs(subsNow().filter((y) => y.id !== s.id)));
    subList.append(h('li.todo-sub', { class: s.done ? 'done' : '' }, h('label', {}, box, text), x));
  }
  const addSub = h('input.todo-sub-add', { type: 'text', maxlength: TODO_TEXT_MAX, placeholder: '＋ Add a subtask', 'aria-label': 'Add a subtask', 'data-keep': `${key}:sub-add`, 'data-draft': `${key}:sub-add` });
  addSub.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const t = addSub.value.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const was = subsNow();
    if (was.length >= TODO_SUBTASKS_MAX) return void toast(`A card takes ${TODO_SUBTASKS_MAX} subtasks at most`, 'warn');
    addSub.value = '';
    setSubs([...was, { id: newTodoId(), text: t, done: false }]);
  });

  // Notes: free text, sent as you type.
  const notes = h('textarea.todo-notes', { rows: 3, maxlength: TODO_NOTES_MAX, placeholder: 'Notes… (paste or drop a picture here too)', 'aria-label': 'Notes', 'data-keep': `${key}:notes` });
  notes.value = typing.get(key)?.value ?? item.notes ?? '';
  const sendNotes = () => {
    const t = typing.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    typing.delete(key);
    t.send();
  };
  notes.addEventListener('input', () => {
    const value = notes.value;
    const was = typing.get(key);
    if (was) clearTimeout(was.timer);
    const send = () => change({ action: 'details', id: item.id, notes: value });
    typing.set(key, { value, send, timer: setTimeout(sendNotes, 700) });
  });
  notes.addEventListener('blur', sendNotes);
  // Grows with what's in it, up to a point.
  const fit = () => {
    notes.style.height = 'auto';
    notes.style.height = `${Math.min(260, notes.scrollHeight + 4)}px`;
  };
  notes.addEventListener('input', fit);
  requestAnimationFrame(fit);

  // Pictures: thumbnails that open full size, ✕ to take one off, and a button (or paste, or drop) to add.
  const pics = h('div.todo-pics');
  for (const id of images) {
    const x = h('button.btn.todo-mini.todo-pic-x', { type: 'button', title: 'Take this picture off', 'aria-label': 'Remove picture' }, '✕');
    x.addEventListener('click', (e) => {
      e.preventDefault();
      change({ action: 'details', id: item.id, images: (now(board, item.id)?.images ?? []).filter((p) => p !== id) });
    });
    pics.append(h('a.todo-pic', { href: todoImageUrl(id), target: '_blank', rel: 'noopener', title: 'Open it full size' }, h('img', { src: todoImageUrl(id), alt: 'Picture on this card', loading: 'lazy' }), x));
  }
  const busy = uploading.get(key) ?? 0;
  if (busy) pics.append(h('span.todo-pic-busy', {}, `Uploading ${busy}…`));
  const addPics = async (files: File[]) => {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return;
    const room = TODO_IMAGES_MAX - (now(board, item.id)?.images?.length ?? 0) - (uploading.get(key) ?? 0);
    if (room <= 0) return void toast(`A card takes ${TODO_IMAGES_MAX} pictures at most`, 'warn');
    const batch = pictures.slice(0, room);
    uploading.set(key, (uploading.get(key) ?? 0) + batch.length);
    const redraw = () => store.emit(board === 'autonomous' ? 'autonomous' : 'todos');
    redraw(); // to say they're on their way
    for (const file of batch) {
      try {
        const id = await uploadTodoImage(file);
        const card = now(board, item.id);
        if (card) change({ action: 'details', id: item.id, images: [...(card.images ?? []), id] });
      } catch (err) {
        toast(`🖼 ${(err as Error).message}`, 'error');
      } finally {
        const left = (uploading.get(key) ?? 1) - 1;
        if (left > 0) uploading.set(key, left);
        else uploading.delete(key);
      }
    }
    // One more, for the "Uploading…" to go.
    redraw();
  };
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  file.addEventListener('change', () => {
    void addPics([...(file.files ?? [])]);
    file.value = '';
  });
  const addPic = h('button.btn.todo-mini.todo-pic-add', { type: 'button', title: 'Put a picture on this card (or paste one into the notes)' }, '🖼 Add picture');
  addPic.addEventListener('click', () => file.click());

  const el = h(
    'div.todo-details',
    {},
    h('div.todo-details-head', {}, h('span', {}, '☑ Subtasks'), subtasks.length ? h('span.todo-sub-count', { class: done === subtasks.length ? 'all' : '' }, `${done}/${subtasks.length}`) : null),
    subList,
    addSub,
    h('div.todo-details-head', {}, h('span', {}, '📝 Notes')),
    notes,
    h('div.todo-details-head', {}, h('span', {}, '🖼 Pictures'), addPic, file),
    pics,
  );
  el.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void addPics(files);
  });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('todo-drop-pic');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('todo-drop-pic');
  });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('todo-drop-pic');
    void addPics([...e.dataTransfer.files]);
  });
  return el;
}
