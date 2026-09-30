// ✨ What's new, on the queue staffer's clipboard: every change that landed on a floor's working
// branch, in plain words for someone who doesn't program (see server/change-notes.ts).

/** How many changes the clipboard asks for at first, and how many more each "Show older" adds. */
export const WHATS_NEW_PAGE = 40;
/** The most it ever asks for at once. */
export const WHATS_NEW_MAX = 5000;

/** One change on the floor's working branch. */
export interface ChangeNote {
  /** Its own for good: `pr:12` or `commit:<sha>`, after `owner/name ` on a floor of several repositories. */
  key: string;
  /** When it landed (ms). */
  at: number;
  /** What it means for the person using the app, in plain words; or, until then, its title tidied up. */
  text: string;
  /** False while `text` is only the title tidied up, not yet rewritten in plain words. */
  plain: boolean;
  /** The title its developer gave it, as written. */
  title: string;
  /** The original author's updates, brought in. */
  author?: boolean;
  /** The pull request (or the commit) on GitHub, for whoever wants the details. */
  url?: string;
  /** Which repository, on a floor of several. */
  repo?: string;
}

/** Where a browser keeps, per floor, the newest change it has shown: anything after it is New next time. */
export const WHATS_NEW_SEEN = 'agent-office.whats-new.seen';

/**
 * Who a floor is to its New marks: its folder, which stays with it. A floor's id can come back for
 * another folder of the same name, which mustn't inherit the old one's marks.
 */
export function seenKey(floor: { id: string; dir?: string }): string {
  return floor.dir ? `dir:${floor.dir.replace(/\\/g, '/').replace(/\/+$/, '')}` : `id:${floor.id}`;
}

/** localStorage, as far as the marks need it. */
type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function seenAll(storage: Store): Record<string, unknown> {
  const all = JSON.parse(storage.getItem(WHATS_NEW_SEEN) ?? '{}');
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/** The newest change this browser has shown of the floor under `key` (see seenKey), if it has shown any. */
export function seenAt(storage: Store | undefined, key: string): number | undefined {
  try {
    const v = storage && seenAll(storage)[key];
    return typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Notes that this browser has now shown the floor's changes up to `at`. Never moves back. */
export function markSeen(storage: Store | undefined, key: string, at: number) {
  try {
    if (!storage) return;
    const all = seenAll(storage);
    const was = all[key];
    if (typeof was === 'number' && was >= at) return;
    all[key] = at;
    storage.setItem(WHATS_NEW_SEEN, JSON.stringify(all));
  } catch {
    // Private windows and full storage: nothing is marked new, which is fine.
  }
}

/** "Today", "Yesterday", else the date: the heading `at` goes under, seen from `now`. */
export function dayLabel(at: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const ago = Math.round((day(now) - day(at)) / 86_400_000);
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  const d = new Date(at);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}

/** Changes (newest first) under their days' headings, in order. */
export function byDay<T extends { at: number }>(notes: T[], now = Date.now()): { day: string; notes: T[] }[] {
  const days: { day: string; notes: T[] }[] = [];
  for (const n of notes) {
    const day = dayLabel(n.at, now);
    if (days[days.length - 1]?.day !== day) days.push({ day, notes: [] });
    days[days.length - 1].notes.push(n);
  }
  return days;
}

export interface WhatsNew {
  floor: string;
  /** The branch the changes landed on, when the floor is one repository. */
  branch?: string;
  /** Newest first: the first `show` of `total`. */
  notes: ChangeNote[];
  total: number;
  /** Being put in plain words right now: ask again shortly for them. */
  writing: number;
  /** Still being brought up to date from GitHub: ask again shortly. */
  refreshing: boolean;
  /** Why nothing is being put in plain words, when that's so. */
  writer?: string;
  /** Why the list couldn't be read (or read only in part). */
  error?: string;
}
