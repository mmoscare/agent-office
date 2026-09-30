import './vp-panel.css';
import './cleanbot-panel.css';
import { BOTS, botDesk } from '../../shared/bots';
import { ROOF } from '../../shared/rooftop';
import { store } from '../state';
import { h } from './dom';

// CleanBot's corner of the floor menu (next to the VP's): deploy him on this floor, or open his
// terminal once he's here. He does the cleanup with the owner in his terminal; the office's own
// checks (server/prune-floor.ts) decide what's safe.

export interface CleanbotPanelOptions {
  deploy(): void;
  /** Open his terminal, once he's here. */
  open(workerId: string): void;
}

/** CleanBot's section for the floor you're on, or null up on the roof or with no floor. */
export function cleanbotSection(opts: CleanbotPanelOptions): HTMLElement | null {
  if (!store.floor || store.floor === ROOF) return null;
  const bot = BOTS.cleanbot;
  const him = store.workerAtDesk(botDesk('cleanbot'));
  let action: HTMLElement;
  if (him) {
    action = h('button.vp-deploy', { type: 'button', title: 'Open his terminal' }, `💬 ${him.status === 'working' ? 'Working' : him.status === 'needs_input' ? 'Needs you' : 'Here'}: open his terminal`);
    action.addEventListener('click', () => opts.open(him.id));
  } else {
    action = h('button.vp-deploy', { type: 'button', title: `Hire ${bot.name} at his kiosk in the lounge: he lists this floor's leftover branches and worktrees, suggests what to delete, and deletes only what you say` }, `${bot.icon} Deploy ${bot.name}`);
    action.addEventListener('click', () => opts.deploy());
  }
  return h(
    'div.vp-section.cleanbot-section',
    { 'data-cleanbot': him ? 'here' : 'away' },
    h('div.vp-head', {}, h('span.vp-badge', {}, bot.icon), `${bot.name} on this floor`),
    action,
    h('div.vp-line', {}, 'Suggests which leftover branches and worktrees to delete; keeps anything that holds work or that a worker, the PR agent, the VP or a queued task still needs.'),
  );
}
