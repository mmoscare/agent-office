import type { OfficeStatus } from '../../shared/git-board';
import { h, timeAgo } from './dom';
import { openManual } from './manual';
import { openOfficeUpdate } from './office-update';

// The Git board's "🏢 Running office" bar: whether the office is running the latest of its own code
// (pulled from GitHub, built, restarted onto the build), and when it isn't, the button that walks
// through updating it one step at a time (ui/office-update.ts). The same steps as PowerShell
// commands are in the manual's "Merging an agent-office PR, step by step".

function pill(done: boolean, yes: string, no: string, tip: string): HTMLElement {
  return h('span.office-pill', { class: done ? 'done' : 'todo', title: tip }, done ? `✓ ${yes}` : no);
}

export function renderOfficeStatus(el: HTMLElement, s: OfficeStatus | null, open: boolean): void {
  el.replaceChildren();
  el.hidden = !s;
  if (!s) return;
  const { needs } = s;
  const upToDate = !needs.pull && !needs.build && !needs.restart;
  const pills = h(
    'span.office-pills',
    {},
    pill(!needs.pull, s.upstream ? `same as ${s.upstream}` : 'pulled', `↓${s.behind} to pull`, s.upstream ? `Its code compared with ${s.upstream}${s.fetchedAt ? ` (GitHub checked ${timeAgo(s.fetchedAt)})` : ''}` : 'Not tracking a GitHub branch'),
    pill(!needs.build, 'built', 'needs build', s.builtAt ? `Last built ${timeAgo(s.builtAt)}` : 'Never built'),
    pill(!needs.restart && !needs.build && !needs.pull, 'running latest', 'needs restart', `The office started ${timeAgo(s.startedAt)}`),
  );
  const summary = h('summary', {}, h('span.office-title', {}, upToDate ? '🏢 The running office is up to date' : '🏢 The running office needs updating'), pills, h('span.office-toggle', {}));
  const details = h('details.office-status', { class: upToDate ? 'ok' : 'todo' }, summary);
  if (open) details.setAttribute('open', '');

  const walk = h('button.btn.primary', { type: 'button' }, '👉 Update the office step by step');
  walk.addEventListener('click', openOfficeUpdate);
  const manual = h('button.btn', { type: 'button', title: 'The same steps as PowerShell commands' }, '📘 By hand');
  manual.addEventListener('click', () => openManual('merge-steps'));
  if (!upToDate) {
    details.append(
      h('div.office-body', {},
        h('p.office-note', {}, 'It runs from ', h('code', {}, s.dir), '. The walkthrough pulls, builds and restarts it one step at a time, and checks each step worked.'),
        s.dirty ? h('p.office-warn', {}, `⚠️ ${s.dirty} file${s.dirty === 1 ? ' has' : 's have'} uncommitted changes there (someone’s work in progress). The pull stops rather than touch them.`) : null,
        h('div.office-actions', {}, walk, manual),
      ),
    );
  } else details.append(h('div.office-body', {}, h('p.office-note', {}, `It runs from `, h('code', {}, s.dir), `${s.branch ? ` on ${s.branch}` : ''}. When you merge a pull request for Agent Office, the walkthrough to update it appears here and across the top.`)));
  if (s.error) details.append(h('p.office-warn', {}, `Couldn't check everything: ${s.error}`));
  el.append(details);
}
