// A daily budget for the Claude plan's weekly limits: each day of the week's window gets an equal
// share (a seventh), so staying within it means the week lasts until it starts over. The days run
// from the hour the week resets, so all seven are the same length. A day's unused share carries
// over into the next day. Worked out from the numbers the limits meter already has, so nothing is
// stored and every read of the limits (see server/limits.ts) keeps it current.

import type { PlanWindow } from './protocol.js';

export const WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = WEEK_DAYS * DAY_MS;
/** Less of the week than this gone is too little to tell a pace from. */
const MIN_PACE_MS = 2 * 60 * 60_000;

export interface DayBudget {
  /** Which day of the week's window it is, 1-7. */
  day: number;
  /** The share of the week each day adds, percent (100 / 7). */
  share: number;
  /** Percent of the week that may be used by the end of today: day × share. */
  limit: number;
  /** limit − used, in percent of the week; zero or less once today's budget is spent. */
  left: number;
  /** When today ends and the next day's share comes in (ms since epoch). */
  dayEndsAt: number;
  /** When the budget, with nothing more used, would cover what's used so far: the start of the first day it's back within. */
  backAt: number;
  /** When the week would run out at its pace so far, if that's before it starts over. An estimate. */
  runsOutAt?: number;
}

/** A weekly window: the whole plan's week, or a per-model one ("Fable week"). */
export const isWeekly = (w: PlanWindow) => /\bweek$/i.test(w.label);

/** Today's share of a weekly window, or null for the 5-hour session or a week with no known reset. */
export function dayBudget(w: PlanWindow, now = Date.now()): DayBudget | null {
  if (!isWeekly(w) || w.resetsAt === undefined || !(w.resetsAt > now)) return null;
  const start = w.resetsAt - WEEK_MS;
  const gone = Math.max(0, now - start);
  const day = Math.min(WEEK_DAYS, Math.floor(gone / DAY_MS) + 1);
  const share = 100 / WEEK_DAYS;
  // Multiplied before dividing, so the last day comes to exactly 100%.
  const limit = (day * 100) / WEEK_DAYS;
  const backDay = Math.min(WEEK_DAYS + 1, Math.floor((w.pct * WEEK_DAYS) / 100) + 1);
  const pace = gone >= MIN_PACE_MS && w.pct > 0 ? w.pct / gone : 0;
  const runsOutAt = pace > 0 ? now + (100 - w.pct) / pace : undefined;
  return {
    day,
    share,
    limit,
    left: limit - w.pct,
    dayEndsAt: start + day * DAY_MS,
    backAt: Math.max(now, start + (backDay - 1) * DAY_MS),
    runsOutAt: runsOutAt !== undefined && runsOutAt < w.resetsAt ? runsOutAt : undefined,
  };
}

export const overBudget = (b: DayBudget) => b.left <= 0;

/** Names one window's budget day, so its warning goes up once. The reset time is rounded, since it moves by milliseconds between reads. */
export function budgetDayKey(w: PlanWindow, b: DayBudget): string {
  return `${w.label}@${Math.round((b.dayEndsAt - DAY_MS) / 3_600_000)}`;
}

/** The weekly windows whose budget for today is spent and not yet warned about (per `warned`, keys from budgetDayKey). */
export function budgetWarnings(windows: PlanWindow[], warned: ReadonlySet<string>, now = Date.now()): { window: PlanWindow; budget: DayBudget; key: string }[] {
  const out: { window: PlanWindow; budget: DayBudget; key: string }[] = [];
  for (const w of windows) {
    const b = dayBudget(w, now);
    if (!b || !overBudget(b)) continue;
    const key = budgetDayKey(w, b);
    if (!warned.has(key)) out.push({ window: w, budget: b, key });
  }
  return out;
}
