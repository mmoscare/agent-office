import { floorPalette } from '../../shared/floors';
import type { FloorInfo } from '../../shared/protocol';
import { floorRoster, rosterFloors, type RosterEntry } from '../../shared/roster';
import { store } from '../state';
import { h, openModal, STATUS_LABEL } from './dom';
import './clipboard.css';

/**
 * Every floor and who's working there right now. With no floors yet (a single-project office), the
 * workers here under the project's name.
 */
export function currentRoster(): { floor: FloorInfo | null; roster: RosterEntry[] }[] {
  if (store.floors.length) return rosterFloors(store.floors, store.floor, store.workers.values());
  return [{ floor: null, roster: floorRoster(store.workers.values(), store.project?.name ?? 'this project') }];
}

/**
 * The queue agent's clipboard, read up close: every worker on every floor, the repository it's in
 * first, then who it is and what it's on. A row opens that worker's terminal (riding up if need be).
 */
export function openClipboard(openWorker: (floorId: string | null, workerId: string) => void) {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const body = h('div.body.clipboard');
  const el = h(
    'div.modal.clipboard-modal',
    { role: 'dialog', 'aria-label': "Queue agent's clipboard" },
    h('header', {}, h('h2', {}, "📋 Who's on what"), close),
    body,
    h('footer', {}, h('span.grow', {}, 'The Queue agent keeps this up to date. Pick a worker to open its terminal.')),
  );
  const render = () => {
    const floors = currentRoster();
    const scroll = body.scrollTop;
    const total = floors.reduce((n, f) => n + f.roster.length, 0);
    body.replaceChildren(
      ...floors.map(({ floor, roster }, i) => {
        const here = !floor || floor.id === store.floor;
        const repo = floor ? floor.repo || floor.name : (store.project?.name ?? 'This project');
        return h(
          'section.clipboard-floor',
          {},
          h(
            'h3',
            {},
            floor ? h('span.clipboard-floor-number', { style: `background:${floorPalette(floor.palette).trim}` }, String(i + 1)) : null,
            h('span.clipboard-repo', { title: floor?.dir ?? '' }, `📁 ${repo}`),
            h('span.clipboard-count', {}, `${roster.length} ${roster.length === 1 ? 'worker' : 'workers'}${here && floor ? ' · you are here' : ''}`),
          ),
          roster.length
            ? h('ul', {}, ...roster.map((e) => h('li', {}, row(e, () => {
                modal.close();
                openWorker(floor?.id ?? null, e.id);
              }))))
            : h('p.empty', {}, floor?.cloning ? 'Still cloning…' : 'Nobody working here.'),
        );
      }),
    );
    if (!total && !floors.length) body.append(h('p.empty', {}, 'Nobody hired yet.'));
    body.scrollTop = scroll;
  };
  const unsubs = (['workers', 'floors', 'floor', 'project'] as const).map((topic) => store.on(topic, render));
  const modal = openModal(el, { doing: '📋 reading the clipboard', onClose: () => unsubs.forEach((u) => u()) });
  close.addEventListener('click', () => modal.close());
  render();
}

function row(e: RosterEntry, open: () => void): HTMLElement {
  return h(
    'button.clipboard-row',
    { type: 'button', title: `Open ${e.name}'s terminal`, onclick: open },
    // Where it's working, before anything else.
    h('span.clipboard-repos', {}, ...e.repos.map((r) => h('span.clipboard-repo-chip', {}, r)), e.branch ? h('span.clipboard-branch', {}, e.branch) : null),
    h('span.clipboard-who', {}, h('span.dot', { style: `background:${e.color}` }), h('b', {}, e.name), h('span.clipboard-status', { class: e.status }, STATUS_LABEL[e.status] ?? e.status)),
    h('span.clipboard-doing', {}, e.doing || 'Waiting for a task'),
  );
}
