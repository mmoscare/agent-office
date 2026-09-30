import { budgetWarnings, dayBudget, overBudget, type DayBudget } from '../../shared/limit-budget';
import type { PlanWindow } from '../../shared/protocol';
import { store } from '../state';
import { $, h, toast } from './dom';
import { panelHide } from './menu';

/** Numbers older than this say when they were read. */
const STALE_MS = 10 * 60_000;
/** The budget days already warned about in this browser (see budgetDayKey). */
const WARNED_KEY = 'agent-office.limits.budget-warned';
const WARNED_KEEP = 32;

/** "in 12m", "in 2h 5m", or "Tue 5:00 AM" once it is more than a day out. */
export function fmtReset(at: number, now = Date.now()): string {
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const level = (pct: number) => (pct >= 90 ? 'over' : pct >= 75 ? 'near' : '');
const fmtWhen = (at: number) => new Date(at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
const fmtPct = (pct: number) => `${pct.toFixed(1).replace(/\.0$/, '')}%`;
const weekName = (w: PlanWindow) => (w.label === 'Week' ? 'the week (all models)' : `the ${w.label}`);

function windowRow(w: PlanWindow, now: number): HTMLElement[] {
  const pct = Math.round(w.pct);
  const when = w.resetsAt ? fmtWhen(w.resetsAt) : '';
  const scope = w.label === 'Week' ? ' (all models)' : '';
  const title = `${w.label}${scope}: ${pct}% used${when ? `\nStarts over ${when}` : ''}`;
  const budget = dayBudget(w, now);
  return [
    h(
      'div.row',
      { title },
      h('span.what', {}, w.label),
      h('b', { class: level(w.pct) }, `${pct}%`),
      w.resetsAt ? h('span.reset', {}, `resets ${fmtReset(w.resetsAt, now)}`) : null,
    ),
    h(
      'div.meter',
      { class: level(w.pct), title, role: 'progressbar', 'aria-label': w.label, 'aria-valuenow': pct },
      h('div.fill', { style: `width:${w.pct}%` }),
      // Today's budget: how far along the week may be by the end of today.
      budget ? h('i.mark', { style: `left:${budget.limit}%` }) : null,
    ),
    ...(budget ? budgetRows(w, budget, now) : []),
  ];
}

/** Today's equal share of a weekly limit: what's left of it, or how far over it the week is. */
function budgetRows(w: PlanWindow, b: DayBudget, now: number): HTMLElement[] {
  const over = overBudget(b);
  const cls = over ? 'over' : b.left < b.share / 4 ? 'near' : '';
  const title = budgetTitle(w, b);
  const amount = over ? (b.left > -0.5 ? 'used up' : `${Math.round(-b.left)}% over`) : b.left < 1 ? '<1% left' : `${Math.round(b.left)}% left`;
  const rows = [
    h(
      'div.row.budget-day',
      { title },
      h('span.what', {}, 'Today'),
      h('b', { class: cls }, amount),
      // Over: when the budget, with nothing more used, catches up. Otherwise: when the next share comes in.
      h('span.reset', {}, over ? `back ${fmtReset(b.backAt, now)}` : `+${Math.round(b.share)}% ${fmtReset(b.dayEndsAt, now)}`),
    ),
  ];
  if (over && b.runsOutAt !== undefined && w.pct < 100) rows.push(h('div.row.budget-pace', { title }, `At this pace, runs out ${fmtReset(b.runsOutAt, now)} (est.)`));
  return rows;
}

function budgetTitle(w: PlanWindow, b: DayBudget): string {
  const lines = [
    `Daily budget: an equal share of the week, ${fmtPct(b.share)} a day. Days start at ${new Date(b.dayEndsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}, when the week starts over, and what a day doesn't use carries into the next.`,
    `Day ${b.day} of 7: up to ${fmtPct(b.limit)} of ${weekName(w)} by ${fmtWhen(b.dayEndsAt)}. Used ${fmtPct(w.pct)}, ${overBudget(b) ? `${fmtPct(-b.left)} over` : `${fmtPct(b.left)} left`}.`,
  ];
  if (overBudget(b)) lines.push(`With nothing more used, back within budget ${fmtWhen(b.backAt)}.`);
  if (b.runsOutAt !== undefined && w.pct < 100) lines.push(`At the pace so far it runs out ${fmtWhen(b.runsOutAt)}, before it starts over (an estimate).`);
  return lines.join('\n');
}

/** The Claude plan's 5-hour session and weekly limits, under the workers. Click to read them again. */
export function renderLimits() {
  const s = store.limits;
  const el = $('limits');
  el.classList.toggle('hidden', !s.windows.length);
  if (!s.windows.length) return;
  const now = Date.now();
  const plan = s.plan ? s.plan.charAt(0).toUpperCase() + s.plan.slice(1) : '';
  el.replaceChildren(h('h3', {}, 'Claude limits', plan ? h('span.plan', {}, plan) : null, panelHide('limits')), ...s.windows.flatMap((w) => windowRow(w, now)));
  if (now - s.at > STALE_MS) el.append(h('div.row.muted', {}, `As of ${new Date(s.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`));
}

/** What the warning says about one weekly limit whose budget for today is spent. */
function warningLine(w: PlanWindow, b: DayBudget): string {
  const name = weekName(w);
  const resets = fmtWhen(w.resetsAt!);
  if (w.pct >= 100) return `${name.charAt(0).toUpperCase()}${name.slice(1)} is used up until ${resets}.`;
  const pace = b.runsOutAt !== undefined ? `at this pace it runs out ${fmtWhen(b.runsOutAt)} (est.), before it starts over ${resets}` : `slow down to make it last until ${resets}`;
  return `You're about to run out: ${name} is at ${Math.round(w.pct)}%, past today's budget of ${Math.round(b.limit)}%; ${pace}.`;
}

function loadWarned(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WARNED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function saveWarned(keys: string[]) {
  try {
    localStorage.setItem(WARNED_KEY, JSON.stringify(keys));
  } catch {
    // private mode: it may warn again after a reload
  }
}

/**
 * Warns once a day, in the office and on the desktop, when a weekly limit is past today's share of
 * it: keep going at that rate and it runs out before it starts over. Whether or not the meter is shown.
 */
export function watchLimitBudget(desktop: (title: string, body: string) => void) {
  const warned = loadWarned();
  store.on('limits', () => {
    const due = budgetWarnings(store.limits.windows, new Set(warned));
    if (!due.length) return;
    warned.push(...due.map((d) => d.key));
    warned.splice(0, Math.max(0, warned.length - WARNED_KEEP));
    saveWarned(warned);
    const title = "⏳ Today's Claude budget is used up";
    const body = due.map((d) => warningLine(d.window, d.budget)).join(' ');
    toast(`${title}. ${body}`, 'warn', 15_000);
    desktop(title, body);
  });
}
