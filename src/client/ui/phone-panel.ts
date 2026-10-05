import { fmtAgo, fmtClock } from '../../shared/ago';
import type { PhoneCall } from '../../shared/protocol';
import { store } from '../state';
import { $, h } from './dom';

const callKey = (c: PhoneCall) => `${c.at}:${c.workerId}`;

/** Who rang, newest first: "5 mins ago · 2:04 PM". Click to stand behind them. */
export function mountPhone(go: (call: PhoneCall) => void) {
  const render = () => {
    const calls = [...store.calls].reverse();
    const count = $('phone-count');
    count.textContent = calls.length ? String(calls.length) : '';
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.closest('#phone-log') ? active.dataset.callKey : undefined;
    const list = $('phone-log');
    const scrollTop = list.scrollTop;
    if (!calls.length) {
      list.replaceChildren(h('li.phone-empty', {}, 'No calls yet. The phone rings when a worker finishes.'));
      return;
    }
    list.replaceChildren(...calls.map((c) => {
      const when = `${fmtAgo(c.at)} · ${fmtClock(c.at)}`;
      const where = [c.name, c.task].filter(Boolean).join(' · ');
      return h('li', {}, h('button.phone-call', {
        type: 'button',
        'data-call-key': callKey(c),
        title: `Show up behind ${c.worker}${where ? ` — ${where}` : ''}. ${when}`,
        onclick: () => go(c),
      },
      h('span.dot', { style: `background:${c.color}` }),
      h('span.phone-text', {},
        h('span.phone-name', {}, c.worker),
        where ? h('span.phone-detail', {}, where) : null,
        h('span.phone-when', {}, when),
      )));
    }));
    if (focused) {
      const target = [...list.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.dataset.callKey === focused);
      target?.focus({ preventScroll: true });
    }
    list.scrollTop = scrollTop;
  };
  store.on('calls', render);
  setInterval(render, 30_000);
  render();
}
