import type { WorkspaceRepositories, WorkspaceRequest } from '../../shared/workspaces';
import { store } from '../state';
import { h } from './dom';
import './workspaces.css';

const WT_KEY = 'agent-office.worktree';
/** A floor's last repository list opens the next dialog at once, while a fresh search runs behind it. */
const CACHE_MS = 5 * 60_000;
/** How long Hire waits for a slow search before using the floor's own repository instead. */
const WAIT_MS = 4000;
const WAITING = 'Finding repositories…';
const lastFound = new Map<string, { at: number; data: WorkspaceRepositories }>();

/** Whether the last hire asked for its own git worktree (a carried issue card dropped on a desk reuses it). */
export function worktreePref(): boolean {
  try { return localStorage.getItem(WT_KEY) === '1'; } catch { return false; }
}

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
  let search: Promise<void> | undefined;
  let shown = '';
  let fallback = false;
  let originalCount = 0;
  function render(data: WorkspaceRepositories) {
    // A refresh that found the same thing leaves the list (and an open dropdown) alone.
    const key = JSON.stringify(data);
    if (key === shown) return;
    shown = key;
    const kept = new Map([...checks].map(([p, c]) => [p, { checked: c.checked, start: starts.get(p)?.value ?? '' }]));
    originalCount = data.repositories.length;
    const repositories = data.repositories.filter(r => !options?.exclude.includes(r.path));
    list.replaceChildren();
    checks.clear(); starts.clear();
    for (const repo of repositories) {
      const box = h('input', { type: 'checkbox', value: repo.path, disabled: !!repo.error, 'aria-label': `Use ${repo.path}` }) as HTMLInputElement;
      box.checked = !repo.error && (kept.get(repo.path)?.checked ?? repositories.length === 1);
      checks.set(repo.path, box);
      const start = h('select.workspace-start', { 'aria-label': `Starting branch for ${repo.path === '.' ? repo.name : repo.path}`, disabled: !box.checked || !!repo.error },
        h('option', { value: '' }, `Current checkout (${repo.branch ?? 'detached HEAD'})`),
      ) as HTMLSelectElement;
      for (const remote of [false, true]) {
        const branches = repo.branches?.filter(b => b.remote === remote) ?? [];
        if (branches.length) start.append(h('optgroup', { label: remote ? 'Remote branches (last fetched)' : 'Local branches' }, ...branches.map(b => h('option', { value: b.ref }, b.name))));
      }
      const was = kept.get(repo.path)?.start;
      if (was && [...start.options].some(o => o.value === was)) start.value = was;
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
  }
  function load(): Promise<void> {
    if (!search) search = (async () => {
      if (!loaded) {
        list.replaceChildren(h('p', {}, 'Finding repositories in this floor…'));
        error.textContent = '';
      }
      try {
        const res = await fetch(`/api/workspace/repositories?floor=${encodeURIComponent(floor ?? '')}`);
        const data = await res.json() as WorkspaceRepositories & { error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Could not read repositories');
        lastFound.set(floor ?? '', { at: Date.now(), data });
        render(data);
      } catch (err) {
        // A failed refresh keeps the list already on screen.
        if (!loaded) {
          list.replaceChildren(h('button.btn', { type: 'button', onclick: () => void load() }, 'Retry repository search'));
          error.textContent = (err as Error).message;
        }
      } finally { search = undefined; }
    })();
    return search;
  }
  const update = () => {
    details.classList.toggle('hidden', !toggle.checked);
    shared.classList.toggle('hidden', toggle.checked);
    if (!toggle.checked || loaded) return;
    const last = lastFound.get(floor ?? '');
    if (last && Date.now() - last.at < CACHE_MS) render(last.data);
    void load();
  };
  chooseBranch.addEventListener('click', () => { toggle.checked = true; update(); });
  toggle.addEventListener('change', update);
  update();
  return {
    element,
    /**
     * Whether the choice can be sent. Waits for a search still under way (showing it on `button`); a desk
     * hire on a floor that is itself a repository waits only a few seconds, then uses that repository.
     */
    async ready(button?: HTMLButtonElement): Promise<boolean> {
      fallback = false;
      if (!toggle.checked) return true;
      if (store.floor !== floor) { error.textContent = 'The floor changed. Close this dialog and open it again.'; return false; }
      // The author's single-repository worktree needs no search: the fallback when one is slow or fails.
      const canFallBack = !options && !!store.project?.branch;
      if (!loaded) {
        if (!search && !canFallBack) void load();
        if (search) {
          const label = button?.textContent ?? '';
          if (button) { button.disabled = true; button.textContent = WAITING; }
          try { await (canFallBack ? Promise.race([search, new Promise(r => setTimeout(r, WAIT_MS))]) : search); }
          finally {
            if (button) { button.disabled = false; if (button.textContent === WAITING) button.textContent = label; }
          }
          if (!toggle.checked) return true;
          if (store.floor !== floor) { error.textContent = 'The floor changed. Close this dialog and open it again.'; return false; }
        }
        if (!loaded) {
          if (!canFallBack) return false; // load() shows what went wrong, with its Retry button
          fallback = true;
          return true;
        }
      }
      const count = [...checks.values()].filter(c => c.checked).length;
      if (!count || count + (options?.exclude.length ?? 0) > 12) { error.textContent = 'Select at least one repository (12 per worker maximum).'; return false; }
      error.textContent = '';
      return true;
    },
    value(): { worktree: boolean; workspace?: WorkspaceRequest } {
      try { if (!options) localStorage.setItem(WT_KEY, toggle.checked ? '1' : '0'); } catch { /* storage blocked */ }
      if (!toggle.checked) return { worktree: false };
      const repositories = fallback ? ['.'] : [...checks].filter(([, c]) => c.checked).map(([p]) => p);
      const startRefs = Object.fromEntries(repositories.filter(p => starts.get(p)?.value).map(p => [p, starts.get(p)!.value]));
      // Leave the author's default single-repository flow intact when no custom branch is requested.
      if (!options && (fallback || originalCount === 1) && repositories[0] === '.' && !branch.value.trim() && !Object.keys(startRefs).length) return { worktree: true };
      return { worktree: true, workspace: { repositories, branch: branch.value.trim() || undefined, startRefs: Object.keys(startRefs).length ? startRefs : undefined } };
    },
  };
}
