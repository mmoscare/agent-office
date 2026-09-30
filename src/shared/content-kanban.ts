// The 🎬 Content Kanban: a content pipeline that stands on the whiteboard's wheels on the floors in
// CONTENT_KANBAN_FLOORS (it's the Autonomous-Dev-Projects floor's own thing). Dump ideas in, toggle
// what you'll make of each one (a YouTube video, a Short, a TikTok, an article, an X thread…), and
// every card keeps those as a checklist while it moves from Ideas to Published. Everyone on the
// floor shares one board: the office keeps it (see server/content-kanban.ts), and each browser makes
// its own changes straight away with applyContent and lets the office's copy win when it comes back.

/** The floors (by id) whose whiteboard stand carries the Content Kanban instead of a drawing. */
export const CONTENT_KANBAN_FLOORS: readonly string[] = ['autonomous-dev-projects'];

export function hasContentKanban(floor: string | null | undefined): boolean {
  return !!floor && CONTENT_KANBAN_FLOORS.includes(floor);
}

/** The pipeline, left to right: a card is born an idea and ends up published. */
export const CONTENT_STAGES = {
  idea: 'Ideas',
  script: 'Scripting',
  create: 'Creating',
  edit: 'Editing',
  scheduled: 'Scheduled',
  published: 'Published',
} as const;
export type ContentStage = keyof typeof CONTENT_STAGES;
export const STAGE_ORDER = Object.keys(CONTENT_STAGES) as ContentStage[];
export const STAGE_ICON: Record<ContentStage, string> = { idea: '💡', script: '✍️', create: '🎥', edit: '✂️', scheduled: '📅', published: '🚀' };

/** What an idea can be made into: each one picked becomes a box on the card's checklist. */
export const CONTENT_FORMATS = {
  youtube: 'YouTube video',
  short: 'YouTube Short',
  tiktok: 'TikTok',
  reel: 'Instagram Reel',
  x: 'X post',
  thread: 'X thread',
  article: 'Article',
  linkedin: 'LinkedIn post',
  newsletter: 'Newsletter',
  podcast: 'Podcast',
} as const;
export type ContentFormat = keyof typeof CONTENT_FORMATS;
export const FORMAT_ORDER = Object.keys(CONTENT_FORMATS) as ContentFormat[];
export const FORMAT_ICON: Record<ContentFormat, string> = {
  youtube: '▶️',
  short: '⚡',
  tiktok: '🎵',
  reel: '📸',
  x: '𝕏',
  thread: '🧵',
  article: '📰',
  linkedin: '💼',
  newsletter: '📧',
  podcast: '🎙️',
};

export const CONTENT_TITLE_MAX = 200;
export const CONTENT_NOTES_MAX = 4000;
/** Ideas one dump can drop in at once. */
export const CONTENT_DUMP_MAX = 50;
/** Cards a board keeps, at most; past it the longest-published go first. */
export const CONTENT_LIMIT = 1000;

/** One box on a card's checklist: a piece to make out of the idea. */
export interface ContentPiece {
  format: ContentFormat;
  done?: boolean;
  /** When it was ticked. */
  doneAt?: number;
}

import { cleanImages, cleanSubtasks, type TodoSubtask } from './todos.js';

export interface ContentItem {
  id: string;
  title: string;
  /** The angle, hook, outline, links… */
  notes?: string;
  stage: ContentStage;
  /** What it's being made into, as a checklist, in the formats' order. */
  pieces: ContentPiece[];
  /** When it's meant to go out, as YYYY-MM-DD. */
  due?: string;
  /** Who put it on the board. */
  by?: string;
  /** When it was added. */
  at: number;
  /** When it last went to Published. */
  publishedAt?: number;
  /** Its own to-dos, and pictures (see shared/todos.ts): shown once the board is double-clicked. */
  subtasks?: TodoSubtask[];
  images?: string[];
}

export type ContentAction =
  /** Ideas from the dump (one or more), at `index` in `stage` (its top if left out), each with a box per format. The browser names them, so it can show them before the office answers. */
  | { action: 'add'; cards: { id: string; title: string }[]; formats: ContentFormat[]; stage?: ContentStage; index?: number }
  /** Moved to `index` in `stage` (counted without it; the top if left out), from wherever it was. */
  | { action: 'move'; id: string; stage: ContentStage; index?: number }
  /** A new title, notes or date: what's left out stays; '' clears the notes or the date. */
  | { action: 'edit'; id: string; title?: string; notes?: string; due?: string }
  /** What it's being made into now: boxes for formats it keeps stay ticked. */
  | { action: 'formats'; id: string; formats: ContentFormat[] }
  /** A box ticked, or unticked. */
  | { action: 'check'; id: string; format: ContentFormat; done: boolean }
  /** Its subtasks or pictures, replaced; an empty list takes them off. */
  | { action: 'details'; id: string; subtasks?: TodoSubtask[]; images?: string[] }
  | { action: 'remove'; id: string }
  /** A removed card put back as it was (Undo). */
  | { action: 'restore'; item: ContentItem; index?: number };

const ID_RE = /^[a-z0-9]{6,32}$/;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isContentStage(value: unknown): value is ContentStage {
  return typeof value === 'string' && Object.hasOwn(CONTENT_STAGES, value);
}
export function isContentFormat(value: unknown): value is ContentFormat {
  return typeof value === 'string' && Object.hasOwn(CONTENT_FORMATS, value);
}

/** A name for a new card. */
export function newContentId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

const cleanTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= CONTENT_TITLE_MAX ? text : null;
};
/** Notes keep their lines; only the ends are trimmed. Null when it isn't text or is too long. */
const cleanNotes = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text.length <= CONTENT_NOTES_MAX ? text : null;
};
/** A real calendar day as YYYY-MM-DD, or '' (no date). Null for anything else. */
const cleanDue = (value: unknown): string | null => {
  if (value === '') return '';
  if (typeof value !== 'string' || !DUE_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d ? value : null;
};
const cleanIndex = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
/** Formats, each once, in the formats' own order. */
const inOrder = (formats: readonly ContentFormat[]): ContentFormat[] => FORMAT_ORDER.filter((f) => formats.includes(f));
/** Formats picked, each once, in the formats' own order; null if anything in it isn't one. */
const cleanFormats = (value: unknown): ContentFormat[] | null => (Array.isArray(value) && value.every(isContentFormat) ? inOrder(value) : null);

/** A change a browser sent, if it is one. */
export function checkContentAction(raw: unknown): ContentAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.action === 'add') {
    if (!Array.isArray(a.cards) || !a.cards.length || a.cards.length > CONTENT_DUMP_MAX) return null;
    const cards: { id: string; title: string }[] = [];
    for (const c of a.cards as unknown[]) {
      const card = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
      const title = cleanTitle(card.title);
      if (typeof card.id !== 'string' || !ID_RE.test(card.id) || !title || cards.some((x) => x.id === card.id)) return null;
      cards.push({ id: card.id, title });
    }
    const formats = cleanFormats(a.formats ?? []);
    if (!formats || (a.stage !== undefined && !isContentStage(a.stage))) return null;
    const index = cleanIndex(a.index);
    return { action: 'add', cards, formats, ...(a.stage === undefined ? {} : { stage: a.stage as ContentStage }), ...(index === undefined ? {} : { index }) };
  }
  if (a.action === 'restore') {
    const item = checkContentItem(a.item);
    const index = cleanIndex(a.index);
    return item ? { action: 'restore', item, ...(index === undefined ? {} : { index }) } : null;
  }
  if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return null;
  const id = a.id;
  switch (a.action) {
    case 'move': {
      if (!isContentStage(a.stage)) return null;
      const index = cleanIndex(a.index);
      return { action: 'move', id, stage: a.stage, ...(index === undefined ? {} : { index }) };
    }
    case 'edit': {
      const title = a.title === undefined ? undefined : cleanTitle(a.title);
      const notes = a.notes === undefined ? undefined : cleanNotes(a.notes);
      const due = a.due === undefined ? undefined : cleanDue(a.due);
      if (title === null || notes === null || due === null || (title === undefined && notes === undefined && due === undefined)) return null;
      return { action: 'edit', id, ...(title === undefined ? {} : { title }), ...(notes === undefined ? {} : { notes }), ...(due === undefined ? {} : { due }) };
    }
    case 'formats': {
      const formats = cleanFormats(a.formats);
      return formats ? { action: 'formats', id, formats } : null;
    }
    case 'check':
      return isContentFormat(a.format) && typeof a.done === 'boolean' ? { action: 'check', id, format: a.format, done: a.done } : null;
    case 'details': {
      const subtasks = a.subtasks === undefined ? undefined : cleanSubtasks(a.subtasks);
      const images = a.images === undefined ? undefined : cleanImages(a.images);
      if (subtasks === null || images === null || (subtasks === undefined && images === undefined)) return null;
      return { action: 'details', id, ...(subtasks ? { subtasks } : {}), ...(images ? { images } : {}) };
    }
    case 'remove':
      return { action: 'remove', id };
    default:
      return null;
  }
}

/** A card read back from disk (or put back with Undo), if it is one. */
export function checkContentItem(raw: unknown): ContentItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const title = cleanTitle(t.title);
  if (typeof t.id !== 'string' || !ID_RE.test(t.id) || !title || !isContentStage(t.stage) || typeof t.at !== 'number' || !Number.isFinite(t.at)) return null;
  const pieces: ContentPiece[] = [];
  for (const format of FORMAT_ORDER) {
    const p = Array.isArray(t.pieces) ? (t.pieces as unknown[]).find((x) => !!x && typeof x === 'object' && (x as ContentPiece).format === format) as Record<string, unknown> | undefined : undefined;
    if (!p) continue;
    const done = p.done === true;
    pieces.push({ format, ...(done ? { done } : {}), ...(done && typeof p.doneAt === 'number' && Number.isFinite(p.doneAt) ? { doneAt: p.doneAt } : {}) });
  }
  const notes = cleanNotes(t.notes);
  const due = cleanDue(t.due);
  const subtasks = t.subtasks === undefined ? null : cleanSubtasks(t.subtasks);
  const images = t.images === undefined ? null : cleanImages(t.images);
  return {
    id: t.id,
    title,
    ...(notes ? { notes } : {}),
    stage: t.stage,
    pieces,
    ...(due ? { due } : {}),
    ...(typeof t.by === 'string' && t.by.trim() ? { by: t.by.trim().slice(0, 60) } : {}),
    at: t.at,
    ...(t.stage === 'published' && typeof t.publishedAt === 'number' && Number.isFinite(t.publishedAt) ? { publishedAt: t.publishedAt } : {}),
    ...(subtasks?.length ? { subtasks } : {}),
    ...(images?.length ? { images } : {}),
  };
}

/** The cards in `stage`, in their order. */
export function contentIn(items: readonly ContentItem[], stage: ContentStage): ContentItem[] {
  return items.filter((t) => t.stage === stage);
}

/** How much of a card's checklist is made. */
export function piecesDone(item: ContentItem): { done: number; total: number } {
  return { done: item.pieces.filter((p) => p.done).length, total: item.pieces.length };
}

/** `cards` put at `index` among `stage`'s cards (the end if past it), keeping everything else where it was. */
function insertAt(items: ContentItem[], cards: ContentItem[], stage: ContentStage, index = 0): ContentItem[] {
  const inStage = items.filter((t) => t.stage === stage);
  const before = inStage[index];
  const last = inStage.at(-1);
  const at = before ? items.indexOf(before) : last ? items.indexOf(last) + 1 : items.length;
  return [...items.slice(0, at), ...cards, ...items.slice(at)];
}

/**
 * The board after `a` (`by` is who's making it, for new cards). The same board back when it changes
 * nothing (a card that's already gone, a name that's taken). The longest-published cards come off
 * once there are too many.
 */
export function applyContent(items: readonly ContentItem[], a: ContentAction, now = Date.now(), by?: string): readonly ContentItem[] {
  let next: ContentItem[];
  if (a.action === 'add' || a.action === 'restore') {
    const fresh: ContentItem[] =
      a.action === 'restore'
        ? [a.item]
        : a.cards.map(({ id, title }) => {
            const stage = a.stage ?? 'idea';
            return { id, title, stage, pieces: inOrder(a.formats).map((format) => ({ format })), ...(by ? { by } : {}), at: now, ...(stage === 'published' ? { publishedAt: now } : {}) };
          });
    if (fresh.some((c) => items.some((t) => t.id === c.id))) return items;
    next = insertAt([...items], fresh, fresh[0].stage, a.index);
  } else {
    const was = items.find((t) => t.id === a.id);
    if (!was) return items;
    const swap = (card: ContentItem) => items.map((t) => (t === was ? card : t));
    switch (a.action) {
      case 'move': {
        const moved: ContentItem = { ...was, stage: a.stage };
        if (a.stage === 'published' && was.stage !== 'published') moved.publishedAt = now;
        if (a.stage !== 'published') delete moved.publishedAt;
        next = insertAt(items.filter((t) => t !== was), [moved], a.stage, a.index);
        break;
      }
      case 'edit': {
        const card: ContentItem = { ...was, ...(a.title === undefined ? {} : { title: a.title }) };
        if (a.notes !== undefined) {
          if (a.notes) card.notes = a.notes;
          else delete card.notes;
        }
        if (a.due !== undefined) {
          if (a.due) card.due = a.due;
          else delete card.due;
        }
        if (card.title === was.title && card.notes === was.notes && card.due === was.due) return items;
        next = swap(card);
        break;
      }
      case 'formats': {
        const pieces = inOrder(a.formats).map((format) => was.pieces.find((p) => p.format === format) ?? { format });
        if (pieces.length === was.pieces.length && pieces.every((p, i) => p === was.pieces[i])) return items;
        next = swap({ ...was, pieces });
        break;
      }
      case 'check': {
        const piece = was.pieces.find((p) => p.format === a.format);
        if (!piece || !!piece.done === a.done) return items;
        next = swap({ ...was, pieces: was.pieces.map((p) => (p === piece ? (a.done ? { format: p.format, done: true, doneAt: now } : { format: p.format }) : p)) });
        break;
      }
      case 'details': {
        const card: ContentItem = { ...was };
        if (a.subtasks !== undefined) card.subtasks = a.subtasks;
        if (a.images !== undefined) card.images = a.images;
        if (!card.subtasks?.length) delete card.subtasks;
        if (!card.images?.length) delete card.images;
        if (JSON.stringify(card) === JSON.stringify(was)) return items;
        next = swap(card);
        break;
      }
      case 'remove':
        next = items.filter((t) => t !== was);
        break;
    }
  }
  while (next.length > CONTENT_LIMIT) {
    const oldest = contentIn(next, 'published').sort((x, y) => (x.publishedAt ?? x.at) - (y.publishedAt ?? y.at))[0] ?? next[next.length - 1];
    next = next.filter((t) => t !== oldest);
  }
  return next;
}
