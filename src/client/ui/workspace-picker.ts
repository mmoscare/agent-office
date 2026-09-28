import type { WorkspaceRepositories, WorkspaceRequest } from '../../shared/workspaces';
import { store } from '../state';
import { h } from './dom';
import './workspaces.css';

const WT_KEY = 'agent-office.worktree';

/** Shared by both hire dialogs and the existing workspace's Add repositories action. */
export function workspacePicker(id: string, options?: { exclude: string[]; branch: string }) {
  const floor = store.floor;
  const toggle = h('input', { type: 'checkbox', id }) as HTMLInputElement;
  try { toggle.checked = !!options || localStorage.getItem(WT_KEY) === '1'; } catch { toggle.checked = !!options; }
  const label = h('label.workspace-toggle', { for: id }, toggle, 'Work in separate git worktrees & branches');
  if (options) label.classList.add('hidden');
  const chooseBranch = h('button.btn', { type: 'button', title: 'Choose a starting branch in separate worktrees' }, 'Choose starting branch…');
  const shared = h('div.workspace-shared', {}, h('small', {}, 'Works in the original folders on their current branches.'), chooseBranch);
  const list = h('div.workspace-repos');
  const error = h('p.workspace-error', { role: 'status' });
  const branch = h('input', { type: 'text', id: `${id}-branch`, placeholder: 'Leave blank for a fresh branch', maxlength: 200, autocomplete: 'off' }) as HTMLInputElement;
  branch.value = options?.branch ?? '';
  const details = h('div.workspace-options', {},
    h('p', {}, 'Choose the repositories this worker may change. Each gets its own worktree; one worker can work across all of them.'),
    list,
    h('label', { for: branch.id }, 'New branch name (optional)'), branch,
    h('p.note', {}, 'Starts from the selected branch’s committed code in a new worktree. Remote branches use the last fetched version. Uncommitted edits, dependencies and ignored files stay in the original folders.'),
    error,
  );
  const element = h('div.workspace-picker', {}, label, shared, details);
  const checks = new Map<string, HTMLInputElement>();
  const starts = new Map<string, HTMLSelectElement>();
  let loaded = false;
  let loading = false;
  let originalCount = 0;
  async function load() {
    if (loading || loaded) return;
    loading = true;
    list.replaceChildren(h('p', {}, 'Finding repositories in this floor…'));
    error.textContent = '';
    try {
      const res = await fetch(`/api/workspace/repositories?floor=${encodeURIComponent(floor ?? '')}`);
      const data = await res.json() as WorkspaceRepositories & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not read repositories');
      originalCount = data.repositories.length;
      const repositories = data.repositories.filter(r => !options?.exclude.includes(r.path));
      list.replaceChildren();
      checks.clear(); starts.clear();
      for (const repo of repositories) {
        const box = h('input', { type: 'checkbox', value: repo.path, disabled: !!repo.error, 'aria-label': `Use ${repo.path}` }) as HTMLInputElement;
        box.checked = repositories.length === 1 && !repo.error;
        checks.set(repo.path, box);
        const start = h('select.workspace-start', { 'aria-label': `Starting branch for ${repo.path === '.' ? repo.name : repo.path}`, disabled: !box.checked || !!repo.error },
          h('option', { value: '' }, `Current checkout (${repo.branch ?? 'detached HEAD'})`),
        );
        for (const remote of [false, true]) {
          const branches = repo.branches?.filter(b => b.remote === remote) ?? [];
          if (branches.length) start.append(h('optgroup', { label: remote ? 'Remote branches (last fetched)' : 'Local branches' }, ...branches.map(b => h('option', { value: b.ref }, b.name))));
        }
        starts.set(repo.path, start);
        box.addEventListener('change', () => { start.disabled = !box.checked || !!repo.error; });
        list.append(h('div.workspace-repo', {},
          h('label.workspace-repo-choice', {}, box, h('span', {}, h('strong', {}, repo.path === '.' ? repo.name : repo.path), h('small', {}, repo.error ?? `${repo.branch ?? 'detached HEAD'}${repo.dirty ? ' · has uncommitted edits (left in original)' : ''}`))),
          h('label.workspace-start-label', {}, 'Start from', start),
        ));
      }
      if (!repositories.length) list.append(h('p', {}, options ? 'All discovered repositories are already in this workspace.' : 'No Git repositories found. You can leave this unchecked to work in the shared folder.'));
      if (data.truncated) list.append(h('p.note', {}, 'The folder search reached its limit. Open a more specific parent folder as the floor if a repo is missing.'));
      loaded = true;
    } catch (err) {
      list.replaceChildren(h('button.btn', { type: 'button', onclick: () => void load() }, 'Retry repository search'));
      error.textContent = (err as Error).message;
    } finally { loading = false; }
  }
  const update = () => {
    details.classList.toggle('hidden', !toggle.checked);
    shared.classList.toggle('hidden', toggle.checked);
    if (toggle.checked) void load();
  };
  chooseBranch.addEventListener('click', () => { toggle.checked = true; update(); });
  toggle.addEventListener('change', update);
  update();
  return {
    element,
    valid(): boolean {
      if (!toggle.checked) return true;
      if (store.floor !== floor) { error.textContent = 'The floor changed. Close this dialog and open it again.'; return false; }
      if (!loaded) { error.textContent = 'Wait for the repository list, or retry the search.'; return false; }
      const count = [...checks.values()].filter(c => c.checked).length;
      if (!count || count + (options?.exclude.length ?? 0) > 12) { error.textContent = 'Select at least one repository (12 per worker maximum).'; return false; }
      error.textContent = '';
      return true;
    },
    value(): { worktree: boolean; workspace?: WorkspaceRequest } {
      try { if (!options) localStorage.setItem(WT_KEY, toggle.checked ? '1' : '0'); } catch { /* storage blocked */ }
      if (!toggle.checked) return { worktree: false };
      const repositories = [...checks].filter(([, c]) => c.checked).map(([p]) => p);
      const startRefs = Object.fromEntries(repositories.filter(p => starts.get(p)?.value).map(p => [p, starts.get(p)!.value]));
      // Leave the author's default single-repository flow intact when no custom branch is requested.
      if (!options && originalCount === 1 && repositories[0] === '.' && !branch.value.trim() && !Object.keys(startRefs).length) return { worktree: true };
      return { worktree: true, workspace: { repositories, branch: branch.value.trim() || undefined, startRefs: Object.keys(startRefs).length ? startRefs : undefined } };
    },
  };
}
