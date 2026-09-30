// Your own 📝 Notes pad, on the other side of the 🔥 To Do board: notes like a phone's notes app, in
// folders down the side, with pictures and links in them. Like the To Do board it's the building's,
// not a floor's, so it follows you onto every floor. Shared by the office (which keeps it, see
// server/notes.ts) and the browser, which makes each change straight away with applyNote and puts
// the office's answer under it when it comes back.
//
// 🔗 Links to watch is a folder of its own: every link goes there. A link you add is a note in it, and
// the links written in any other note show up there too, so they're all in one place to get through.

/** The folders every pad has; the ones you make go between them. */
export const NOTE_FOLDERS = { notes: 'Notes', links: 'Links to watch' } as const;
export type BuiltInFolder = keyof typeof NOTE_FOLDERS;
/** Notes you deleted stay here (and can come back) for this long, then they go for good. */
export const TRASH_DAYS = 30;
export const NOTE_TEXT_MAX = 20_000;
export const NOTES_LIMIT = 2000;
export const FOLDERS_LIMIT = 50;
export const FOLDER_NAME_MAX = 40;
export const IMAGES_PER_NOTE = 12;
/** A picture in a note, at most (the office keeps it, see server/notes.ts). */
export const NOTE_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const URL_MAX = 2000;
/** Links marked watched that are remembered, at most; the oldest go first. */
export const WATCHED_LIMIT = 2000;

export interface NoteFolder {
  id: string;
  name: string;
  at: number;
}

export interface NoteItem {
  id: string;
  /** 'notes', 'links' or one of your folders. */
  folder: string;
  /** What's written. The first line is its title, as on a phone. */
  text: string;
  /** Pictures, by the name the office keeps them under (see noteImageId). */
  images: string[];
  at: number;
  editedAt: number;
  pinned?: boolean;
  /** When it went to Recently deleted. */
  deletedAt?: number;
}

export interface NotesState {
  /** Your own folders, in the order they were made (Notes and Links to watch are always there). */
  folders: NoteFolder[];
  notes: NoteItem[];
  /** Links you've marked watched, oldest first. */
  watched: string[];
}

export type NoteAction =
  /** A new note. The browser names it, so it can show it before the office answers. */
  | { action: 'add'; id: string; folder: string; text: string; images?: string[] }
  | { action: 'edit'; id: string; text?: string; images?: string[] }
  | { action: 'move'; id: string; folder: string }
  | { action: 'pin'; id: string; pinned: boolean }
  /** To Recently deleted; from there (or when there's nothing in it), gone for good. */
  | { action: 'delete'; id: string }
  | { action: 'restore'; id: string }
  /** Empties Recently deleted. */
  | { action: 'empty' }
  | { action: 'watched'; url: string; watched: boolean }
  | { action: 'folder.add'; id: string; name: string }
  | { action: 'folder.rename'; id: string; name: string }
  /** The folder goes, and its notes go to Recently deleted. */
  | { action: 'folder.remove'; id: string };

export const EMPTY_NOTES: NotesState = { folders: [], notes: [], watched: [] };

const ID_RE = /^[a-z0-9]{6,32}$/;
const IMAGE_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const DAY = 86_400_000;

/** A name for a new note or folder. */
export function newNoteId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

export function isBuiltInFolder(id: string): id is BuiltInFolder {
  return id === 'notes' || id === 'links';
}

/** Whether `folder` is somewhere a note can be in `state`. */
export function hasFolder(state: NotesState, folder: string): boolean {
  return isBuiltInFolder(folder) || state.folders.some((f) => f.id === folder);
}

export function isNoteImage(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_RE.test(value);
}

/** The name a picture is kept under: from a hash of what's in it (hex), and what kind it is. */
export function noteImageId(hashHex: string, type: string): string | null {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
  const id = `${hashHex.slice(0, 32)}.${ext}`;
  return ext && IMAGE_RE.test(id) ? id : null;
}

// ---- Titles and links ---------------------------------------------------------------------------

/** A note's title: its first line with something on it. */
export function noteTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.trim().slice(0, 120) : '';
}

/** What a note says after its title, on one line, for the list. */
export function notePreview(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** A link as found in text, tidied: trailing punctuation off, a closing bracket only if it opened one. */
function tidyLink(raw: string): string | null {
  let url = raw.replace(/[.,;:!?*'"]+$/, '');
  while (/[)\]}]$/.test(url)) {
    const close = url.at(-1)!;
    const open = { ')': '(', ']': '[', '}': '{' }[close]!;
    if (url.split(open).length >= url.split(close).length) break;
    url = url.slice(0, -1).replace(/[.,;:!?*'"]+$/, '');
  }
  if (/^www\./i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.') || url.length > URL_MAX) return null;
    return url;
  } catch {
    return null;
  }
}

/** The web links written in `text`, each once, in the order they come. */
export function linksIn(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) {
    const url = tidyLink(m[0]);
    if (url) seen.add(url);
  }
  return [...seen];
}

/** Whether `text` is nothing but one link, as when one is pasted in. */
export function isJustALink(text: string): boolean {
  const t = text.trim();
  const links = linksIn(t);
  return links.length === 1 && (t === links[0] || `https://${t}` === links[0]);
}

/** A link as it reads in a list: its site and where on it, without the https://www. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const where = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return `${u.hostname.replace(/^www\./, '')}${where.length > 60 ? `${where.slice(0, 59)}…` : where}`;
  } catch {
    return url;
  }
}

export interface NoteLink {
  url: string;
  /** What to call it: the link note's title, or the site. */
  title: string;
  /** The note it's in. */
  noteId: string;
  /** Whether that note is one in 🔗 Links to watch, or a link written in some other note. */
  saved: boolean;
  /** The folder that note is in. */
  folder: string;
  /** When that note was last changed. */
  at: number;
  watched: boolean;
}

/**
 * Every link to watch: the notes in 🔗 Links to watch (newest first), then the links written in your
 * other notes (the most recently changed first). Each link comes once, and deleted notes don't count.
 */
export function allLinks(state: NotesState): NoteLink[] {
  const watched = new Set(state.watched);
  const live = state.notes.filter((n) => n.deletedAt === undefined);
  const newest = (a: NoteItem, b: NoteItem) => b.at - a.at;
  const saved = live.filter((n) => n.folder === 'links').sort(newest);
  const others = live.filter((n) => n.folder !== 'links').sort((a, b) => b.editedAt - a.editedAt);
  const out: NoteLink[] = [];
  const seen = new Set<string>();
  for (const note of [...saved, ...others]) {
    const inLinks = note.folder === 'links';
    for (const url of linksIn(note.text)) {
      if (seen.has(url)) continue;
      seen.add(url);
      // A link note's own words name it; a link in the middle of some other note goes by its site.
      const title = inLinks ? linkNoteTitle(note.text, url) : linkLabel(url);
      out.push({ url, title, noteId: note.id, saved: inLinks, folder: note.folder, at: note.editedAt, watched: watched.has(url) });
    }
  }
  return out;
}

/** What a note in 🔗 Links to watch is called: its first words that aren't a link ("Great talk: https://…"), or the link. */
export function linkNoteTitle(text: string, url = linksIn(text)[0] ?? ''): string {
  for (const line of text.split('\n')) {
    const words = line.replace(LINK_RE, ' ').replace(/\s+/g, ' ').replace(/[\s:|–—-]+$/, '').trim();
    if (words) return words.slice(0, 120);
  }
  return url ? linkLabel(url) : '';
}

/** The notes in `folder` ('trash' for Recently deleted), pinned ones first, then the most recently changed. */
export function notesIn(state: NotesState, folder: string): NoteItem[] {
  const list = folder === 'trash' ? state.notes.filter((n) => n.deletedAt !== undefined) : state.notes.filter((n) => n.deletedAt === undefined && n.folder === folder);
  if (folder === 'trash') return list.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.editedAt - a.editedAt);
}

// ---- Checking what comes in -------------------------------------------------------------------

const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n');
  return text.length <= NOTE_TEXT_MAX ? text : null;
};
const cleanName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  return name && name.length <= FOLDER_NAME_MAX ? name : null;
};
const cleanImages = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > IMAGES_PER_NOTE || !value.every(isNoteImage)) return null;
  return [...new Set(value)];
};
const cleanUrl = (value: unknown): string | null => (typeof value === 'string' && value.length <= URL_MAX && /^https?:\/\/\S+$/i.test(value) ? value : null);

/** A change a browser sent, if it is one. */
export function checkNoteAction(raw: unknown): NoteAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.action === 'empty') return { action: 'empty' };
  if (a.action === 'watched') {
    const url = cleanUrl(a.url);
    return url && typeof a.watched === 'boolean' ? { action: 'watched', url, watched: a.watched } : null;
  }
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return null;
  const id = a.id;
  const folderOk = (f: unknown): f is string => typeof f === 'string' && (isBuiltInFolder(f) || ID_RE.test(f));
  switch (a.action) {
    case 'add': {
      const text = cleanText(a.text);
      const images = a.images === undefined ? [] : cleanImages(a.images);
      if (text === null || !images || !folderOk(a.folder)) return null;
      return { action: 'add', id, folder: a.folder, text, ...(images.length ? { images } : {}) };
    }
    case 'edit': {
      const text = a.text === undefined ? undefined : cleanText(a.text);
      const images = a.images === undefined ? undefined : cleanImages(a.images);
      if (text === null || images === null || (text === undefined && images === undefined)) return null;
      return { action: 'edit', id, ...(text === undefined ? {} : { text }), ...(images === undefined ? {} : { images }) };
    }
    case 'move':
      return folderOk(a.folder) ? { action: 'move', id, folder: a.folder } : null;
    case 'pin':
      return typeof a.pinned === 'boolean' ? { action: 'pin', id, pinned: a.pinned } : null;
    case 'delete':
    case 'restore':
    case 'folder.remove':
      return { action: a.action, id };
    case 'folder.add':
    case 'folder.rename': {
      const name = cleanName(a.name);
      return name ? { action: a.action, id, name } : null;
    }
    default:
      return null;
  }
}

/** A pad read back from disk, as much of it as holds up. */
export function checkNotesState(raw: unknown): NotesState {
  if (!raw || typeof raw !== 'object') return EMPTY_NOTES;
  const s = raw as Record<string, unknown>;
  const folders: NoteFolder[] = [];
  for (const f of Array.isArray(s.folders) ? s.folders.slice(0, FOLDERS_LIMIT) : []) {
    const r = (f ?? {}) as Record<string, unknown>;
    const name = cleanName(r.name);
    if (typeof r.id === 'string' && ID_RE.test(r.id) && !isBuiltInFolder(r.id) && name && typeof r.at === 'number' && !folders.some((x) => x.id === r.id)) folders.push({ id: r.id, name, at: r.at });
  }
  const known = new Set(folders.map((f) => f.id));
  const notes: NoteItem[] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(s.notes) ? s.notes.slice(0, NOTES_LIMIT) : []) {
    const r = (n ?? {}) as Record<string, unknown>;
    const text = cleanText(r.text);
    const images = cleanImages(r.images ?? []);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || seen.has(r.id) || text === null || !images || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    seen.add(r.id);
    // A note whose folder has gone is put back in Notes.
    const folder = typeof r.folder === 'string' && (isBuiltInFolder(r.folder) || known.has(r.folder)) ? r.folder : 'notes';
    notes.push({
      id: r.id,
      folder,
      text,
      images,
      at: r.at,
      editedAt: typeof r.editedAt === 'number' && Number.isFinite(r.editedAt) ? r.editedAt : r.at,
      ...(r.pinned === true ? { pinned: true } : {}),
      ...(typeof r.deletedAt === 'number' && Number.isFinite(r.deletedAt) ? { deletedAt: r.deletedAt } : {}),
    });
  }
  const watched = Array.isArray(s.watched) ? [...new Set(s.watched.map(cleanUrl).filter((u): u is string => !!u))].slice(-WATCHED_LIMIT) : [];
  return { folders, notes, watched };
}

// ---- Changes ------------------------------------------------------------------------------------

/** Notes deleted more than TRASH_DAYS ago, gone for good. */
function sweep(state: NotesState, now: number): NotesState {
  const old = state.notes.filter((n) => n.deletedAt !== undefined && now - n.deletedAt > TRASH_DAYS * DAY);
  return old.length ? { ...state, notes: state.notes.filter((n) => !old.includes(n)) } : state;
}

/**
 * The pad after `a`, at `now`. The same pad back when it changes nothing (a note that's gone, a
 * folder that isn't there, one too many). Old notes in Recently deleted go for good as it changes.
 */
export function applyNote(state: NotesState, a: NoteAction, now = Date.now()): NotesState {
  const next = change(state, a, now);
  return next === state ? state : sweep(next, now);
}

function change(state: NotesState, a: NoteAction, now: number): NotesState {
  const with_ = (notes: NoteItem[]): NotesState => ({ ...state, notes });
  const update = (id: string, fn: (n: NoteItem) => NoteItem | null): NotesState => {
    const was = state.notes.find((n) => n.id === id);
    const now_ = was && fn(was);
    if (!was || !now_) return state;
    return with_(state.notes.map((n) => (n === was ? now_ : n)));
  };
  switch (a.action) {
    case 'add': {
      if (state.notes.some((n) => n.id === a.id) || !hasFolder(state, a.folder)) return state;
      if (state.notes.length >= NOTES_LIMIT) return state;
      return with_([...state.notes, { id: a.id, folder: a.folder, text: a.text, images: a.images ?? [], at: now, editedAt: now }]);
    }
    case 'edit':
      return update(a.id, (n) => {
        if (n.deletedAt !== undefined) return null;
        const text = a.text ?? n.text;
        const images = a.images ?? n.images;
        if (text === n.text && images.join() === n.images.join()) return null;
        return { ...n, text, images, editedAt: now };
      });
    case 'move':
      if (!hasFolder(state, a.folder)) return state;
      return update(a.id, (n) => (n.folder === a.folder && n.deletedAt === undefined ? null : { ...withoutDeleted(n), folder: a.folder }));
    case 'pin':
      return update(a.id, (n) => (!!n.pinned === a.pinned || n.deletedAt !== undefined ? null : a.pinned ? { ...n, pinned: true } : withoutPin(n)));
    case 'delete': {
      const was = state.notes.find((n) => n.id === a.id);
      if (!was) return state;
      // From Recently deleted, or one with nothing in it (a new note left empty): gone for good.
      if (was.deletedAt !== undefined || isBlank(was)) return with_(state.notes.filter((n) => n !== was));
      return update(a.id, (n) => ({ ...withoutPin(n), deletedAt: now }));
    }
    case 'restore':
      // Back where it was, or to Notes if that folder has gone since.
      return update(a.id, (n) => (n.deletedAt === undefined ? null : { ...withoutDeleted(n), folder: hasFolder(state, n.folder) ? n.folder : 'notes' }));
    case 'empty': {
      const kept = state.notes.filter((n) => n.deletedAt === undefined);
      return kept.length === state.notes.length ? state : with_(kept);
    }
    case 'watched': {
      const has = state.watched.includes(a.url);
      if (has === a.watched) return state;
      const watched = a.watched ? [...state.watched, a.url].slice(-WATCHED_LIMIT) : state.watched.filter((u) => u !== a.url);
      return { ...state, watched };
    }
    case 'folder.add':
      if (isBuiltInFolder(a.id) || hasFolder(state, a.id) || state.folders.length >= FOLDERS_LIMIT) return state;
      return { ...state, folders: [...state.folders, { id: a.id, name: a.name, at: now }] };
    case 'folder.rename': {
      const was = state.folders.find((f) => f.id === a.id);
      if (!was || was.name === a.name) return state;
      return { ...state, folders: state.folders.map((f) => (f === was ? { ...f, name: a.name } : f)) };
    }
    case 'folder.remove': {
      if (!state.folders.some((f) => f.id === a.id)) return state;
      // Its notes stay in Recently deleted for a while, so a folder removed by mistake can be got back.
      const notes = state.notes.map((n) => (n.folder === a.id && n.deletedAt === undefined ? { ...withoutPin(n), deletedAt: now } : n));
      return { ...state, folders: state.folders.filter((f) => f.id !== a.id), notes };
    }
  }
}

/** Whether a note has nothing in it: no words, no pictures. */
export function isBlank(n: Pick<NoteItem, 'text' | 'images'>): boolean {
  return !n.text.trim() && !n.images.length;
}

function withoutPin(n: NoteItem): NoteItem {
  const { pinned: _, ...rest } = n;
  return rest;
}

function withoutDeleted(n: NoteItem): NoteItem {
  const { deletedAt: _, ...rest } = n;
  return rest;
}
