import type { GhPull } from '../../shared/protocol';
import { PULL_WORK_LABEL, pullWorkers, pullWorkStatus } from '../../shared/pull-work';
import { store } from '../state';
import { h } from './dom';

/** Shared by the board card and PR window; updates come from worker broadcasts. */
export function pullWorkIndicators(pr: GhPull, goToDesk: (desk: string) => void): HTMLElement[] {
  if (pr.state !== 'OPEN') return [];
  return pullWorkers(store.workers.values(), pr).map(w => {
    const status = pullWorkStatus(w);
    return h('button.pr-work', {
      type: 'button', class: status.tone,
      title: `${w.name}: ${PULL_WORK_LABEL[w.pullWork!.action]}. Go to their desk. Turn finished does not confirm the PR is fixed or merged.`,
      onclick: (e: Event) => { e.stopPropagation(); goToDesk(w.deskId); },
      onkeydown: (e: Event) => e.stopPropagation(),
    }, h('span.pr-work-dot', { 'aria-hidden': 'true', class: status.active ? 'running' : '' }),
    `${status.text} · ${w.name} · ${PULL_WORK_LABEL[w.pullWork!.action]}`);
  });
}
