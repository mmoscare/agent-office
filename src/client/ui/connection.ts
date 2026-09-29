// Making a lost office server impossible to miss: a red screen over everything that says how long
// it has been gone and keeps trying, a warning in the tab title, a sound, and a desktop
// notification when you're in another tab. It clears by itself once the office answers again.

import type { Net } from '../net';
import { h, toast } from './dom';

/** A blip shorter than this reconnects before anyone needs telling. */
export const SHOW_AFTER_MS = 1_500;
/** An upgrade restarts the office on purpose and has its own screen; this only steps in if it never comes back. */
export const SHOW_AFTER_RESTART_MS = 90_000;

/** "42s", "3m 05s", "1h 02m": how long the office has been gone. */
export function downFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

let shown = false;
/** The alarm is up: the tab title says so too. */
export const connectionLost = () => shown;

export interface ConnectionAlarm {
  /** The tab title changes with it. */
  onChange: () => void;
  /** The office stopped answering (only the first time, not on each try). */
  onLost?: () => void;
  /** It's back, after `ms` gone. */
  onBack?: (ms: number) => void;
}

export function watchConnection(net: Net, alarm: ConnectionAlarm) {
  const since = h('span.server-down-since');
  const tries = h('span.server-down-tries');
  const retry = h('button.btn.primary', { type: 'button', onclick: () => net.retryNow() }, 'Retry now');
  const title = h('h2', {}, 'Lost connection to the office server');
  const el = h(
    'div.server-down.hidden',
    { role: 'alertdialog', 'aria-modal': 'true', 'aria-live': 'assertive', 'aria-label': 'Lost connection to the office server' },
    h(
      'div.server-down-card',
      {},
      h('div.server-down-icon', { 'aria-hidden': 'true' }, '🔌'),
      title,
      h('p.server-down-lead', {}, 'The office server has not answered for ', since, '.'),
      h('p.server-down-note', {}, 'Nothing you do here reaches the office until it is back. This page keeps trying and clears this screen by itself when it reconnects.'),
      h('p.server-down-status', {}, h('span.spinner'), tries),
      h('div.server-down-actions', {}, retry, h('button.btn', { type: 'button', onclick: () => location.reload() }, 'Reload page')),
    ),
  );
  document.body.append(el);

  let clock: ReturnType<typeof setInterval> | undefined;
  /** When it went; the net forgets as soon as it's back, and the back-online message needs it. */
  let downAt = 0;
  const render = () => {
    const gone = Date.now() - downAt;
    if (!shown) {
      if (net.up || gone < (net.restarting ? SHOW_AFTER_RESTART_MS : SHOW_AFTER_MS)) return;
      shown = true;
      title.textContent = net.restarting ? 'The office has not come back from its restart' : 'Lost connection to the office server';
      el.classList.remove('hidden');
      // Whatever had the keyboard can't do anything now; Retry is the thing to press.
      retry.focus({ preventScroll: true });
      alarm.onChange();
      alarm.onLost?.();
    }
    since.textContent = downFor(gone);
    tries.textContent = net.attempts ? `Trying to reconnect… (${net.attempts} ${net.attempts === 1 ? 'try' : 'tries'} so far)` : 'Trying to reconnect…';
  };

  net.onStatus((up) => {
    if (!up) {
      downAt = net.downSince || Date.now();
      clearInterval(clock);
      clock = setInterval(render, 500);
      render();
      return;
    }
    clearInterval(clock);
    if (!shown) return;
    const gone = Date.now() - downAt;
    shown = false;
    el.classList.add('hidden');
    alarm.onChange();
    alarm.onBack?.(gone);
    toast(`✅ Back online — the office server was unreachable for ${downFor(gone)}`);
  });
}
