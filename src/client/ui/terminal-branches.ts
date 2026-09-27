import type { WorkerBranch, WorkerInfo } from '../../shared/protocol';
import { h } from './dom';
import './terminal-branches.css';

/** New browser assets can be served by a still-running server from before branch reporting. */
export function terminalBranches() {
  const element = h('div.terminal-branches', { 'aria-label': 'Current Git branches', 'aria-live': 'polite' });
  let reported: WorkerBranch[] | undefined;
  let saved: WorkerBranch[] = [];
  let timedOut = false;
  let rendered: string | undefined;
  const render = () => {
    const live = reported !== undefined;
    const branches = reported ?? saved;
    const key = JSON.stringify([branches, live, timedOut]);
    if (key === rendered) return;
    rendered = key;
    const badges = branches.length ? branches.map(info => {
      const value = info.branch ?? (info.commit ? `Detached HEAD · ${info.commit}` : 'No Git branch');
      const label = (info.repository ? `${info.repository}: ${value}` : `Branch: ${value}`) + (live ? '' : ' (last known)');
      return h('span.terminal-branch', { title: label }, label);
    }) : [h('span.terminal-branch', {}, live ? 'No Git branch' : timedOut ? 'Live branch unavailable' : 'Checking branch…')];
    if (!live && timedOut) badges.push(h('span.terminal-branch-note', {}, 'Live updates unavailable. Restart Agent Office after active work finishes to load branch reporting.'));
    element.replaceChildren(...badges);
  };
  // Git reads have bounded timeouts. Missing reports must not leave an endless loading label.
  const timer = setTimeout(() => { timedOut = true; render(); }, 8000);
  return {
    element,
    refresh(worker: Pick<WorkerInfo, 'branches' | 'workspace' | 'worktree'>, projectBranch?: string) {
      reported = worker.branches;
      const branch = worker.worktree?.branch ?? (projectBranch === 'HEAD' ? undefined : projectBranch);
      saved = worker.workspace
        ? worker.workspace.repositories.map(repo => ({ repository: repo.repository, branch: repo.branch }))
        : branch ? [{ branch }] : [];
      render();
    },
    dispose() { clearTimeout(timer); },
  };
}
