import './notes.css';
import {
  allLinks,
  FOLDER_NAME_MAX,
  hasFolder,
  IMAGES_PER_NOTE,
  isBlank,
  isJustALink,
  linkLabel,
  linksIn,
  newNoteId,
  NOTE_FOLDERS,
  NOTE_IMAGE_MAX_BYTES,
  NOTE_TEXT_MAX,
  notePreview,
  notesIn,
  noteTitle,
  TRASH_DAYS,
  type NoteAction,
  type NoteItem,
  type NoteLink,
} from '../../shared/notes';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo, toast } from './dom';
import { changeNote, draftOf, forgetDraft, keepDraft, onNoteDrafts, unsavedNotes, watchNoteDrafts } from './note-drafts';

/** How many 🔗 Links to watch aren't marked watched yet, for the top bar. */
export function linksToWatch(): number {
  return allLinks(store.notes).filter((l) => !l.watched).length;
}

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
const FOLDER_KEY = 'agent-office.notes.folder';
const OPEN_KEY = 'agent-office.notes.open';

const TITLE_MAX = 200;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** A picture too big for a note (or of a kind it can't have) is redrawn as a JPEG this wide, at most. */
const SHRINK_TO = 2400;

type LinkView = 'towatch' | 'watched' | 'all';

/** When, as a phone's notes app says it: the time today, Yesterday, the day this week, else the date. */
function when(t: number): string {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - t < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** A badge for where a link goes. */
function siteIcon(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '🔗';
  }
  const on = (...sites: string[]) => sites.some((s) => host === s || host.endsWith(`.${s}`));
  if (on('youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv')) return '▶️';
  if (on('x.com', 'twitter.com')) return '𝕏';
  if (on('tiktok.com', 'instagram.com')) return '📱';
  if (on('spotify.com', 'soundcloud.com', 'podcasts.apple.com')) return '🎧';
  if (on('github.com')) return '🐙';
  if (on('reddit.com')) return '👽';
  return '🔗';
}

const imageUrl = (id: string) => `/api/notes/image?id=${encodeURIComponent(id)}`;

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** A picture as it goes up to the office: as it is, or redrawn smaller as a JPEG when it's too big or of another kind. */
async function pictureData(file: File): Promise<string> {
  if (IMAGE_TYPES.includes(file.type) && file.size <= NOTE_IMAGE_MAX_BYTES) return readAsDataURL(file);
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, SHRINK_TO / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}

/** Puts a picture in the office's keeping; its name, or null (after saying what went wrong). */
async function uploadPicture(file: File): Promise<string | null> {
  try {
    const dataURL = await pictureData(file);
    const res = await fetch('/api/notes/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataURL }) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (res.ok && body.id) return body.id;
    toast(body.error ?? 'Couldn’t add that picture', 'warn');
  } catch {
    toast(`Couldn’t add ${file.name || 'that picture'}: it isn’t a picture this browser can read, or the office is out of reach`, 'warn');
  }
  return null;
}

export interface NotesPad {
  el: HTMLElement;
  /** Puts the cursor where it's wanted: in the open note, or on New note. */
  focus(): void;
  /** Saves what's typed, and lets go of a new note left empty. */
  flush(): void;
  destroy(): void;
}

/** The note open on the right, and what's typed in it that the office hasn't got yet. */
interface Editor {
  id: string;
  /** Where it goes if it has to be made again (it never reached the office). */
  folder: string;
  title: HTMLInputElement;
  body: HTMLTextAreaElement;
  /** Typing not handed to the drafts yet (see note-drafts.ts): it goes a moment after you stop. */
  timer?: ReturnType<typeof setTimeout>;
  /** Saved at least once since it was opened, so the status has something to say. */
  touched: boolean;
  tools: HTMLElement;
  status: HTMLElement;
  links: HTMLElement;
  images: HTMLElement;
  /** Pictures on their way up. */
  adding: number;
}

/**
 * Your own 📝 Notes pad, on the other side of the 🔥 To Do board and the same on every floor. Like a
 * phone's notes app: the folders down the side (📝 Notes, 🔗 Links to watch, your own, and 🗑️ Recently
 * deleted), the notes in the one picked, and the note open on the right. The first line is its title.
 * Paste or drop pictures in, or pick them with 🖼️. Every link goes to 🔗 Links to watch: paste one there,
 * and the ones written in any note show up there too, to tick off as you watch them.
 */
export function mountNotesPad(net: Net): NotesPad {
  const saved = read(FOLDER_KEY) ?? 'notes';
  let folder = saved === 'trash' || hasFolder(store.notes, saved) ? saved : 'notes';
  let query = '';
  let linkView: LinkView = 'towatch';
  /** On a narrow screen one pane shows at a time. */
  let pane: 'side' | 'list' | 'editor' = 'list';
  let naming = false;
  /** The folder being renamed, and the box its new name goes in. */
  let renaming: { id: string; box: HTMLInputElement } | undefined;
  let ed: Editor | undefined;
  watchNoteDrafts(net);

  const change = (a: NoteAction) => changeNote(net, a);
  const offline = () => toast('Not connected to the office right now — try again once it’s back', 'warn');
  const find = (id: string) => store.notes.notes.find((n) => n.id === id);
  const folderName = (id: string) => (id === 'trash' ? 'Recently deleted' : id === 'notes' || id === 'links' ? NOTE_FOLDERS[id] : store.notes.folders.find((f) => f.id === id)?.name ?? 'Notes');
  const folderIcon = (id: string) => (id === 'notes' ? '🗒️' : id === 'links' ? '🔗' : id === 'trash' ? '🗑️' : '📁');

  // ---- The directory down the side ----------------------------------------------------------

  const search = h('input.notes-search', { type: 'search', placeholder: '🔍 Search', 'aria-label': 'Search notes', maxlength: 100 });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderList();
  });
  const folders = h('ul.notes-folders', { 'aria-label': 'Folders' });
  const newFolderInput = h('input.notes-folder-name', { type: 'text', maxlength: FOLDER_NAME_MAX, placeholder: 'New folder name', 'aria-label': 'New folder name' });
  const newFolderBtn = h('button.btn.notes-newfolder', { type: 'button', title: 'Make a folder of your own', onclick: () => ((naming = true), renderSide(), newFolderInput.focus()) }, '＋ New folder');
  newFolderInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const name = newFolderInput.value.replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (!net.up) return offline();
    const id = newNoteId();
    if (!change({ action: 'folder.add', id, name })) return toast('Couldn’t make that folder: there are as many as there can be', 'warn');
    naming = false;
    newFolderInput.value = '';
    pick(id);
  });
  newFolderInput.addEventListener('blur', () => {
    if (!newFolderInput.value.trim()) setTimeout(() => ((naming = false), renderSide()), 0);
  });
  const side = h('aside.notes-side', { 'aria-label': 'Folders' }, search, folders, h('div.notes-side-foot', {}));

  function folderRow(id: string, count: string, extra?: HTMLElement | null): HTMLElement {
    const on = !query && id === folder;
    const btn = h(
      'button.notes-folder',
      { type: 'button', 'data-folder': id, 'aria-current': on ? 'true' : undefined, title: id === 'links' ? 'Every link: the ones you add here and the ones written in your notes' : id === 'trash' ? `Deleted notes stay here for ${TRASH_DAYS} days` : undefined, onclick: () => pick(id) },
      h('span.notes-folder-icon', { 'aria-hidden': 'true' }, folderIcon(id)),
      h('span.notes-folder-label', {}, folderName(id)),
      h('span.notes-folder-count', {}, count),
    );
    // Drag a note onto a folder to put it there (or onto 🗑️ to delete it).
    btn.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('application/x-agent-office-note')) return;
      e.preventDefault();
      btn.classList.add('notes-drop');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('notes-drop'));
    btn.addEventListener('drop', (e) => {
      const noteId = e.dataTransfer?.getData('application/x-agent-office-note');
      btn.classList.remove('notes-drop');
      if (!noteId) return;
      e.preventDefault();
      if (ed?.id === noteId) save();
      if (!net.up) return offline();
      change(id === 'trash' ? { action: 'delete', id: noteId } : { action: 'move', id: noteId, folder: id });
    });
    if (id !== 'notes' && id !== 'links' && id !== 'trash') btn.addEventListener('dblclick', () => startRename(id));
    return h('li', { class: on ? 'on' : '' }, btn, extra ?? null);
  }

  function startRename(id: string) {
    const f = store.notes.folders.find((x) => x.id === id);
    if (!f) return;
    const box = h('input.notes-rename', { type: 'text', maxlength: FOLDER_NAME_MAX, 'aria-label': `Rename ${f.name}` });
    box.value = f.name;
    const finish = () => {
      if (renaming?.box !== box) return;
      renaming = undefined;
      const name = box.value.replace(/\s+/g, ' ').trim();
      const now = store.notes.folders.find((x) => x.id === id);
      if (now && name && name !== now.name && !change({ action: 'folder.rename', id, name }) && !net.up) offline();
      renderSide();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), finish());
    });
    box.addEventListener('blur', () => setTimeout(() => !box.isConnected || document.activeElement !== box ? finish() : undefined, 0));
    renaming = { id, box };
    renderSide();
    box.focus();
    box.select();
  }

  function renderSide() {
    const s = store.notes;
    const live = (f: string) => notesIn(s, f).length;
    const toWatch = allLinks(s).filter((l) => !l.watched).length;
    const rows: HTMLElement[] = [folderRow('notes', String(live('notes'))), folderRow('links', String(toWatch))];
    for (const f of s.folders) {
      if (renaming?.id === f.id) {
        rows.push(h('li.renaming', {}, renaming.box));
        continue;
      }
      const tools = h(
        'span.notes-folder-tools',
        {},
        h('button.notes-icon-btn', { type: 'button', title: `Rename ${f.name}`, 'aria-label': `Rename ${f.name}`, onclick: () => startRename(f.id) }, '✏️'),
        h('button.notes-icon-btn', { type: 'button', title: `Remove ${f.name} (its notes go to Recently deleted)`, 'aria-label': `Remove ${f.name}`, onclick: () => removeFolder(f.id) }, '✕'),
      );
      rows.push(folderRow(f.id, String(live(f.id)), tools));
    }
    rows.push(h('li.notes-folders-gap', { 'aria-hidden': 'true' }), folderRow('trash', String(live('trash'))));
    folders.replaceChildren(...rows);
    const foot = side.querySelector('.notes-side-foot')!;
    const want = naming ? newFolderInput : newFolderBtn;
    if (foot.firstChild !== want) foot.replaceChildren(want);
  }

  function removeFolder(id: string) {
    if (!net.up) return offline();
    const n = notesIn(store.notes, id).length;
    const name = folderName(id);
    if (ed && find(ed.id)?.folder === id) save();
    if (!change({ action: 'folder.remove', id })) return;
    if (folder === id) pick('notes');
    toast(n ? `Removed ${name}: its ${n === 1 ? 'note is' : `${n} notes are`} in Recently deleted` : `Removed ${name}`);
  }

  /** Shows `id`'s notes. */
  function pick(id: string) {
    folder = id;
    write(FOLDER_KEY, id);
    if (query) search.value = query = '';
    pane = 'list';
    render();
    // The note that was open stays open while it's in there; else the first one opens (on a wide screen).
    const inIt = ed && folderHas(id, ed.id);
    if (!inIt) {
      const first = id === 'links' ? allLinks(store.notes).find(showsLink)?.noteId : notesIn(store.notes, id)[0]?.id;
      if (first && !narrow()) openNote(first, false);
      else if (!first) closeEditor();
    }
  }

  const folderHas = (id: string, noteId: string) => {
    const n = find(noteId);
    if (!n) return false;
    if (id === 'trash') return n.deletedAt !== undefined;
    if (id === 'links') return n.deletedAt === undefined && (n.folder === 'links' || linksIn(n.text).length > 0);
    return n.deletedAt === undefined && n.folder === id;
  };
  const narrow = () => el.clientWidth > 0 && el.clientWidth < 760;

  // ---- The list in the middle ---------------------------------------------------------------

  const listHead = h('div.notes-list-head');
  const linkAdd = h('input.notes-linkadd', { type: 'text', maxlength: 2000, placeholder: 'Paste a link to watch, then Enter', 'aria-label': 'Add a link to watch' });
  linkAdd.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (addLink(linkAdd.value)) linkAdd.value = '';
  });
  const list = h('ul.notes-list', { 'aria-label': 'Notes' });
  const unsavedBar = h('div.notes-unsaved-bar', { role: 'status', hidden: true });
  const listPane = h('section.notes-listpane', {}, unsavedBar, listHead, list);

  /** A new note in 🔗 Links to watch for what's pasted: the link, and any words with it. */
  function addLink(raw: string): boolean {
    const text = raw.trim();
    const links = linksIn(text);
    if (!links.length) {
      toast('That doesn’t look like a link: paste one that starts with https://', 'warn');
      return false;
    }
    const there = allLinks(store.notes).find((l) => l.url === links[0]);
    if (there && links.length === 1) {
      toast(there.watched ? 'That link is already here, marked watched' : 'That link is already in Links to watch');
      if (there.watched) linkView = 'all';
      renderList();
      list.querySelector<HTMLElement>(`[data-url="${CSS.escape(there.url)}"]`)?.focus();
      return true;
    }
    if (!net.up) return (offline(), false);
    const id = newNoteId();
    // Just a link: its note starts with an empty title, for what it is.
    change({ action: 'add', id, folder: 'links', text: isJustALink(text) ? `\n${links[0]}` : text });
    linkView = linkView === 'watched' ? 'towatch' : linkView;
    renderList();
    return true;
  }

  const showsLink = (l: NoteLink) => linkView === 'all' || (linkView === 'watched') === l.watched;

  function renderLinks(): HTMLElement[] {
    const links = allLinks(store.notes);
    const count = (v: LinkView) => links.filter((l) => v === 'all' || (v === 'watched') === l.watched).length;
    const tab = (v: LinkView, label: string) =>
      h('button.btn.notes-tab', { type: 'button', 'aria-pressed': String(linkView === v), onclick: () => ((linkView = v), renderList()) }, `${label} ${count(v)}`);
    listHead.replaceChildren(
      h('div.notes-list-title', {}, h('h3', {}, '🔗 Links to watch'), narrowBack('side', '‹ Folders')),
      linkAdd,
      h('div.notes-tabs', { role: 'group', 'aria-label': 'Show' }, tab('towatch', 'To watch'), tab('watched', 'Watched'), tab('all', 'All')),
    );
    const shown = links.filter(showsLink);
    if (!shown.length) {
      const empty = linkView === 'watched' ? 'Nothing marked watched yet.' : links.length ? 'All watched. 🎉' : 'Paste a link above. Links you write in any note show up here too.';
      return [h('li.notes-empty', {}, empty)];
    }
    return shown.map((l) => {
      const note = find(l.noteId);
      const where = l.saved ? '' : `in ${folderIcon(l.folder)} ${noteTitle(note?.text ?? '') || 'a note'}`;
      const row = h(
        'li.notes-link',
        { 'data-url': l.url, 'data-id': l.noteId, tabindex: 0, class: `${l.watched ? 'watched' : ''} ${ed?.id === l.noteId ? 'on' : ''}`, title: 'Click to open its note · the title opens the link' },
        h(
          'button.notes-watch',
          { type: 'button', 'aria-pressed': String(l.watched), title: l.watched ? 'Watched — click to put it back on To watch' : 'Mark it watched', 'aria-label': l.watched ? `Watched: ${l.title}` : `Mark watched: ${l.title}`, onclick: (e: Event) => (e.stopPropagation(), net.up ? change({ action: 'watched', url: l.url, watched: !l.watched }) : offline()) },
          l.watched ? '✓' : '',
        ),
        h(
          'div.notes-link-main',
          {},
          h('a.notes-link-title', { href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url, onclick: (e: Event) => e.stopPropagation() }, `${siteIcon(l.url)} ${l.title}`),
          h('div.notes-link-sub', {}, h('span', {}, linkLabel(l.url)), where ? h('span.notes-link-where', {}, where) : null, h('span', {}, timeAgo(l.at))),
        ),
      );
      row.addEventListener('click', () => openNote(l.noteId, false));
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter') (e.preventDefault(), openNote(l.noteId, 'body'));
        else if (e.key === ' ') (e.preventDefault(), net.up ? change({ action: 'watched', url: l.url, watched: !l.watched }) : offline());
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling)?.closest<HTMLElement>('.notes-link')?.focus();
        }
      });
      return row;
    });
  }

  function noteRow(n: NoteItem, showFolder: boolean): HTMLElement {
    const draft = draftOf(n.id);
    const text = draft ?? n.text;
    const title = noteTitle(text) || (n.images.length ? 'Picture' : 'New note');
    const preview = notePreview(text);
    const row = h(
      'li.notes-row',
      { 'data-id': n.id, tabindex: 0, draggable: 'true', class: ed?.id === n.id ? 'on' : '', title: 'Drag onto a folder to move it' },
      h('div.notes-row-title', {}, draft !== undefined ? h('span.notes-unsaved', { title: 'Not saved yet: kept in this browser until the office has it' }, '⚠️ ') : null, n.pinned ? h('span.notes-pin', { title: 'Pinned' }, '📌 ') : null, title),
      h(
        'div.notes-row-sub',
        {},
        h('span.notes-row-when', {}, when(folder === 'trash' && !query ? n.deletedAt ?? n.editedAt : n.editedAt)),
        h('span.notes-row-preview', {}, preview || (n.images.length ? '' : 'No additional text')),
        n.images.length ? h('span.notes-row-pics', { title: `${n.images.length} picture${n.images.length === 1 ? '' : 's'}` }, `🖼️ ${n.images.length}`) : null,
        linksIn(n.text).length ? h('span.notes-row-pics', { title: 'Has links: they’re in Links to watch too' }, '🔗') : null,
      ),
      showFolder ? h('div.notes-row-folder', {}, `${folderIcon(n.deletedAt !== undefined ? 'trash' : n.folder)} ${folderName(n.deletedAt !== undefined ? 'trash' : n.folder)}`) : null,
    );
    row.addEventListener('click', () => openNote(n.id, false));
    row.addEventListener('dragstart', (e) => {
      if (ed?.id === n.id) save();
      e.dataTransfer?.setData('application/x-agent-office-note', n.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter') (e.preventDefault(), openNote(n.id, 'body'));
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const next = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null;
        deleteNote(n.id);
        if (next?.dataset.id) list.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.dataset.id)}"]`)?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const to = (e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
        if (to?.dataset.id) {
          openNote(to.dataset.id, false);
          list.querySelector<HTMLElement>(`[data-id="${CSS.escape(to.dataset.id)}"]`)?.focus();
        }
      }
    });
    return row;
  }

  /** On a narrow screen, the way back to the pane before. */
  const narrowBack = (to: 'side' | 'list', label: string) => h('button.btn.notes-back', { type: 'button', onclick: () => ((pane = to), paintPane()) }, label);

  function renderList() {
    const s = store.notes;
    const inHead = document.activeElement instanceof HTMLInputElement && listHead.contains(document.activeElement) ? document.activeElement : null;
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.url ? `[data-url="${CSS.escape(focused.dataset.url)}"]` : focused?.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : null;
    const { scrollTop } = list;
    let rows: HTMLElement[];
    if (query) {
      const found = s.notes.filter((n) => n.deletedAt === undefined && n.text.toLowerCase().includes(query)).sort((a, b) => b.editedAt - a.editedAt);
      listHead.replaceChildren(h('div.notes-list-title', {}, h('h3', {}, `🔍 ${found.length} found`), narrowBack('side', '‹ Folders')));
      rows = found.length ? found.map((n) => noteRow(n, true)) : [h('li.notes-empty', {}, 'No notes have that in them.')];
    } else if (folder === 'links') {
      rows = renderLinks();
    } else {
      const notes = notesIn(s, folder);
      const trash = folder === 'trash';
      listHead.replaceChildren(
        h(
          'div.notes-list-title',
          {},
          h('h3', {}, `${folderIcon(folder)} ${folderName(folder)}`),
          h('span.notes-list-count', {}, `${notes.length} note${notes.length === 1 ? '' : 's'}`),
          narrowBack('side', '‹ Folders'),
          trash
            ? notes.length
              ? h('button.btn.notes-mini', { type: 'button', title: 'Delete everything in here for good', onclick: () => (net.up ? change({ action: 'empty' }) : offline()) }, 'Empty')
              : null
            : h('button.btn.notes-new', { type: 'button', title: 'New note', 'aria-label': 'New note', onclick: () => newNote() }, '✏️ New note'),
        ),
        ...(trash ? [h('p.notes-hint', {}, `Deleted notes stay here for ${TRASH_DAYS} days. Open one to put it back.`)] : []),
      );
      rows = notes.length ? notes.map((n) => noteRow(n, false)) : [h('li.notes-empty', {}, trash ? 'Nothing deleted.' : 'No notes here yet. ✏️ New note starts one.')];
    }
    list.replaceChildren(...rows);
    list.scrollTop = scrollTop;
    if (focusKey) list.querySelector<HTMLElement>(focusKey)?.focus();
    else if (inHead?.isConnected && inHead !== document.activeElement) inHead.focus();
  }

  // ---- The note on the right ----------------------------------------------------------------

  const editorPane = h('section.notes-editor', { 'aria-label': 'Note' });
  const fileInput = h('input.notes-file', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-label': 'Add pictures' });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void addPictures(files);
  });
  const compose = (e: Editor) => (e.body.value ? `${e.title.value}\n${e.body.value}` : e.title.value);

  function closeEditor() {
    leave();
    write(OPEN_KEY, '');
    editorPane.replaceChildren(
      h('div.notes-blank', {}, h('div.notes-blank-icon', { 'aria-hidden': 'true' }, '🗒️'), h('p', {}, folder === 'links' && !query ? 'Pick a link to see its note.' : 'Pick a note, or start a new one.'), folder !== 'trash' && folder !== 'links' ? h('button.btn', { type: 'button', onclick: () => newNote() }, '✏️ New note') : null),
    );
    if (pane === 'editor') pane = 'list';
    paintPane();
  }

  /** Leaves the open note: saved, and gone if nothing was ever put in it. */
  function leave() {
    if (!ed) return;
    const was = ed;
    save();
    clearTimeout(was.timer);
    ed = undefined;
    const n = find(was.id);
    if (n && n.deletedAt === undefined && isBlank(n) && draftOf(n.id) === undefined && !was.adding) change({ action: 'delete', id: n.id });
  }

  function newNote(text = '') {
    if (!net.up) return offline();
    // Links to watch are added by pasting a link; a note started from there (for a picture, say) goes in Notes.
    const into = folder === 'trash' || folder === 'links' || query ? 'notes' : folder;
    const id = newNoteId();
    leave();
    if (!change({ action: 'add', id, folder: into, text })) return toast('Couldn’t start a note: the pad is full', 'warn');
    if (query) search.value = query = '';
    if (folder !== into) {
      folder = into;
      write(FOLDER_KEY, into);
    }
    openNote(id, 'title');
    render();
  }

  function deleteNote(id: string) {
    if (!net.up) return offline();
    const n = find(id);
    if (!n) return;
    if (ed?.id === id) save();
    const forGood = n.deletedAt !== undefined;
    if (ed?.id === id) {
      clearTimeout(ed.timer);
      ed = undefined;
    }
    change({ action: 'delete', id });
    forgetDraft(id);
    if (!isBlank(n)) toast(forGood ? 'Deleted for good' : `Moved to Recently deleted (kept ${TRASH_DAYS} days)`);
    if (!find(id) || !folderHas(folder, id)) closeEditor();
    else openNote(id, false);
  }

  /** Opens note `id` on the right; `focus` puts the cursor in its title or text. */
  function openNote(id: string, focus: 'title' | 'body' | false) {
    const n = find(id);
    if (!n) return;
    if (ed?.id !== id) {
      leave();
      ed = buildEditor(n);
      write(OPEN_KEY, id);
    }
    pane = 'editor';
    paintPane();
    list.querySelectorAll('.on').forEach((r) => r.classList.remove('on'));
    list.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(id)}"]`).forEach((r) => r.classList.add('on'));
    if (focus === 'title') ed.title.focus();
    else if (focus === 'body') {
      ed.body.focus();
      ed.body.setSelectionRange(ed.body.value.length, ed.body.value.length);
    }
  }

  function buildEditor(n: NoteItem): Editor {
    // What's typed and not saved yet comes back with it.
    const [first, ...rest] = (draftOf(n.id) ?? n.text).split('\n');
    const title = h('input.notes-title', { type: 'text', maxlength: TITLE_MAX, placeholder: 'Title', 'aria-label': 'Title' });
    const body = h('textarea.notes-body', { maxlength: NOTE_TEXT_MAX - TITLE_MAX - 1, placeholder: 'Write anything. Paste links and pictures too.', 'aria-label': 'Note' });
    title.value = first;
    body.value = rest.join('\n');
    const e: Editor = { id: n.id, folder: n.folder, title, body, touched: false, tools: h('div.notes-tools'), status: h('span.notes-status', { 'aria-live': 'polite' }), links: h('div.notes-links'), images: h('div.notes-images'), adding: 0 };
    const typed = () => {
      clearTimeout(e.timer);
      e.timer = setTimeout(() => ((e.timer = undefined), save()), 600);
      e.touched = true;
      paintStatus(e);
      paintLinks(e);
    };
    title.addEventListener('input', typed);
    body.addEventListener('input', typed);
    title.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        // Enter in the title carries on in the text, as on a phone.
        const at = title.selectionStart ?? title.value.length;
        const tail = title.value.slice(at);
        if (tail) {
          title.value = title.value.slice(0, at);
          body.value = body.value ? `${tail}\n${body.value}` : tail;
          typed();
        }
        body.focus();
        body.setSelectionRange(0, 0);
      }
    });
    title.addEventListener('blur', () => save());
    body.addEventListener('blur', () => save());
    for (const box of [title, body] as HTMLElement[]) {
      box.addEventListener('paste', (ev) => {
        const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        ev.preventDefault();
        void addPictures(files);
      });
    }
    editorPane.replaceChildren(h('div.notes-sheet', {}, e.tools, title, body, e.links, e.images));
    paintEditor(e, n);
    paintStatus(e);
    return e;
  }

  /** The note's toolbar, links and pictures, as it is now. */
  function paintEditor(e: Editor, n: NoteItem) {
    const trash = n.deletedAt !== undefined;
    e.title.readOnly = e.body.readOnly = trash;
    const tool = (label: string, title: string, run: () => void, cls = '') => h(`button.btn.notes-tool${cls}` as `button.${string}`, { type: 'button', title, 'aria-label': title, onclick: run }, label);
    const edited = trash ? `Deleted ${when(n.deletedAt!)} · from ${folderIcon(n.folder)} ${folderName(hasFolder(store.notes, n.folder) ? n.folder : 'notes')}` : n.editedAt > n.at + 1000 ? `Edited ${when(n.editedAt)}` : `Made ${when(n.at)}`;
    let tools: HTMLElement[];
    if (trash) {
      tools = [
        tool('↩ Put it back', 'Put it back where it was', () => {
          if (!net.up) return offline();
          change({ action: 'restore', id: n.id });
          const back = find(n.id);
          if (back) {
            pick(back.folder);
            openNote(back.id, false);
          }
        }),
        tool('Delete for good', 'Delete it for good', () => deleteNote(n.id), '.notes-danger'),
      ];
    } else {
      const move = h('select.notes-move', { 'aria-label': 'Folder', title: 'Which folder it’s in' });
      for (const [id, name] of [['notes', NOTE_FOLDERS.notes], ['links', NOTE_FOLDERS.links], ...store.notes.folders.map((f) => [f.id, f.name])]) move.append(h('option', { value: id }, `${folderIcon(id)} ${name}`));
      move.value = n.folder;
      move.addEventListener('change', () => {
        save();
        if (!net.up) return ((move.value = n.folder), offline());
        change({ action: 'move', id: n.id, folder: move.value });
      });
      tools = [
        move,
        tool(n.pinned ? '📌 Unpin' : '📌 Pin', n.pinned ? 'Unpin it' : 'Pin it to the top of its folder', () => (net.up ? change({ action: 'pin', id: n.id, pinned: !n.pinned }) : offline()), n.pinned ? '.notes-on' : ''),
        tool('🖼️ Picture', `Add pictures (or paste or drop them in) — up to ${IMAGES_PER_NOTE}`, () => fileInput.click()),
        tool('🗑️', 'Delete it (to Recently deleted)', () => deleteNote(n.id)),
      ];
    }
    e.tools.replaceChildren(narrowBack('list', '‹ Notes'), h('div.notes-when', {}, h('span.notes-edited', {}, edited), e.status), ...tools);
    paintLinks(e);
    const shown = [...e.images.querySelectorAll<HTMLElement>('[data-image]')].map((x) => x.dataset.image).join();
    if (shown !== n.images.join()) {
      e.images.replaceChildren(
        ...n.images.map((id) =>
          h(
            'figure.notes-image',
            { 'data-image': id },
            h('a', { href: imageUrl(id), target: '_blank', rel: 'noopener', title: 'Open it full size' }, h('img', { src: imageUrl(id), alt: 'A picture in this note', loading: 'lazy' })),
            trash ? null : h('button.notes-image-x', { type: 'button', title: 'Take this picture out of the note', 'aria-label': 'Remove picture', onclick: () => (net.up ? change({ action: 'edit', id: n.id, images: n.images.filter((x) => x !== id) }) : offline()) }, '✕'),
          ),
        ),
      );
    }
  }

  /** The links written in the note, as links you can click. */
  function paintLinks(e: Editor) {
    const links = linksIn(compose(e));
    const key = links.join('\n');
    if (e.links.dataset.key === key) return;
    e.links.dataset.key = key;
    e.links.replaceChildren(
      ...(links.length ? [h('span.notes-links-label', { title: 'Every link is in 🔗 Links to watch too' }, '🔗 Links')] : []),
      ...links.map((url) => h('a.notes-chip', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, `${siteIcon(url)} ${linkLabel(url)}`)),
    );
  }

  /**
   * Hands what's typed in the open note to the drafts (see note-drafts.ts), which keep it (in this
   * browser too) and send it, again after a reconnect, until the office has it. Leaving the note, or
   * closing the board, can't lose it then, even while the office is out of reach.
   */
  function save() {
    const e = ed;
    if (!e) return;
    clearTimeout(e.timer);
    e.timer = undefined;
    const n = find(e.id);
    if (n?.deletedAt !== undefined) return;
    const text = compose(e);
    if (draftOf(e.id) !== undefined || !n || n.text !== text) keepDraft(e.id, e.folder, text);
    paintStatus(e);
  }

  /** Whether what's typed is with the office yet. */
  function paintStatus(e: Editor) {
    if (e.adding) return;
    const unsaved = e.timer !== undefined || draftOf(e.id) !== undefined;
    e.status.classList.toggle('notes-status-warn', unsaved && !net.up);
    e.status.textContent = !unsaved ? (e.touched ? 'Saved' : '') : !net.up ? '⚠️ Not saved yet: the office is out of reach. What you typed is kept in this browser and saves when the office is back.' : 'Saving…';
  }

  /** Says, above the list, that notes are waiting for the office. */
  function paintUnsaved() {
    const n = unsavedNotes();
    unsavedBar.hidden = !n || net.up;
    unsavedBar.textContent = `⚠️ ${n === 1 ? '1 note isn’t' : `${n} notes aren’t`} saved yet. ${n === 1 ? 'It’s' : 'They’re'} kept in this browser and ${n === 1 ? 'saves' : 'save'} when the office is back.`;
  }

  /** Puts pictures in the open note (or a new one). */
  async function addPictures(files: File[]) {
    files = files.filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!net.up) return offline();
    if (!ed || find(ed.id)?.deletedAt !== undefined) newNote();
    const e = ed;
    if (!e) return;
    save();
    e.adding++;
    e.status.classList.remove('notes-status-warn');
    e.status.textContent = files.length > 1 ? `Adding ${files.length} pictures…` : 'Adding the picture…';
    try {
      for (const file of files) {
        const n = find(e.id);
        if (!n) break;
        if (n.images.length >= IMAGES_PER_NOTE) {
          toast(`A note can have ${IMAGES_PER_NOTE} pictures at most`, 'warn');
          break;
        }
        const id = await uploadPicture(file);
        const now = find(e.id);
        if (id && now && !now.images.includes(id) && !change({ action: 'edit', id: e.id, images: [...now.images, id] }) && !net.up) {
          toast('Couldn’t put the picture in the note: the office is out of reach. Add it again once it’s back.', 'warn');
          break;
        }
      }
    } finally {
      e.adding--;
      if (ed === e) paintStatus(e);
    }
  }

  /** Brings the open note up to date with the pad: a change to it from another window. */
  function syncEditor() {
    const e = ed;
    if (!e) return;
    const n = find(e.id);
    const typing = e.timer !== undefined || draftOf(e.id) !== undefined;
    if (!n) {
      // Gone (for good, from another window): unless there's typing here that would go with it.
      if (!typing) {
        ed = undefined;
        closeEditor();
      }
      return;
    }
    // What's typed here and not with the office yet wins; otherwise the pad's copy is the one.
    if (!typing && compose(e) !== n.text) {
      const [first, ...rest] = n.text.split('\n');
      e.title.value = first;
      e.body.value = rest.join('\n');
    }
    paintEditor(e, n);
    paintStatus(e);
  }

  // ---- Putting it together -------------------------------------------------------------------

  const el = h('div.notes-pad', {}, side, listPane, editorPane, fileInput);
  const paintPane = () => (el.dataset.pane = pane);
  // Pictures dropped anywhere on the pad go in the open note; links dropped go to Links to watch.
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes('Files') || types.includes('text/uri-list')) e.preventDefault();
  });
  el.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || dt.types.includes('application/x-agent-office-note')) return;
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void addPictures(files);
      return;
    }
    const url = dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
    if (url && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      addLink(url);
    }
  });
  // New note from anywhere on the pad (but not while typing in one).
  el.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (!typing && (e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey && folder !== 'links' && folder !== 'trash') {
      e.preventDefault();
      e.stopPropagation();
      newNote();
    }
  });

  function render() {
    const typing = document.activeElement;
    renderSide();
    renderList();
    syncEditor();
    paintUnsaved();
    paintPane();
    // A box that was redrawn around (the link box, a folder's new name) keeps the cursor.
    if (typing instanceof HTMLInputElement && typing !== document.activeElement && typing.isConnected && el.contains(typing)) typing.focus();
  }

  const unsub = store.on('notes', render);
  // Drafts coming and going, and the office going and coming back (the lost-connection screen's own state).
  const unsubDrafts = onNoteDrafts(() => {
    renderList();
    if (ed) paintStatus(ed);
    paintUnsaved();
  });
  // Reloading (the lost-connection screen offers it) or closing the tab mid-word still keeps what's typed.
  const onHide = () => save();
  window.addEventListener('pagehide', onHide);
  render();
  const last = read(OPEN_KEY);
  if (last && find(last)) openNote(last, false);
  else if (!narrow()) {
    const first = folder === 'links' ? allLinks(store.notes).find(showsLink)?.noteId : notesIn(store.notes, folder)[0]?.id;
    if (first) openNote(first, false);
    else closeEditor();
  } else closeEditor();
  pane = 'list';
  paintPane();

  return {
    el,
    focus: () => {
      if (ed) ed.body.focus();
      else (listHead.querySelector<HTMLElement>('.notes-new') ?? search).focus();
    },
    flush: () => {
      save();
      const n = ed && find(ed.id);
      if (n && n.deletedAt === undefined && isBlank(n) && draftOf(n.id) === undefined && !ed!.adding) closeEditor();
    },
    destroy: () => {
      leave();
      unsub();
      unsubDrafts();
      window.removeEventListener('pagehide', onHide);
      const n = unsavedNotes();
      if (n && !net.up) toast(`⚠️ ${n === 1 ? 'A note isn’t' : `${n} notes aren’t`} saved yet: kept in this browser, and saved when the office is back`, 'warn');
    },
  };
}
