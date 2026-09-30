// The office calendar: the month in a window, the first-of-the-month chores on the 1st, and a
// reminder (a card in the office, a desktop notification if the tab is in the background).

import {
  MONTHLY_CHORES,
  choreNotificationBody,
  choreNotificationTitle,
  choresOnDay,
  choresPending as choresStillDue,
  monthGrid,
  monthKey,
  monthTitle,
  officeDate,
  shouldNotify,
  shiftMonth,
  WEEKDAYS,
  type CalendarChore,
} from '../../shared/calendar';
import { notifyPermission } from '../notify';
import { store } from '../state';
import { openCleanup } from './cleanup';
import { h, openModal, toast } from './dom';

const DISMISSED_KEY = 'agent-office.calendar.dismissed';
const NOTIFIED_KEY = 'agent-office.calendar.notified';
const SNOOZE_KEY = 'agent-office.calendar.snooze';
const SNOOZE_MS = 4 * 60 * 60 * 1000;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
export function onCalendarChores(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function officeClock(): { ms: number; utcOffset: number } {
  return { ms: Date.now(), utcOffset: store.sky?.utcOffset ?? -new Date().getTimezoneOffset() };
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window: the reminder comes back next time
  }
}

function storedNumber(key: string): number {
  return Number(stored(key)) || 0;
}

export function choresPending(): boolean {
  const { ms, utcOffset } = officeClock();
  return choresStillDue(officeDate(ms, utcOffset), stored(DISMISSED_KEY));
}

export function markChoresDone() {
  const { ms, utcOffset } = officeClock();
  storeValue(DISMISSED_KEY, monthKey(officeDate(ms, utcOffset)));
  emit();
}

function markNotified() {
  const { ms, utcOffset } = officeClock();
  storeValue(NOTIFIED_KEY, monthKey(officeDate(ms, utcOffset)));
}

export function openCalendar() {
  const clock = () => officeClock();
  let view = officeDate(clock().ms, clock().utcOffset);
  let selected = view.day;
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '×');
  const body = h('div.body');
  const doneBtn = h('button.btn.primary', { type: 'button' }, 'Done for this month');
  const el = h('div.modal.calendar', { role: 'dialog', 'aria-label': 'Calendar' },
    h('header', {}, h('h2', {}, '📅 Calendar'), close),
    body,
    h('footer', {}, h('span.grow', {}, 'The first of every month'), doneBtn),
  );
  const modal = openModal(el, { doing: '📅 looking at the calendar' });
  close.onclick = () => modal.close();
  doneBtn.onclick = () => {
    markChoresDone();
    toast('📅 Marked done for this month');
    render();
  };

  const render = () => {
    const { ms, utcOffset } = clock();
    const today = officeDate(ms, utcOffset);
    const current = view.year === today.year && view.month === today.month;
    const pending = choresStillDue(today, stored(DISMISSED_KEY));
    doneBtn.disabled = !current || !pending;
    doneBtn.textContent = current && !pending ? 'Done for this month ✓' : 'Done for this month';
    const chores = choresOnDay(selected);
    const weeks = monthGrid(view.year, view.month);
    body.replaceChildren(
      h('div.cal-nav', {},
        h('button.btn', { type: 'button', 'aria-label': 'Previous month', onclick: () => { view = { ...shiftMonth(view, -1), day: 1 }; selected = 1; render(); } }, '‹'),
        h('h3', {}, monthTitle(view)),
        h('button.btn', { type: 'button', 'aria-label': 'Next month', onclick: () => { view = { ...shiftMonth(view, 1), day: 1 }; selected = 1; render(); } }, '›'),
      ),
      h('div.cal-weekdays', {}, ...WEEKDAYS.map(d => h('span', {}, d))),
      h('div.cal-grid', {}, ...weeks.flatMap(week => week.map(day => {
        if (!day) return h('span.cal-day.empty', {});
        const on = choresOnDay(day);
        const isToday = current && day === today.day;
        const isSel = day === selected;
        return h('button.cal-day', {
          type: 'button',
          class: [isToday && 'today', isSel && 'selected', on.length && 'has-chores'].filter(Boolean).join(' '),
          onclick: () => { selected = day; render(); },
        }, String(day), on.length ? h('span.cal-dots', { 'aria-hidden': 'true' }, ...on.map(() => h('i'))) : null);
      }))),
      h('div.cal-chores', {},
        h('h3', {}, selected === 1 ? 'First of the month' : current && selected === today.day ? 'Today' : `${monthTitle(view)} ${selected}`),
        chores.length
          ? h('ul', {}, ...chores.map(c => h('li', {}, h('span.cal-icon', {}, c.icon), h('div', {}, h('b', {}, c.title), h('p', {}, c.detail), choreButton(c)))))
          : h('p.cal-empty', {}, 'Nothing on this day. The monthly chores sit on the 1st.'),
      ),
    );
  };
  render();
}

/** The button that opens a chore's own screen, when it has one: the cleanup screen for the branch cleanup. */
function choreButton(c: CalendarChore): HTMLElement | null {
  if (c.opens !== 'cleanup') return null;
  return h('button.btn.cal-open', { type: 'button', title: 'Pick a floor and a repository, then which branches and worktrees to keep', onclick: () => openCleanup() }, '🧹 Open the cleanup');
}

/**
 * On the first of the month (and until you mark that month done): a card in the office, and a
 * desktop notification if the tab is in the background.
 */
export function mountCalendarNag(opts: { desktop: () => boolean }) {
  let card: HTMLElement | null = null;
  let lastShown = 0;
  const hide = () => {
    card?.remove();
    card = null;
  };
  const showCard = () => {
    lastShown = Date.now();
    hide();
    card = h('div.calendar-nag', { role: 'status' },
      h('div.mail-nag-who', {}, h('span.mail-nag-face', { 'aria-hidden': 'true' }, '📅'), h('b', {}, 'First of the month'), h('button.mail-nag-x', { type: 'button', 'aria-label': 'Not now', title: 'Not now', onclick: hide }, '✕')),
      h('ul', {}, ...MONTHLY_CHORES.map(c => h('li', {}, `${c.icon} ${c.title} `, choreButton(c)))),
      h('div.mail-nag-actions', {},
        h('button.btn.primary', { type: 'button', onclick: () => { hide(); openCalendar(); } }, '📅 Open calendar'),
        h('button.btn', { type: 'button', onclick: () => { markChoresDone(); hide(); toast('📅 Marked done for this month'); } }, 'Done for this month'),
        h('button.btn', { type: 'button', onclick: () => { storeValue(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); hide(); toast('📅 Okay, I’ll ask again later'); } }, 'Not now'),
      ),
    );
    (document.getElementById('hud') ?? document.body).append(card);
  };
  const notifyDesktop = () => {
    if (!opts.desktop() || notifyPermission() !== 'granted') return;
    try {
      const n = new Notification(choreNotificationTitle(), {
        body: choreNotificationBody(),
        icon: '/favicon.svg',
        tag: 'calendar-chores',
      });
      n.onclick = () => {
        window.focus();
        n.close();
        openCalendar();
      };
    } catch {
      // Chrome on Android only shows them from a service worker
    }
  };
  const check = () => {
    const { ms, utcOffset } = officeClock();
    const today = officeDate(ms, utcOffset);
    if (!choresStillDue(today, stored(DISMISSED_KEY))) return hide();
    if (shouldNotify(today, stored(DISMISSED_KEY), stored(NOTIFIED_KEY))) {
      markNotified();
      if (document.hidden) notifyDesktop();
      else showCard();
      return;
    }
    if (card || Date.now() < storedNumber(SNOOZE_KEY) || Date.now() - lastShown < SNOOZE_MS) return;
    if (!document.hidden) showCard();
  };
  onCalendarChores(() => {
    if (!choresPending()) hide();
  });
  setTimeout(check, 8_000);
  setInterval(check, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const { ms, utcOffset } = officeClock();
      const today = officeDate(ms, utcOffset);
      if (shouldNotify(today, stored(DISMISSED_KEY), stored(NOTIFIED_KEY))) {
        markNotified();
        notifyDesktop();
      }
      return;
    }
    check();
  });
  return { check, hide };
}
