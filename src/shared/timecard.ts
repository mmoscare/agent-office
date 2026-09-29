/**
 * The 🗂️ Indirect Time card on the boss's desk: when you had the office open in a browser, per day.
 * The office clocks you in when your first window connects and out when your last one closes
 * (see server/timecard.ts); a reload or a restart within TIMECARD_GRACE_MS carries on the same stint.
 */

/** A stretch with the office open. While it's still going, `end` is when the office last saw you. */
export interface TimeStint { start: number; end: number }
export interface TimeCardState {
  /** Whose card it is. */
  name: string;
  stints: TimeStint[];
  /** The last stint is still going: it runs to now. */
  open: boolean;
  /** Set when the card could not be saved (or read) on the office's machine. */
  saveError?: string;
}

/** A gap shorter than this between closing the office and opening it again isn't a break: a reload, a restart, a flaky network. */
export const TIMECARD_GRACE_MS = 5 * 60_000;
/** How often an open stint is saved as still going, so a crash loses at most this much. */
export const TIMECARD_TICK_MS = 60_000;
/** How long the office keeps stints. */
export const TIMECARD_KEEP_MS = 400 * 24 * 3_600_000;

/** The stints as they stand at `now`: an open one runs to now. */
export function liveStints(card: Pick<TimeCardState, 'stints' | 'open'>, now: number): TimeStint[] {
  return card.stints.map((s, i) => (card.open && i === card.stints.length - 1 ? { start: s.start, end: Math.max(s.end, now) } : s));
}

/** A day in local time, as 2026-09-28. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight at the start of the day `at` is in. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight at the start of the next day (not always 24h later, across a clock change). */
export function nextDay(at: number): number {
  const d = new Date(startOfDay(at));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Local midnight at the start of the Monday of the week `at` is in. */
export function startOfWeek(at: number): number {
  const d = new Date(startOfDay(at));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

/** One day's share of the stints: a stint over midnight counts on both days. */
export interface TimeDay { day: string; start: number; ms: number; stints: TimeStint[] }

/** The stints split at local midnight, by day, newest day first. */
export function timeDays(stints: TimeStint[]): TimeDay[] {
  const days = new Map<string, TimeDay>();
  for (const s of stints) {
    for (let from = s.start; from < s.end; ) {
      const to = Math.min(s.end, nextDay(from));
      const key = dayKey(from);
      let day = days.get(key);
      if (!day) days.set(key, (day = { day: key, start: startOfDay(from), ms: 0, stints: [] }));
      day.ms += to - from;
      day.stints.push({ start: from, end: to });
      from = to;
    }
  }
  return [...days.values()].sort((a, b) => b.start - a.start);
}

/** Time in the office from `from` up to `to`. */
export function timeBetween(stints: TimeStint[], from: number, to: number): number {
  let ms = 0;
  for (const s of stints) ms += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
  return ms;
}

/** 3h 05m, or 12m under an hour. */
export function hoursText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Decimal hours for a timesheet, to two places: 3.08. */
export function decimalHours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}
