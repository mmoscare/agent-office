import './cleanup.css';
import { branchNeedsWorktree, cleanupLocked, cleanupLosses, defaultChoice, type CleanupChoice, type CleanupItem, type CleanupRun, type CleanupScan } from '../../shared/cleanup';
import type { GitRepoList } from '../../shared/git-board';
import { store } from '../state';
import { h, openModal, timeAgo, toast } from './dom';

// The cleanup screen: pick a floor (Back Office ones too), then one of its Git repositories, then tick
// which leftover branches and worktrees to delete. Safe leftovers start ticked; anything holding work,
// with an open PR, a live worker's, protected or pinned doesn't. A dry run lists exactly what goes
// before anything does, and every item gets its own result. The server side is server/cleanup.ts.

async function api<T>(floor: string, p: string, params: Record<string, string | undefined>, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<T> {
  const q = new URLSearchParams({ floor });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const res = await fetch(`/api/git/${p}?${q}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) } : {}),
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Group = 'safe' | 'work' | 'pinned' | 'kept';
const GROUPS: { id: Group; icon: string; title: string; hint: string }[] = [
  { id: 'safe', icon: '🧹', title: 'Safe to delete', hint: 'every commit is already in the default branch or on a remote, and nothing is uncommitted' },
  { id: 'work', icon: '✋', title: 'Holding work', hint: 'deleting one of these loses what it says, so it needs its own "delete anyway"' },
  { id: 'pinned', icon: '📌', title: 'Always kept', hint: 'pinned in this repository: every cleanup leaves them alone' },
  { id: 'kept', icon: '🔒', title: 'Kept: live workers and protected', hint: 'never deleted from here. Send a worker home from the office to clean up after it' },
];

function groupOf(it: CleanupItem): Group {
  if (cleanupLocked(it)) return 'kept';
  if (it.pinned) return 'pinned';
  return it.verdict.kind === 'work' ? 'work' : 'safe';
}

export interface CleanupOpen {
  /** Floor id; this floor when unset. */
  floor?: string;
  /** Repository path on that floor, as the Git board lists it. */
  repo?: string;
}

export function openCleanup(opts: CleanupOpen = {}) {
  let floor = opts.floor ?? store.floor ?? store.floors[0]?.id ?? '';
  let repo = opts.repo;
  let repos: GitRepoList | null = null;
  let scan: CleanupScan | null = null;
  let error: string | undefined;
  let loading = false;
  let busy: string | null = null;
  let view: 'list' | 'confirm' | 'result' = 'list';
  let run: CleanupRun | null = null;
  const choices = new Map<string, CleanupChoice>();
  let seq = 0;
  let closed = false;

  const status = h('span.board-status');
  const fetchBtn = h('button.btn', { type: 'button', title: "git fetch --prune from origin, so the branches on GitHub are current" }, '⬇️ Fetch');
  const rescan = h('button.btn', { type: 'button', title: 'Read the branches again' }, '🔄 Rescan');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const floorSel = h('select.cleanup-select', { 'aria-label': 'Floor' });
  const repoSel = h('select.cleanup-select', { 'aria-label': 'Repository' });
  const picks = h('div.cleanup-picks', {}, h('label', {}, h('span', {}, 'Floor'), floorSel), h('label', {}, h('span', {}, 'Repository'), repoSel));
  const body = h('div.body.cleanup-body');
  const footer = h('footer.cleanup-foot');
  const el = h('div.modal.board.cleanup-board', { role: 'dialog', 'aria-label': 'Clean up branches and worktrees', tabindex: -1 }, h('header', {}, h('h2', {}, '🧹 Clean up branches & worktrees'), status, fetchBtn, rescan, close), picks, body, footer);
  const modal = openModal(el, { doing: '🧹 cleaning up branches', onClose: () => (closed = true) });
  close.onclick = () => modal.close();

  // ---- Floor and repository ----

  const renderFloors = () => {
    const usable = store.floors.filter((f) => !f.cloning);
    const main = usable.filter((f) => !f.backOffice);
    const back = usable.filter((f) => f.backOffice);
    const opt = (f: (typeof usable)[number]) => h('option', { value: f.id, selected: f.id === floor }, f.name);
    floorSel.replaceChildren(...main.map(opt), ...(back.length ? [h('optgroup', { label: 'Back Office' }, ...back.map(opt))] : []));
    if (!usable.some((f) => f.id === floor) && usable[0]) floor = usable[0].id;
  };

  const renderRepos = () => {
    const list = repos?.repos ?? [];
    repoSel.replaceChildren(...list.map((r) => h('option', { value: r.path, selected: r.path === repo }, r.path === '.' ? `${r.name} (the floor itself)` : r.path)));
    repoSel.disabled = list.length < 2;
  };

  const loadRepos = async () => {
    const mine = ++seq;
    repos = null;
    scan = null;
    error = undefined;
    loading = true;
    renderRepos();
    render();
    try {
      const list = await api<GitRepoList>(floor, 'repos', {});
      if (closed || mine !== seq) return;
      repos = list;
      const ok = list.repos.filter((r) => !r.error);
      if (!ok.some((r) => r.path === repo)) repo = ok[0]?.path;
      renderRepos();
      if (!repo) {
        loading = false;
        error = list.repos.length ? `No repository on this floor could be read: ${list.repos[0].error}` : 'No Git repositories on this floor.';
        render();
        return;
      }
      await loadScan();
    } catch (err) {
      if (closed || mine !== seq) return;
      loading = false;
      error = `Couldn't list the repositories: ${(err as Error).message}`;
      render();
    }
  };

  const loadScan = async (fresh = false) => {
    if (!repo) return;
    const mine = ++seq;
    loading = true;
    error = undefined;
    view = 'list';
    render();
    try {
      const s = await api<CleanupScan>(floor, 'cleanup', { repo, fresh: fresh ? '1' : undefined });
      if (closed || mine !== seq) return;
      scan = s;
      choices.clear();
      for (const it of s.items) choices.set(it.id, defaultChoice(it, s.prs));
    } catch (err) {
      if (closed || mine !== seq) return;
      scan = null;
      error = (err as Error).message;
    }
    loading = false;
    render();
  };

  floorSel.onchange = () => {
    floor = floorSel.value;
    repo = undefined;
    void loadRepos();
  };
  repoSel.onchange = () => {
    repo = repoSel.value;
    void loadScan();
  };
  rescan.onclick = () => void loadScan(true);
  fetchBtn.onclick = async () => {
    if (!repo || busy) return;
    busy = 'Fetching from origin…';
    render();
    try {
      await api(floor, 'fetch', { repo }, 'POST');
    } catch (err) {
      toast(`Couldn't fetch from origin: ${(err as Error).message}`, 'warn');
    }
    busy = null;
    await loadScan(true);
  };

  // ---- The list ----

  const choice = (it: CleanupItem) => choices.get(it.id) ?? defaultChoice(it, scan?.prs ?? 'ok');
  const selected = () => [...choices.values()].filter((c) => c.worktree || c.branch || c.remote);

  /** Ticks one part, keeping git's rule that a checked-out branch goes with its worktree; a changed tick asks for "delete anyway" again. */
  const tick = (it: CleanupItem, part: 'worktree' | 'branch' | 'remote', on: boolean) => {
    const c = { ...choice(it), [part]: on, force: false };
    if (branchNeedsWorktree(it)) {
      if (part === 'branch' && on) c.worktree = true;
      if (part === 'worktree' && !on) c.branch = false;
    }
    choices.set(it.id, c);
    render();
  };

  const pin = async (it: CleanupItem) => {
    if (!scan || !repo) return;
    const on = !it.pinned;
    try {
      await api(floor, 'cleanup/pin', { repo }, 'POST', { id: it.id, pinned: on });
      it.pinned = on;
      choices.set(it.id, defaultChoice(it, scan.prs));
      toast(on ? `📌 ${it.branch ?? it.id} stays at every cleanup` : `📌 ${it.branch ?? it.id} unpinned`);
    } catch (err) {
      toast(`Couldn't pin it: ${(err as Error).message}`, 'warn');
    }
    render();
  };

  const box = (it: CleanupItem, part: 'worktree' | 'branch' | 'remote', shown: boolean, label: string, why?: string) => {
    if (!shown) return h('td.cleanup-tick', {}, h('span.muted', { title: `No ${label}` }, '—'));
    const locked = cleanupLocked(it) || it.pinned || (part === 'remote' && !it.remoteDeletable);
    const input = h('input', { type: 'checkbox', 'aria-label': `Delete ${label} of ${it.branch ?? it.id}`, disabled: locked });
    input.checked = !!choice(it)[part];
    input.onchange = () => tick(it, part, input.checked);
    return h('td.cleanup-tick', { title: locked ? why ?? it.verdict.text : `Delete ${label}` }, input);
  };

  const where = (it: CleanupItem) => (it.local && it.remote ? 'local + origin' : it.local ? 'local only' : it.remote ? 'origin only' : '—');

  const tags = (it: CleanupItem) => {
    const wt = it.worktree;
    if (!wt) return null;
    const bits = [
      wt.stray ? h('span.cleanup-tag.warn', { title: 'git no longer lists this folder as a worktree: a removal that failed partway' }, 'half-deleted') : null,
      !wt.exists ? h('span.cleanup-tag', { title: 'git still lists it; its folder is gone' }, 'folder gone') : null,
      wt.external ? h('span.cleanup-tag', { title: 'Registered outside .agent-office/worktrees' }, 'outside the office') : null,
      wt.detached ? h('span.cleanup-tag', {}, 'detached') : null,
      wt.desk ? h('span.cleanup-tag', { title: `A desk working across ${wt.desk.repositories.join(', ')}` }, `desk ${wt.desk.name}${wt.desk.repositories.length > 1 ? ` · ${wt.desk.repositories.length} repos` : ''}`) : null,
    ];
    return h('div.cleanup-path', { title: wt.path }, `📁 ${wt.path}`, ...bits);
  };

  const row = (it: CleanupItem) => {
    const c = choice(it);
    const lost = cleanupLosses(it, c);
    const force = h('input', { type: 'checkbox' });
    force.checked = !!c.force;
    force.onchange = () => {
      choices.set(it.id, { ...choice(it), force: force.checked });
      render();
    };
    const pr = it.pr
      ? h('a.cleanup-pr', { href: it.pr.url, target: '_blank', rel: 'noopener', class: it.pr.state.toLowerCase() }, `#${it.pr.number} ${it.pr.state.toLowerCase()}`)
      : h('span.muted', { title: scan?.prs === 'unknown' ? "GitHub couldn't be asked" : 'No pull request' }, scan?.prs === 'unknown' ? '?' : '—');
    return h(
      'tr',
      { class: [lost.length && !c.force ? 'holds' : '', c.worktree || c.branch || c.remote ? 'on' : ''].filter(Boolean).join(' ') },
      box(it, 'worktree', !!it.worktree, 'the worktree folder'),
      box(it, 'branch', it.local, 'the local branch'),
      box(it, 'remote', it.remote, "origin's copy", it.remoteWhy),
      h('td.cleanup-name', {}, h('div.cleanup-branch', { title: it.branch ?? it.id }, it.branch ? `🌿 ${it.branch}` : '📁 no branch'), tags(it)),
      h('td', {}, where(it)),
      h('td', {}, pr),
      h('td.cleanup-date', { title: it.date ?? '' }, it.date ? timeAgo(it.date) : '—'),
      h(
        'td.cleanup-verdict',
        {},
        h('span.cleanup-chip', { class: it.verdict.kind }, it.verdict.text),
        lost.length ? h('label.cleanup-force', {}, force, h('span', {}, h('b', {}, 'Delete anyway, losing: '), lost.join('; '))) : null,
      ),
      h('td.cleanup-pin', {}, cleanupLocked(it) ? null : h('button.btn.cleanup-pinbtn', { type: 'button', 'aria-pressed': String(it.pinned), title: it.pinned ? 'Unpin: let cleanups offer it again' : 'Always keep it: every cleanup leaves it alone', onclick: () => void pin(it) }, '📌')),
    );
  };

  const table = (items: CleanupItem[]) =>
    h(
      'table.cleanup-table',
      {},
      h('thead', {}, h('tr', {}, h('th', { title: 'Delete the worktree folder' }, '📁 Folder'), h('th', { title: 'Delete the local branch' }, '🌿 Local'), h('th', { title: "Delete origin's copy on GitHub (only once its PR is merged or closed)" }, '☁️ Origin'), h('th', {}, 'Branch or worktree'), h('th', {}, 'Where'), h('th', {}, 'PR'), h('th', {}, 'Last commit'), h('th', {}, 'What deleting it loses'), h('th', { title: 'Always keep' }, 'Keep'))),
      h('tbody', {}, ...items.map(row)),
    );

  const renderList = () => {
    if (loading || !scan) {
      body.replaceChildren(error ? h('div.board-error', {}, error) : h('div.changes-empty', {}, h('div.spinner'), h('p', {}, 'Reading every branch and worktree…'), h('p.note', {}, 'A repository with many of them takes a little while.')));
      footer.replaceChildren();
      return;
    }
    const s = scan;
    const notes = [
      s.prs === 'unknown' ? h('p.cleanup-note.warn', {}, `❔ GitHub couldn't be asked about pull requests (${s.prError ?? 'unknown error'}), so nothing starts ticked and origin's copies aren't offered. Rescan to try again.`) : null,
      s.prs === 'none' ? h('p.cleanup-note', {}, "origin isn't on GitHub, so there are no pull requests to check.") : null,
      h('p.cleanup-note', {}, `${s.name}: checked out on ${s.current ?? 'a detached HEAD'}${s.defaultBranch ? `, default branch ${s.defaultBranch}` : ''}. Branches on origin are as of the last fetch${s.fetchedAt ? ` (${timeAgo(s.fetchedAt)})` : ''}; ⬇️ Fetch brings them up to date.`),
    ];
    const sections = GROUPS.map((g) => {
      const items = s.items.filter((it) => groupOf(it) === g.id).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      if (!items.length) return null;
      const head = h('summary', {}, h('span.cleanup-sec-title', {}, `${g.icon} ${g.title}`), h('span.cleanup-count', {}, String(items.length)), h('span.cleanup-hint', {}, g.hint));
      return h('details.cleanup-sec', { class: g.id, open: g.id !== 'kept' }, head, table(items));
    });
    body.replaceChildren(h('div.cleanup-list', {}, ...notes, ...(s.items.length ? sections : [h('div.changes-empty', {}, h('div.big', {}, '🎉'), h('p', {}, 'No branches or worktrees to show.'))])));

    const sel = selected();
    const count = (part: 'worktree' | 'branch' | 'remote') => sel.filter((c) => c[part]).length;
    const blocked = sel.filter((c) => {
      const it = s.items.find((i) => i.id === c.id);
      return it && cleanupLosses(it, c).length && !c.force;
    }).length;
    const review = h('button.btn.primary', { type: 'button', disabled: !sel.length || !!busy }, '🔍 Review what gets deleted…');
    review.onclick = () => void preview();
    footer.replaceChildren(
      h('span.grow', {}, sel.length ? `Deleting ${plural(count('worktree'), 'worktree folder')}, ${plural(count('branch'), 'local branch', 'local branches')} and ${count('remote')} on origin. Everything unticked is kept.${blocked ? ` ${plural(blocked, 'ticked item holds', 'ticked items hold')} work: tick "delete anyway" or it's skipped.` : ''}` : 'Nothing ticked: everything is kept.'),
      h('button.btn', { type: 'button', onclick: () => { for (const it of s.items) choices.set(it.id, defaultChoice(it, s.prs)); render(); } }, 'Tick the safe ones'),
      h('button.btn', { type: 'button', onclick: () => { for (const it of s.items) choices.set(it.id, { ...choice(it), worktree: false, branch: false, remote: false, force: false }); render(); } }, 'Untick all'),
      review,
    );
  };

  // ---- Confirm, then delete ----

  const send = (dryRun: boolean) => api<CleanupRun>(floor, 'cleanup/run', { repo }, 'POST', { dryRun, choices: selected() });

  const preview = async () => {
    busy = 'Checking again…';
    render();
    try {
      run = await send(true);
      view = 'confirm';
    } catch (err) {
      toast(`Couldn't check them: ${(err as Error).message}`, 'warn');
    }
    busy = null;
    render();
  };

  const execute = async () => {
    busy = 'Deleting…';
    render();
    try {
      run = await send(false);
      view = 'result';
      const failed = run.steps.filter((s) => !s.ok).length;
      toast(failed ? `🧹 Done, but ${plural(failed, 'step')} failed: see the list` : `🧹 Deleted ${plural(run.steps.length, 'thing')}`, failed ? 'warn' : 'info');
    } catch (err) {
      toast(`The cleanup didn't run: ${(err as Error).message}`, 'warn');
    }
    busy = null;
    render();
  };

  const nameOf = (id: string) => scan?.items.find((i) => i.id === id)?.branch ?? id;

  const renderRun = () => {
    const r = run!;
    const floorName = store.floors.find((f) => f.id === floor)?.name ?? floor;
    const steps = r.steps.map((s) =>
      h('li', { class: r.dryRun ? '' : s.ok ? 'ok' : 'bad' }, h('span.cleanup-mark', {}, r.dryRun ? '🗑' : s.ok ? '✅' : '❌'), h('span', {}, s.label, !r.dryRun && !s.ok ? h('b.cleanup-why', {}, ` — failed: ${s.error ?? 'unknown error'}`) : null)),
    );
    const refused = r.refused.map((x) => h('li', {}, h('span.cleanup-mark', {}, '✋'), h('span', {}, h('b', {}, nameOf(x.id)), `: ${x.why}`)));
    const title = r.dryRun
      ? r.steps.length ? `This deletes exactly these ${plural(r.steps.length, 'thing')} from ${scan?.name ?? repo} on ${floorName}:` : 'Nothing would be deleted.'
      : `Results on ${scan?.name ?? repo}, ${floorName}:`;
    body.replaceChildren(
      h(
        'div.cleanup-run',
        {},
        h('h3', {}, title),
        r.steps.length ? h('ul.cleanup-steps', {}, ...steps) : null,
        refused.length ? h('h3', {}, r.dryRun ? 'Not deleted (kept):' : 'Skipped:') : null,
        refused.length ? h('ul.cleanup-steps.refused', {}, ...refused) : null,
        r.dryRun ? h('p.cleanup-note', {}, "Checked again just now. Each one is looked at once more right before it's deleted, and anything that changed since is skipped. The upstream remote is never touched.") : null,
      ),
    );
    if (r.dryRun) {
      const go = h('button.btn.danger', { type: 'button', disabled: !r.steps.length || !!busy }, busy ?? `🗑 Delete ${plural(r.steps.length, 'thing')}`);
      go.onclick = () => void execute();
      footer.replaceChildren(h('span.grow', {}, 'Worktree folders and branches deleted here are gone; origin copies can be restored from their PR on GitHub.'), h('button.btn', { type: 'button', onclick: () => { view = 'list'; render(); } }, '← Back'), go);
    } else {
      footer.replaceChildren(h('span.grow', {}, `${r.steps.filter((s) => s.ok).length} of ${plural(r.steps.length, 'step')} done.`), h('button.btn.primary', { type: 'button', onclick: () => void loadScan(true) }, '🔄 Back to the list'));
    }
  };

  const render = () => {
    if (closed) return;
    status.textContent = busy ?? (loading ? 'Reading…' : scan ? plural(scan.items.length, 'branch or worktree', 'branches and worktrees') : '');
    fetchBtn.disabled = rescan.disabled = floorSel.disabled = !!busy || loading || view !== 'list';
    repoSel.disabled = floorSel.disabled || (repos?.repos.length ?? 0) < 2;
    if (view === 'list' || !run) renderList();
    else renderRun();
  };

  renderFloors();
  void loadRepos();
}
