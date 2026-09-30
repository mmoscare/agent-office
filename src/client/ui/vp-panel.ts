import './vp-panel.css';
import { BOTS, botDesk } from '../../shared/bots';
import { ROOF } from '../../shared/rooftop';
import { store } from '../state';
import { h } from './dom';

// The VP's corner of the floor menu: deploy him on this floor, put him on standing duty (admins: it's
// the owner's standing approval for verified merges), and see what he's on and how many merges wait
// for a restart. The office does the work (see server/vp.ts); this only shows it and sends the switch.

export interface VpPanelOptions {
  deploy(): void;
  duty(on: boolean): void;
  /** Open his terminal, once he's here. */
  open(workerId: string): void;
}

const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** The VP's section for the floor you're on, or null up on the roof or with no floor. */
export function vpSection(opts: VpPanelOptions): HTMLElement | null {
  if (!store.floor || store.floor === ROOF) return null;
  const bot = BOTS.vp;
  const v = store.vp;
  const vp = store.workerAtDesk(botDesk('vp'));
  const admin = store.me.admin;
  const lines: HTMLElement[] = [];
  if (vp) {
    const open = h('button.vp-deploy', { type: 'button', title: 'Open his terminal' }, `💬 ${vp.status === 'working' ? 'Working' : vp.status === 'needs_input' ? 'Needs you' : 'Here'}: open his terminal`);
    open.addEventListener('click', () => opts.open(vp.id));
    lines.push(open);
  } else {
    const deploy = h('button.vp-deploy', { type: 'button', title: `Hire the ${bot.name} at his kiosk in the lounge, with his brief` }, `${bot.icon} Deploy the ${bot.name}`);
    deploy.addEventListener('click', () => opts.deploy());
    lines.push(deploy);
  }
  const d = v.duty;
  const box = h('input', { type: 'checkbox', checked: !!d?.on, disabled: !admin }) as HTMLInputElement;
  box.addEventListener('change', () => opts.duty(box.checked));
  const minutes = Math.round((d?.everyMs ?? 600_000) / 60_000);
  lines.push(
    h(
      `label.vp-duty${admin ? '' : '.locked'}`,
      { title: admin ? 'Standing duty: the office sweeps the PRs by itself and merges what verifies, by the owner\'s five rules' : 'Only admins can put the VP on duty' },
      box,
      h('span', {}, 'On duty', h('small', {}, d?.on ? `Sweeping every ${minutes} min · turned on by ${d.by}, ${ago(d.at)}` : `Sweeps the PRs every ${minutes} min, merges what verifies, and helps stuck workers${d?.by ? ` · turned off by ${d.by}` : ''}`)),
    ),
  );
  if (v.job) lines.push(h('div.vp-line', {}, `Now: ${v.job.what}${v.job.last ? ` — ${v.job.last.replace(/^\d\d:\d\d:\d\d /, '')}` : ''}`));
  else if (v.lastSweep) lines.push(h('div.vp-line', {}, `Last sweep ${ago(v.lastSweep.at)}: ${v.lastSweep.summary}`));
  if (v.verifying && !v.job) lines.push(h('div.vp-line', {}, `The building's verify slot: ${v.verifying}`));
  if (v.waitingRestart) lines.push(h('div.vp-line.restart', {}, `🔁 ${v.waitingRestart} merge${v.waitingRestart === 1 ? '' : 's'} waiting for a restart`));
  return h('div.vp-section', { 'data-vp': vp ? 'here' : 'away' }, h('div.vp-head', {}, h('span.vp-badge', {}, bot.icon), `The ${bot.name} on this floor`), ...lines);
}
