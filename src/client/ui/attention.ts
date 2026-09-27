import { attentionFloors } from '../../shared/attention';
import { floorPalette } from '../../shared/floors';
import type { WorkerAttention } from '../../shared/protocol';
import { store } from '../state';
import { $, h } from './dom';

const LABEL: Record<WorkerAttention['reason'], string> = { needs_input: 'Needs input', done: 'Done', error: 'Error' };

export function mountAttention(openWorker: (floorId: string, workerId: string) => void, ride: (floorId: string) => void) {
  const render = () => {
    const floors = attentionFloors(store.floors, store.floor, store.workers.values());
    const entries = floors.flatMap((f) => f.attention ?? []);
    const total = floors.reduce((n, f) => n + f.waiting, 0);
    const badge = $('attention-count');
    if (badge.textContent !== String(total)) badge.textContent = String(total);
    badge.classList.toggle('quiet', !total);
    badge.setAttribute('aria-label', `${total} worker${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} your attention`);
    const summary = (['needs_input', 'done', 'error'] as const).flatMap((reason) => {
      const count = entries.filter((w) => w.reason === reason).length;
      const label = reason === 'needs_input' ? `${count === 1 ? 'needs' : 'need'} input` : reason === 'error' ? `error${count === 1 ? '' : 's'}` : 'done';
      return count ? [`${count} ${label}`] : [];
    });
    $('attention-summary').textContent = total ? summary.join(' · ') || `${total} waiting across all floors` : 'All caught up.';

    // Keep a keyboard user's place when background worker updates redraw the list.
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.closest('#attention-floors') ? active.dataset.attentionKey : undefined;
    const list = $('attention-floors');
    const scrollTop = list.scrollTop;
    list.replaceChildren(...floors.map((floor, index) => {
      const here = floor.id === store.floor;
      const workers = floor.attention ?? [];
      const floorLabel = `Floor ${index + 1}: ${floor.name}${here ? ' (you are here)' : ''}`;
      const stats = floor.cloning ? 'Cloning…' : `${floor.workers} worker${floor.workers === 1 ? '' : 's'} · ${floor.busy} working`;
      return h('div.attention-floor', {},
        h('button.attention-floor-button', {
          type: 'button', disabled: floor.cloning || here, 'data-attention-key': `floor:${floor.id}`,
          title: `${floorLabel} — ${stats}`, 'aria-label': `${floorLabel}, ${stats}, ${floor.waiting} need attention`,
          onclick: () => ride(floor.id),
        },
        h('span.attention-floor-number', { style: `background:${floorPalette(floor.palette).trim}` }, String(index + 1)),
        h('span.attention-text', {}, h('span.attention-name', {}, floor.name), h('span.attention-detail', {}, here ? `Here · ${stats}` : stats)),
        floor.waiting ? h('span.attention-badge.small', {}, floor.waiting) : null),
        workers.length ? h('ul', {}, ...workers.map((w) => h('li', {},
          h('button.attention-worker', {
            type: 'button', 'data-attention-key': `worker:${floor.id}:${w.id}`,
            title: `${w.name} — ${LABEL[w.reason]}${w.detail ? `: ${w.detail}` : ''}. Open terminal`,
            onclick: () => openWorker(floor.id, w.id),
          },
          h('span.dot', { style: `background:${w.color}` }),
          h('span.attention-text', {}, h('span.attention-name', {}, w.name), w.detail ? h('span.attention-detail', {}, w.detail) : null),
          h('span.attention-reason', { class: w.reason }, LABEL[w.reason])),
        ))) : null,
      );
    }));
    if (!floors.length) list.append(h('p.empty', {}, 'Add a floor in the elevator to see its workers.'));
    if (focused) {
      const target = [...list.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.dataset.attentionKey === focused);
      (target ?? $('attention-title')).focus({ preventScroll: true });
    }
    list.scrollTop = scrollTop;
  };
  $('attention-title').tabIndex = -1;
  const off = (['workers', 'floors', 'floor'] as const).map((topic) => store.on(topic, render));
  render();
  return () => off.forEach((unsubscribe) => unsubscribe());
}
