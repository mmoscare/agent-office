/** The office wall calendar: the month on the loft wall, and the chores that land on the 1st. */

export interface OfficeDate {
  year: number;
  /** 0–11, same as Date#getUTCMonth. */
  month: number;
  day: number;
}

export interface CalendarChore {
  id: string;
  icon: string;
  title: string;
  detail: string;
}

/** Recurring first-of-the-month chores. They show on the calendar and the office notifies you. */
export const MONTHLY_CHORES: readonly CalendarChore[] = [
  {
    id: 'cleanup',
    icon: '🌿',
    title: 'Delete and clean up branches and worktrees',
    detail: 'Prune leftover office branches and worktrees that are safe to delete.',
  },
  {
    id: 'mft-portfolio',
    icon: '🧰',
    title: 'Combine MFT and Personal Portfolio',
    detail: 'Make sure MFT and Personal Portfolio have the same capabilities.',
  },
  {
    id: 'backup',
    icon: '💾',
    title: 'Backup',
    detail: 'Take a backup of the office and your projects.',
  },
];

export const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * The office's date at `ms`, using `utcOffset` minutes east of UTC (SkyState), the same clock the
 * holiday decorations follow.
 */
export function officeDate(ms: number, utcOffset: number): OfficeDate {
  const d = new Date(ms + utcOffset * 60_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/** `2026-10` for October 2026. */
export function monthKey(d: Pick<OfficeDate, 'year' | 'month'>): string {
  return `${d.year}-${String(d.month + 1).padStart(2, '0')}`;
}

export function monthTitle(d: Pick<OfficeDate, 'year' | 'month'>): string {
  return `${MONTH_NAMES[d.month]} ${d.year}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Weeks of a month, Sunday first. Empty cells are `null`.
 */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = daysInMonth(year, month);
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(d: Pick<OfficeDate, 'year' | 'month'>, delta: number): Pick<OfficeDate, 'year' | 'month'> {
  const month = d.month + delta;
  const year = d.year + Math.floor(month / 12);
  return { year, month: ((month % 12) + 12) % 12 };
}

/** Chores that land on this day-of-month. The three monthly ones all sit on the 1st. */
export function choresOnDay(day: number): readonly CalendarChore[] {
  return day === 1 ? MONTHLY_CHORES : [];
}

export function sameDay(a: OfficeDate, b: OfficeDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * The first-of-month chores for `date`'s month are still waiting: that month has begun and they
 * have not been marked done (`dismissedMonthKey` is a `monthKey`).
 */
export function choresPending(date: OfficeDate, dismissedMonthKey: string | null): boolean {
  return monthKey(date) !== dismissedMonthKey;
}

/** Notify once a month, while the chores are still waiting. */
export function shouldNotify(date: OfficeDate, dismissedMonthKey: string | null, notifiedMonthKey: string | null): boolean {
  return choresPending(date, dismissedMonthKey) && monthKey(date) !== notifiedMonthKey;
}

export function choreNotificationTitle(): string {
  return '📅 First of the month';
}

export function choreNotificationBody(chores: readonly CalendarChore[] = MONTHLY_CHORES): string {
  return chores.map(c => `${c.icon} ${c.title}`).join('\n');
}
