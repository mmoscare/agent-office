import type { OfficeStatus } from '../../shared/git-board';
import { codeBox } from './copy-code';
import { h, timeAgo } from './dom';
import { openManual } from './manual';

// The Git board's "🏢 Running office" bar: whether the office is running the latest of its own code
// (pulled from GitHub, built, restarted onto the build), and for whatever isn't done yet, the next
// steps with the folder to run them in and commands to copy. The steps are numbered as in the
// manual's "Merging an agent-office PR, step by step" (3 is pulling the floor on the Git board).

function pill(done: boolean, yes: string, no: string, tip: string): HTMLElement {
  return h('span.office-pill', { class: done ? 'done' : 'todo', title: tip }, done ? `✓ ${yes}` : no);
}

function step(n: string, title: string, ...body: (Node | null)[]): HTMLElement {
  return h('li.office-step', {}, h('div.office-step-title', {}, h('b', {}, `Step ${n}`), ' ', title), ...body);
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

  const steps = h('ol.office-steps');
  const quoted = `cd "${s.dir}"`;
  if (needs.pull) {
    steps.append(
      step(
        '4–5',
        'Pull the new code into the office’s folder',
        s.dirty ? h('p.office-warn', {}, `⚠️ ${s.dirty} file${s.dirty === 1 ? ' has' : 's have'} uncommitted changes there (someone’s work in progress). git status lists them: commit or finish them before pulling.`) : null,
        codeBox(`${quoted}\ngit status\ngit pull`).el,
        h('p.office-note', {}, 'If git pull says CONFLICT: run ', h('code', {}, 'git merge --abort'), ' and ask Claude to “update the app folder”, or see the manual’s steps.'),
      ),
      step('6', 'Check it worked: the first line must not say “behind”', codeBox('git status -sb', s.dir).el),
    );
  }
  if (needs.pull || needs.build) steps.append(step('7', 'Build it', codeBox(needs.pull ? 'npm run build' : `${quoted}\nnpm run build`, needs.pull ? s.dir : undefined).el));
  const manual = h('button.btn', { type: 'button' }, '📘 The start command');
  manual.addEventListener('click', () => openManual('merge-steps'));
  steps.append(step('8', 'Restart the office when your workers are idle: Ctrl+C in its window, then start it again. Then tell busy workers “continue”.', h('div', {}, manual)));
  if (!upToDate) details.append(h('div.office-body', {}, h('p.office-note', {}, 'Run these in PowerShell. ', h('code', {}, s.dir), ' is the folder the office runs from.'), steps));
  else details.append(h('div.office-body', {}, h('p.office-note', {}, `It runs from `, h('code', {}, s.dir), `${s.branch ? ` on ${s.branch}` : ''}. When you merge a pull request for Agent Office, the steps to update it appear here.`)));
  if (s.error) details.append(h('p.office-warn', {}, `Couldn't check everything: ${s.error}`));
  el.append(details);
}
