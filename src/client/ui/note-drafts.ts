// What's typed in a 🗒️ note that the office hasn't got yet. It's kept apart from the note's editor,
// which goes when you pick another note or close the board, and in this browser's storage, which
// outlives a reload (the lost-connection screen offers one). Each draft goes to the office when it's
// up, and again each time the office sends the whole pad (after a reconnect), until the office's own
// copy of the note has it.

import { hasFolder, NOTE_TEXT_MAX, newNoteId, type NoteAction } from '../../shared/notes';
import type { Net } from '../net';
import { store } from '../state';

interface Draft {
  folder: string;
  text: string;
  at: number;
  /** Whose pad it's for (their account's name, '' for the shared password): a shared browser keeps each person's apart. */
  owner: string;
  /** The pad load (store.notesLoads) it was last sent on: it goes again once a newer one comes. */
  sentOn?: number;
}

const KEY = 'agent-office.notes.drafts';
const ID_RE = /^[a-z0-9]{6,32}$/;
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let net: Net | undefined;

const owner = () => store.me.account?.name ?? '';

try {
  const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  for (const [id, raw] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    const d = raw as Partial<Draft>;
    if (ID_RE.test(id) && typeof d.text === 'string' && d.text.length <= NOTE_TEXT_MAX && typeof d.folder === 'string' && typeof d.owner === 'string') drafts.set(id, { folder: d.folder, text: d.text, at: Number(d.at) || 0, owner: d.owner });
  }
} catch {
  // none, or not readable here: nothing kept
}

function persist() {
  try {
    if (drafts.size) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...drafts].map(([id, d]) => [id, { folder: d.folder, text: d.text, at: d.at, owner: d.owner }]))));
    else localStorage.removeItem(KEY);
  } catch {
    // kept for this page only
  }
}

const changed = () => listeners.forEach((fn) => fn());

/**
 * Makes a change to your 🗒️ Notes pad: on screen straight away, and on to the office, whose answer
 * goes under it (see state.ts). False when it changes nothing, or while the office is out of reach.
 */
export function changeNote(n: Net, change: NoteAction): boolean {
  if (!n.up || !store.changeNote(change)) return false;
  n.send({ t: 'note', change });
  return true;
}

/** Starts sending drafts as the office answers; once is enough (main.ts, so drafts from before a reload go without opening the pad). */
export function watchNoteDrafts(n: Net) {
  if (net) return;
  net = n;
  store.on('notes', pump);
  // The office going (the lost-connection screen goes up) or coming back changes what the pad says about them.
  n.onStatus(changed);
  pump();
}

/** Keeps `text` as note `id`'s, until the office has it. */
export function keepDraft(id: string, folder: string, text: string) {
  const was = drafts.get(id);
  if (was?.text === text && was.owner === owner()) return;
  if (!was && store.notesOffice.notes.find((n) => n.id === id)?.text === text) return;
  drafts.set(id, { folder, text, at: Date.now(), owner: owner() });
  persist();
  changed();
  pump();
}

/** Lets go of note `id`'s draft (it was deleted on purpose). */
export function forgetDraft(id: string) {
  if (drafts.delete(id)) {
    persist();
    changed();
  }
}

/** What's typed in note `id` that the office hasn't got yet, if anything. */
export function draftOf(id: string): string | undefined {
  const d = drafts.get(id);
  return d && d.owner === owner() ? d.text : undefined;
}

/** How many of your notes have typing the office hasn't got yet. */
export function unsavedNotes(): number {
  const me = owner();
  return [...drafts.values()].filter((d) => d.owner === me).length;
}

/** Told when drafts come or go, and when the office goes or comes back. */
export function onNoteDrafts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Lets go of the drafts the office has now, and sends the rest that haven't gone since it last sent the whole pad. */
function pump() {
  if (!net) return;
  const office = store.notesOffice;
  const me = owner();
  let dirty = false;
  for (const [id, d] of [...drafts]) {
    if (d.owner !== me) continue;
    const there = office.notes.find((n) => n.id === id);
    if (there?.text === d.text) {
      drafts.delete(id);
      dirty = true;
      continue;
    }
    // Nothing's sent until the office has sent its pad: it's what the change goes on top of.
    if (!net.up || !store.notesLoads || d.sentOn === store.notesLoads) continue;
    d.sentOn = store.notesLoads;
    dirty = true;
    const folder = hasFolder(office, d.folder) ? d.folder : 'notes';
    if (there?.deletedAt !== undefined) {
      // Deleted meanwhile, from another window: what was typed comes back as a note of its own.
      const to = newNoteId();
      drafts.delete(id);
      drafts.set(to, { ...d, folder });
      changeNote(net, { action: 'add', id: to, folder, text: d.text });
    } else changeNote(net, there ? { action: 'edit', id, text: d.text } : { action: 'add', id, folder, text: d.text });
  }
  if (dirty) {
    persist();
    changed();
  }
}
