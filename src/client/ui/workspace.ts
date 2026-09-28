import type { Net } from '../net';
import { store } from '../state';
import { isBusy } from '../../shared/status';
import { h, openModal, toast } from './dom';
import { openChanges } from './changes';
import { workspacePicker } from './workspace-picker';
import { testChangesButton } from './test-changes';

/** A desk's repositories stay together, while their changes and pull requests stay separate. */
export function openWorkspace(net: Net, workerId: string, onTerminal: () => void) {
  const info = store.workers.get(workerId);
  if (!info?.workspace) return;
  const cards = h('div');
  const add = h('button.btn', { type: 'button' }, 'Add repositories');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close workspace' }, '✕');
  const terminal = h('button.btn', { type: 'button' }, 'Terminal');
  const test = testChangesButton(net, workerId, () => { modal.close(); onTerminal(); });
  const el = h('div.modal.worker-workspace', { role: 'dialog', 'aria-label': `${info.name} workspace` },
    h('header', {}, h('h2', {}, `${info.name} · workspace`), close),
    h('div.body', {},
      h('p', {}, 'One worker, separate worktrees for each repository. Review and merge each PR on GitHub when you are ready.'),
      h('p.workspace-path', {}, info.workspace.path), cards,
      h('p.note', {}, 'Merging a PR does not update your original local folders. Pull the merged changes there when it is safe to update them.'),
    ),
    h('footer', {}, test.element, add, terminal),
  );
  const render = () => {
    const w = store.workers.get(workerId);
    if (!w?.workspace) return;
    test.refresh();
    const busy = isBusy(w.status) || !!w.prOpening;
    add.disabled = busy;
    add.title = busy ? 'Wait until the worker finishes its current task' : 'Give this worker another repository worktree';
    cards.replaceChildren(...w.workspace.repositories.map(r => {
      const changes = h('button.btn', { type: 'button', onclick: () => openChanges(net, workerId, onTerminal, r.repository) }, 'Changes & commits');
      const pr = h('button.btn', { type: 'button', disabled: busy, onclick: () => {
        toast(`Pushing ${r.name} / ${r.branch} and opening its PR…`);
        net.send({ t: 'worker.pr', workerId, repository: r.repository });
      } }, r.pr ? 'Push latest commits' : 'Push & open PR');
      return h('section.workspace-card', { 'data-repository': r.repository },
        h('h3', {}, r.repository === '.' ? r.name : r.repository),
        h('p', {}, `${r.branch} → ${r.from ?? 'repository default branch'}`),
        h('p.workspace-path', {}, r.path),
        h('div.workspace-actions', {}, changes, pr, r.pr ? h('a.btn.primary', { href: r.pr.url, target: '_blank', rel: 'noopener' }, `Review PR #${r.pr.number} ↗`) : null),
      );
    }));
  };
  const unsub = store.on('workers', () => { if (!store.workers.has(workerId)) modal.close(); else render(); });
  const modal = openModal(el, { onClose: () => unsub() });
  close.addEventListener('click', () => modal.close());
  terminal.addEventListener('click', () => { modal.close(); onTerminal(); });
  add.addEventListener('click', () => {
    const workspace = store.workers.get(workerId)?.workspace;
    if (!workspace) return;
    const picker = workspacePicker('add-workspace-repositories', { exclude: workspace.repositories.map(r => r.repository), branch: workspace.repositories[0]?.branch ?? '' });
    const submit = h('button.btn.primary', { type: 'submit' }, 'Add worktrees');
    const cancel = h('button.btn', { type: 'button' }, 'Cancel');
    const form = h('form.modal', { role: 'dialog', 'aria-label': 'Add repositories' }, h('header', {}, h('h2', {}, 'Add repositories')), h('div.body', {}, picker.element), h('footer', {}, cancel, submit));
    const dialog = openModal(form);
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!picker.valid()) return;
      const request = picker.value().workspace;
      if (request) net.send({ t: 'worker.workspace.add', workerId, workspace: request });
      dialog.close();
    });
  });
  render();
}
