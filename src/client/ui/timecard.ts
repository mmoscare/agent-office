import { dayKey, decimalHours, hoursText, liveStints, nextDay, startOfDay, startOfWeek, timeBetween, timeDays, TIMECARD_GRACE_MS } from '../../shared/timecard';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';

/** How many days the card lists; the CSV has every day the office kept. */
const DAYS_SHOWN = 14;

/** Your time in the office today, as it stands now. */
export function todayText(now = Date.now()): string {
  return hoursText(timeBetween(liveStints(store.timecard, now), startOfDay(now), now));
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clock24 = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

let opened = false;
/** The 🗂️ Indirect Time card: when you had the office open, per day, on any floor. */
export function openTimeCard(net: Net) {
  if (opened) return;
  opened = true;
  const who = h('p.timecard-who');
  const error = h('p.err', { role: 'alert' });
  const totals = h('div.timecard-totals');
  const days = h('ol.timecard-days', { 'aria-label': 'Hours per day' });
  const csv = h('button.btn', { type: 'button', title: 'Every stint the office kept, one row per day, for a timesheet', onclick: download }, '⬇️ CSV');
  const el = h('div.modal.timecard-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Indirect Time' },
    h('header', {}, h('h2', {}, '🗂️ Indirect Time'), csv),
    h('div.body', {},
      who,
      h('p.note', {}, `Hours with the office open in your browser, on any floor. You're clocked in when your first window opens and out when your last one closes; back within ${TIMECARD_GRACE_MS / 60_000} minutes (a reload, a restart) is the same stint.`),
      error, totals, days));

  function render() {
    const now = Date.now();
    const card = store.timecard;
    const stints = liveStints(card, now);
    who.textContent = card.name ? `${card.name}${card.open ? ' · clocked in' : ''}` : '';
    error.textContent = card.saveError ?? '';
    const today = startOfDay(now);
    totals.replaceChildren(
      total('Today', timeBetween(stints, today, now)),
      total('This week', timeBetween(stints, startOfWeek(now), now), 'Since Monday'),
    );
    const byDay = new Map(timeDays(stints).map((d) => [d.day, d]));
    const rows: HTMLElement[] = [];
    for (let i = 0, at = today; i < DAYS_SHOWN; i++, at = startOfDay(at - 1)) {
      const day = byDay.get(dayKey(at));
      const date = new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      // Only a stint that's still going ends right now.
      const spans = (day?.stints ?? []).map((s) => `${clock(s.start)}–${card.open && s.end === now ? 'now' : clock(s.end)}`);
      rows.push(h(`li.timecard-day${day ? '' : '.empty'}${at === today ? '.today' : ''}`, {},
        h('span.timecard-date', {}, date),
        h('span.timecard-spans', {}, spans.join(', ') || '—'),
        h('span.timecard-hours', { title: day ? `${decimalHours(day.ms)} hours` : '' }, day ? hoursText(day.ms) : '')));
    }
    days.replaceChildren(...rows);
  }
  function total(label: string, ms: number, title?: string) {
    return h('div.timecard-total', { title: title ?? '' }, h('span', {}, label), h('strong', {}, hoursText(ms)), h('small', {}, `${decimalHours(ms)} h`));
  }
  function download() {
    const lines = ['Date,Clock in,Clock out,Hours'];
    const all = timeDays(liveStints(store.timecard, Date.now())).reverse();
    for (const d of all) for (const s of d.stints) lines.push([d.day, clock24(s.start), s.end === nextDay(s.start) ? '24:00' : clock24(s.end), decimalHours(s.end - s.start)].join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' })), download: `indirect-time-${dayKey(Date.now())}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // The card ticks along while it's open.
  const timer = setInterval(render, 30_000);
  const unsub = store.on('timecard', render);
  openModal(el, { doing: 'checking the time card', onClose: () => { opened = false; clearInterval(timer); unsub(); } });
  render();
  net.send({ t: 'timecard' });
}
