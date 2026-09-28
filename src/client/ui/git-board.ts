import type { GitBranchInfo, GitCommitLine, GitDiff, GitDiffMode, GitFileChange, GitRepoDetail, GitRepoList, GitRepoSummary, OfficeStatus } from '../../shared/git-board';
import type { PullRequestRef } from '../../shared/protocol';
import { pullRequestLabel } from '../../shared/pulls';
import { store } from '../state';
import { renderDiff } from './changes';
import { h, openModal, timeAgo, toast } from './dom';
import { confirmDialog, openPrompt } from './prompt';
import { renderOfficeStatus } from './office-status';

// The Git board: the PR board's other side. A button over the PR board on the wall (or in its
// window) flips it. Its front lists every Git repository on the floor; open one for its branches and,
// VS Code source-control style, what's uncommitted and what differs from the branch's copy on GitHub,
// file by file with diffs. Everything is read from the server's checkouts (server/git-board.ts).

// ---- Which side of the PR board faces the room -------------------------------------------------

export type PullsWallMode = 'pulls' | 'git';
const MODE_KEY = 'agent-office.pullsWall';
let mode: PullsWallMode = (() => {
  try {
    return localStorage.getItem(MODE_KEY) === 'git' ? 'git' : 'pulls';
  } catch {
    return 'pulls';
  }
})();
const modeListeners = new Set<(m: PullsWallMode) => void>();

export function pullsWallMode(): PullsWallMode {
  return mode;
}

export function setPullsWallMode(m: PullsWallMode) {
  if (m === mode) return;
  mode = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // Private windows: it just isn't remembered.
  }
  modeListeners.forEach((fn) => fn(m));
  if (m === 'git') void loadGitRepos();
}

export function onPullsWallMode(fn: (m: PullsWallMode) => void): () => void {
  modeListeners.add(fn);
  return () => modeListeners.delete(fn);
}

// ---- The repositories, for the wall and the window --------------------------------------------

export interface GitReposState {
  list: GitRepoList | null;
  loading: boolean;
  error?: string;
  at?: number;
}

export const gitRepos: GitReposState = { list: null, loading: false };
const repoListeners = new Set<() => void>();

export function onGitRepos(fn: () => void): () => void {
  repoListeners.add(fn);
  return () => repoListeners.delete(fn);
}

async function api<T>(path: string, params: Record<string, string | undefined>, method: 'GET' | 'POST' = 'GET', input?: unknown): Promise<T> {
  const q = new URLSearchParams({ floor: store.floor ?? '' });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const res = await fetch(`/api/git/${path}?${q}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) } : {}),
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

let loadingFloor: string | null = null;
export async function loadGitRepos(): Promise<void> {
  if (gitRepos.loading && loadingFloor === store.floor) return;
  const floor = (loadingFloor = store.floor);
  gitRepos.loading = true;
  repoListeners.forEach((fn) => fn());
  try {
    const list = await api<GitRepoList>('repos', {});
    if (floor !== store.floor) return;
    gitRepos.list = list;
    gitRepos.error = undefined;
    gitRepos.at = Date.now();
  } catch (err) {
    if (floor !== store.floor) return;
    gitRepos.error = (err as Error).message;
  } finally {
    if (floor === store.floor) {
      gitRepos.loading = false;
      repoListeners.forEach((fn) => fn());
    }
  }
}

// The wall keeps itself current while it shows the Git side.
setInterval(() => {
  if (mode === 'git' && document.visibilityState === 'visible') void loadGitRepos();
}, 30_000);
store.on('floor', () => {
  gitRepos.list = null;
  gitRepos.error = undefined;
  gitRepos.loading = false;
  repoListeners.forEach((fn) => fn());
  if (mode === 'git') void loadGitRepos();
});
if (mode === 'git') queueMicrotask(() => void loadGitRepos());

// ---- The window ---------------------------------------------------------------------------------

const STATUS_WORD: Record<GitFileChange['status'], string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', T: 'type changed', '?': 'untracked' };
/** Fetch again on opening a repository when the last fetch is older than this. */
const STALE_FETCH_MS = 5 * 60_000;
const POLL_MS = 4000;

function plusMinus(a: number, d: number, binary = false): HTMLElement {
  if (binary) return h('span.pm', {}, h('span.bin', {}, 'binary'));
  return h('span.pm', {}, h('span.add', {}, `+${a}`), ' ', h('span.del', {}, `−${d}`));
}

function pathLabel(p: string): HTMLElement {
  const i = p.lastIndexOf('/');
  return h('span.path', { title: p }, i >= 0 ? h('span.dir', {}, p.slice(0, i + 1)) : null, p.slice(i + 1));
}

function statusChip(s: GitFileChange['status']): HTMLElement {
  const letter = s === '?' ? 'U' : s;
  return h('span.st', { class: s === '?' ? 'A' : s, title: STATUS_WORD[s] }, letter);
}

/** ↑2 ↓1 against GitHub, or a word when that doesn't apply. */
function syncChips(r: { upstream?: string; ahead: number; behind: number; gone?: boolean }): HTMLElement {
  if (r.gone) return h('span.git-sync.warn', { title: `${r.upstream} was deleted from GitHub` }, 'gone from GitHub');
  if (!r.upstream) return h('span.git-sync.muted', { title: 'No branch on GitHub to compare with' }, 'not on GitHub');
  if (!r.ahead && !r.behind) return h('span.git-sync.ok', { title: `Same commits as ${r.upstream}` }, '✓ in sync');
  return h(
    'span.git-sync',
    { title: `${r.ahead} commit${r.ahead === 1 ? '' : 's'} not on GitHub, ${r.behind} on GitHub not here (as of the last fetch)` },
    r.ahead ? h('span.up', {}, `↑${r.ahead}`) : null,
    r.behind ? h('span.down', {}, `↓${r.behind}`) : null,
  );
}

export interface GitBoardActions {
  /** Flip back to the pull requests. */
  pulls(): void;
}

export function openGitBoard(actions: GitBoardActions, startRepo?: string) {
  const status = h('span.board-status');
  const pullsBtn = h('button.btn', { type: 'button', title: 'Turn the board back to pull requests' }, '🔀 Pull requests');
  const refresh = h('button.btn', { type: 'button', title: 'Read the repositories again' }, '🔄 Refresh');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const title = h('h2', {}, '🌿 Git');
  const body = h('div.body.git-body');
  const footer = h('footer.git-actions', { hidden: true });
  const officeBar = h('div.git-office-bar', { hidden: true });
  const el = h('div.modal.board.git-board', { role: 'dialog', 'aria-label': 'Git board', tabindex: -1 }, h('header', {}, title, status, pullsBtn, refresh, close), officeBar, body, footer);

  // The office's own code: is what's running the latest? (ui/office-status.ts)
  let office: OfficeStatus | null = null;
  /** Whether its steps are showing. Closed until asked for, or until you pull the office's own repository. */
  let officeOpen = false;
  officeBar.addEventListener('toggle', (e) => {
    if ((e.target as HTMLElement).tagName === 'DETAILS') officeOpen = (e.target as HTMLDetailsElement).open;
  }, true);
  const loadOffice = async () => {
    try {
      office = (await api<{ office: OfficeStatus | null }>('office', {})).office;
    } catch {
      office = null;
    }
    if (!closed) renderOfficeStatus(officeBar, office, officeOpen);
  };

  /** The repository open, or null on the list of them. */
  let repo: string | null = null;
  let branch: string | undefined;
  let detail: GitRepoDetail | null = null;
  let detailKey = '';
  let selected: { mode: GitDiffMode; path: string } | null = null;
  let fetching = false;
  /** A stage / commit / push… on its way, said for the footer. */
  let acting: string | null = null;
  /** The checked-out branch's pull request, as last asked of GitHub (undefined: not asked yet). */
  let pr: { branch?: string; pr?: PullRequestRef } | undefined;
  let closed = false;
  let seq = 0;

  // ---- The list of repositories ----

  const renderRepos = () => {
    if (repo !== null) return;
    title.textContent = '🌿 Git repositories';
    status.textContent = gitRepos.loading ? 'Reading…' : gitRepos.at ? `Updated ${timeAgo(gitRepos.at)}` : '';
    const list = gitRepos.list;
    if (!list) {
      body.replaceChildren(gitRepos.error ? h('div.board-error', {}, `Couldn't list the repositories: ${gitRepos.error}`) : h('div.changes-empty', {}, h('div.spinner')));
      return;
    }
    if (!list.repos.length) {
      body.replaceChildren(h('div.board-error', {}, 'No Git repositories on this floor.', h('br'), h('small', {}, 'The floor folder isn’t a Git repository and none were found inside it.')));
      return;
    }
    const grid = h('ul.git-repos');
    list.repos.forEach((r, i) => grid.append(repoCard(r, i)));
    const note = list.floorIsRepo ? h('p.git-note', {}, 'This whole floor is one Git repository.') : h('p.git-note', {}, `${list.repos.length} Git repositor${list.repos.length === 1 ? 'y' : 'ies'} on this floor${list.truncated ? ' (the search stopped early; some may be missing)' : ''}. Click one for its branches and changes.`);
    body.replaceChildren(h('div.git-front', {}, note, grid));
  };

  const repoCard = (r: GitRepoSummary, i: number) => {
    const open = () => openRepo(r.path);
    return h(
      'li.card.git-repo',
      { style: `--tilt:${['-0.8deg', '0.6deg', '-0.3deg', '1deg', '0deg'][i % 5]};--pin:${['#ef476f', '#118ab2', '#06d6a0', '#ffd166'][i % 4]}`, tabindex: 0, role: 'button', onclick: open, onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && open()) as EventListener },
      h('div.num', {}, r.path === '.' ? '📁 the floor itself' : r.path === r.name ? '📁 Git repository' : `📁 ${r.path}`),
      h('div.ttl', {}, r.name),
      r.error
        ? h('div.meta', {}, h('span', { style: 'color:#c3423f' }, `⚠️ ${r.error}`))
        : h(
            'div.meta',
            {},
            h('span.git-branch', { title: 'Checked-out branch' }, `🌿 ${r.branch ?? 'detached HEAD'}`),
            syncChips(r),
            r.dirty ? h('span.git-dirty', { title: 'Files with uncommitted changes' }, `✏️ ${r.dirty} uncommitted`) : h('span', {}, 'clean'),
            r.github ? h('span', { title: 'On GitHub' }, `🐙 ${r.github}`) : null,
          ),
    );
  };

  // ---- One repository ----

  const branchesList = h('ul.git-branch-list', { 'aria-label': 'Branches' });
  const branchesPane = h('aside.git-branches', {}, h('button.btn.git-back', { type: 'button', onclick: () => showRepos() }, '← All repositories'), h('h4', {}, 'Branches'), branchesList);
  const filesHead = h('div.git-files-head');
  const lists = h('div.git-lists');
  const filesPane = h('aside.changes-files.git-files', {}, filesHead, lists);
  const diffHead = h('div.dh');
  const diffBody = h('div.diff-scroll');
  const diffPane = h('section.changes-diff', {}, diffHead, diffBody);
  const detailView = h('div.git-detail', {}, branchesPane, filesPane, diffPane);

  const openRepo = (path: string, keepBranch?: string) => {
    repo = path;
    branch = keepBranch;
    detail = null;
    detailKey = '';
    selected = null;
    title.textContent = `🌿 ${gitRepos.list?.repos.find((r) => r.path === path)?.name ?? path}`;
    body.replaceChildren(detailView);
    branchesList.replaceChildren();
    lists.replaceChildren();
    filesHead.replaceChildren();
    diffHead.replaceChildren();
    diffBody.replaceChildren(h('div.changes-empty', {}, h('div.spinner')));
    pr = undefined;
    void loadPr();
    void loadDetail().then(() => {
      if (detail && !detail.error && (!detail.fetchedAt || Date.now() - detail.fetchedAt > STALE_FETCH_MS)) void fetchNow(true);
    });
  };

  const showRepos = () => {
    repo = null;
    pr = undefined;
    footer.hidden = true;
    detail = null;
    selected = null;
    renderRepos();
    void loadGitRepos();
  };

  const loadDetail = async () => {
    if (repo === null) return;
    const mine = ++seq;
    const r = repo;
    try {
      const d = await api<GitRepoDetail>('repo', { repo: r, branch });
      if (closed || mine !== seq || repo !== r) return;
      const key = JSON.stringify({ ...d, fetchedAt: 0 });
      const changed = key !== detailKey;
      detailKey = key;
      detail = d;
      renderDetail(changed);
    } catch (err) {
      if (closed || mine !== seq || repo !== r) return;
      detail = null;
      diffBody.replaceChildren(h('div.changes-empty', {}, h('div.big', {}, '🚧'), h('p', {}, (err as Error).message)));
    }
  };

  const fetchNow = async (auto = false) => {
    if (repo === null || fetching) return;
    fetching = true;
    renderFilesHead();
    const r = repo;
    try {
      await api<{ ok?: boolean }>('fetch', { repo: r }, 'POST');
    } catch (err) {
      if (!auto) toast(`Couldn't fetch from GitHub: ${(err as Error).message}`, 'warn');
      else status.textContent = `Couldn't fetch: ${(err as Error).message}`;
    } finally {
      fetching = false;
      if (!closed && repo === r) await loadDetail();
      renderFilesHead();
      void loadOffice();
    }
  };

  const pickBranch = (name: string) => {
    if (!detail || name === detail.branch) return;
    branch = name === detail.current ? undefined : name;
    selected = null;
    seq++;
    diffHead.replaceChildren();
    diffBody.replaceChildren(h('div.changes-empty', {}, h('div.spinner')));
    void loadDetail();
  };

  const renderBranches = () => {
    const d = detail;
    branchesList.replaceChildren();
    if (!d) return;
    for (const b of d.branches) branchesList.append(branchItem(b, b.name === d.branch));
    if (!d.branches.length) branchesList.append(h('li.empty', {}, 'No local branches'));
  };

  const branchItem = (b: GitBranchInfo, on: boolean) =>
    h(
      'li',
      { class: on ? 'on' : '', tabindex: 0, title: `${b.subject}\n${b.date ? new Date(b.date).toLocaleString() : ''}`, onclick: () => pickBranch(b.name), onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && pickBranch(b.name)) as EventListener },
      h('span.git-bname', {}, b.current ? h('b', { title: 'Checked out' }, '● ') : null, b.name),
      syncChips(b),
      h('span.git-bdate', {}, b.date ? timeAgo(b.date) : ''),
    );

  const renderFilesHead = () => {
    const d = detail;
    filesHead.replaceChildren();
    if (!d || d.error) return;
    const isCurrent = d.branch === d.current || !d.current;
    const fetchBtn = h('button.btn', { type: 'button', title: 'git fetch origin: bring the GitHub side up to date', onclick: () => void fetchNow() }, fetching ? '⏳ Fetching…' : '⬇️ Fetch');
    (fetchBtn as HTMLButtonElement).disabled = fetching;
    filesHead.append(
      h('div.git-on', {}, h('span', {}, '🌿 '), h('b', {}, d.branch), isCurrent ? h('span.git-tag', { title: 'This is the branch checked out in the folder' }, 'checked out') : h('span.git-tag.muted', { title: 'Not checked out: only its commits are compared' }, 'not checked out')),
      h(
        'div.git-vs',
        {},
        d.compare.ref ? h('span', {}, 'vs 🐙 ', h('b', {}, d.compare.ref)) : h('span', {}, 'nothing on GitHub to compare with'),
        !d.compare.unpublished && d.compare.ref ? syncChips({ upstream: d.compare.ref, ahead: d.ahead, behind: d.behind }) : null,
        fetchBtn,
      ),
      ...(d.compare.note ? [h('p.git-note', {}, d.compare.note)] : []),
      h('p.git-note', {}, fetching ? 'Fetching from GitHub…' : d.fetchedAt ? `GitHub side as of ${timeAgo(d.fetchedAt)}` : 'Never fetched here: the GitHub side may be old'),
    );
  };

  /** A small + / − on a row or a section: stage or unstage without selecting it. */
  const miniBtn = (label: string, tip: string, fn: () => void) => {
    const b = h('button.git-mini', { type: 'button', title: tip, 'aria-label': tip }, label);
    b.disabled = !!acting;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };

  const fileItem = (f: GitFileChange, m: GitDiffMode, stage?: 'stage' | 'unstage') => {
    const on = selected?.mode === m && selected.path === f.path;
    return h(
      'li',
      { class: on ? 'on' : '', role: 'option', 'aria-selected': on ? 'true' : 'false', tabindex: -1, onclick: () => select({ mode: m, path: f.path }) },
      statusChip(f.status),
      pathLabel(f.path),
      m === 'github' && f.uncommitted ? h('span.dirty', { title: 'Has uncommitted changes too' }) : null,
      plusMinus(f.additions, f.deletions, f.binary),
      stage === 'stage' ? miniBtn('+', `Stage ${f.path} (git add)`, () => void run('Staging…', 'stage', { paths: [f.path] })) : null,
      stage === 'unstage' ? miniBtn('−', `Unstage ${f.path} (keeps the edits)`, () => void run('Unstaging…', 'unstage', { paths: [f.path] })) : null,
    );
  };

  const section = (heading: string, count: number, items: HTMLElement[], empty: string, hint?: string, action?: HTMLElement) =>
    h('section.git-section', {}, h('h4', { title: hint ?? '' }, h('span.grow', {}, heading), action ?? null, h('span.git-count', {}, String(count))), h('ul', { role: 'listbox', 'aria-label': heading }, ...(items.length ? items : [h('li.empty', {}, empty)])));

  const commitItems = (cs: GitCommitLine[]) => cs.map((c) => h('li.git-commit', { title: `${c.author} · ${new Date(c.date).toLocaleString()}` }, h('code', {}, c.hash), h('span.path', {}, c.subject), h('span.git-bdate', {}, timeAgo(c.date))));

  /** Every file row in display order, for arrow keys. */
  let order: { mode: GitDiffMode; path: string }[] = [];

  const renderLists = () => {
    const d = detail;
    lists.replaceChildren();
    order = [];
    if (!d || d.error) return;
    const isCurrent = d.branch === d.current || !d.current;
    if (isCurrent) {
      const staged = d.uncommitted.filter((f) => f.staged);
      const changes = d.uncommitted.filter((f) => f.unstaged || f.status === '?');
      // A file can be in both, as in VS Code; its diff shows both together (against the last commit).
      lists.append(
        section('Staged changes', staged.length, staged.map((f) => fileItem(f, 'uncommitted', 'unstage')), 'Nothing staged', 'git add-ed, ready to commit', staged.length ? miniBtn('−', 'Unstage everything (keeps the edits)', () => void run('Unstaging…', 'unstage', {})) : undefined),
        section('Changes', changes.length, changes.map((f) => fileItem(f, 'uncommitted', 'stage')), staged.length ? 'Nothing left to stage' : 'No uncommitted changes', 'Edited, deleted or new files not staged yet', changes.length ? miniBtn('+', 'Stage everything (git add .)', () => void run('Staging…', 'stage', {})) : undefined),
      );
      const seen = new Set<string>();
      for (const f of [...staged, ...changes]) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        order.push({ mode: 'uncommitted', path: f.path });
      }
    }
    const gh = d.githubFiles;
    lists.append(
      section(
        d.compare.unpublished ? `Changed from ${d.compare.ref}` : d.compare.ref ? `Different from GitHub` : 'Different from GitHub',
        gh.length + d.more,
        gh.map((f) => fileItem(f, 'github')),
        d.compare.ref ? `Same as ${d.compare.ref}` : 'Nothing to compare with',
        d.compare.ref ? `Every file that differs from ${d.compare.ref}${isCurrent ? ', including uncommitted edits' : ''}` : undefined,
      ),
    );
    for (const f of gh) order.push({ mode: 'github', path: f.path });
    if (d.more) lists.append(h('p.git-note', {}, `…and ${d.more} more files`));
    if (d.outgoing.length || d.ahead) lists.append(section(d.compare.unpublished ? 'Commits on this branch' : 'Commits not on GitHub', d.ahead, commitItems(d.outgoing), '', 'Push to put these on GitHub'));
    if (d.incoming.length || d.behind) lists.append(section('On GitHub, not here', d.behind, commitItems(d.incoming), '', 'Pull to bring these here'));
    lists.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  };

  const currentFile = (): GitFileChange | undefined => {
    if (!detail || !selected) return undefined;
    const list = selected.mode === 'github' ? detail.githubFiles : detail.uncommitted;
    return list.find((f) => f.path === selected!.path);
  };

  let diffSeq = 0;
  const loadDiff = async (keepScroll = false) => {
    const f = currentFile();
    if (!f || !selected || repo === null) return;
    const mine = ++diffSeq;
    const sel = selected;
    const top = keepScroll ? diffBody.scrollTop : 0;
    try {
      const r = await api<GitDiff & { error?: string }>('diff', { repo, branch, path: sel.path, mode: sel.mode });
      if (closed || mine !== diffSeq) return;
      diffBody.replaceChildren(r.error ? h('div.changes-empty', {}, h('p', {}, r.error)) : r.diff ? renderDiff(r.diff, r.truncated) : h('div.changes-empty', {}, h('p', {}, f.binary ? 'A binary file: no line-by-line diff.' : 'No line changes (only its mode or name changed).')));
      diffBody.scrollTop = top;
    } catch (err) {
      if (closed || mine !== diffSeq) return;
      diffBody.replaceChildren(h('div.changes-empty', {}, h('p', {}, (err as Error).message)));
    }
  };

  const renderDiffHead = () => {
    const f = currentFile();
    if (!f || !selected || !detail) return diffHead.replaceChildren();
    const against = selected.mode === 'github' ? `vs ${detail.compare.ref ?? 'GitHub'}` : f.staged && f.unstaged ? 'staged + unstaged, vs last commit' : f.staged ? 'staged, vs last commit' : 'vs last commit';
    diffHead.replaceChildren(statusChip(f.status), h('span.path', { title: f.path }, f.from ? `${f.from} → ${f.path}` : f.path), h('span.word', {}, `${STATUS_WORD[f.status]} · ${against}`), plusMinus(f.additions, f.deletions, f.binary));
  };

  const select = (s: { mode: GitDiffMode; path: string } | null) => {
    if (s && selected && s.mode === selected.mode && s.path === selected.path) return;
    selected = s;
    renderLists();
    renderDiffHead();
    if (s) {
      diffBody.replaceChildren(h('div.changes-empty', {}, h('div.spinner')));
      void loadDiff();
    } else renderEmpty();
  };

  const renderEmpty = () => {
    const d = detail;
    diffHead.replaceChildren();
    if (!d) return;
    if (d.error) return diffBody.replaceChildren(h('div.changes-empty', {}, h('div.big', {}, '🚧'), h('p', {}, d.error)));
    const clean = !d.uncommitted.length && !d.githubFiles.length;
    diffBody.replaceChildren(
      h(
        'div.changes-empty',
        {},
        h('div.big', {}, clean ? '✨' : '👈'),
        h('p', {}, clean ? `${d.branch} matches ${d.compare.ref ?? 'its last commit'}${d.behind ? `, though GitHub has ${d.behind} newer commit${d.behind === 1 ? '' : 's'}` : ''}.` : 'Pick a file to see its changes.'),
        h('p.note', {}, 'This follows the folder while it’s open, so edits show up here as they are made.'),
      ),
    );
  };

  // ---- Stage, commit, push: the footer ----

  const loadPr = async () => {
    if (repo === null) return;
    const r = repo;
    try {
      const got = await api<{ branch?: string; pr?: PullRequestRef; error?: string }>('pr', { repo: r });
      if (closed || repo !== r) return;
      // No gh, or not logged in: the PR button just isn't offered.
      pr = got.error ? { branch: undefined } : got;
    } catch {
      if (!closed && repo === r) pr = { branch: undefined };
    }
    renderFooter();
  };

  /** Runs one action; the reply's error (or its absence) becomes a toast. */
  const run = async (label: string, path: string, input: unknown, done?: (r: Record<string, unknown>) => string | void): Promise<boolean> => {
    if (repo === null || acting) return false;
    const r = repo;
    acting = label;
    renderFooter();
    renderLists();
    let ok = false;
    try {
      const res = await api<Record<string, unknown> & { error?: string }>(path, { repo: r }, 'POST', input);
      if (res.error) toast(res.error, 'error');
      else {
        ok = true;
        const said = done?.(res);
        if (said) toast(said);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      acting = null;
      if (!closed && repo === r) {
        await loadDetail();
        renderFooter();
        renderLists();
      }
      void loadGitRepos();
      void loadOffice().then(() => {
        if (ok && path === 'pull' && office && detail?.github && detail.github === office.github && office.dir) {
          officeOpen = true;
          if (!closed) renderOfficeStatus(officeBar, office, officeOpen);
          if (office.needs.pull || office.needs.build || office.needs.restart) toast('Pulled. Next: update the running office: the steps are in the 🏢 bar at the top.');
        }
      });
    }
    return ok;
  };

  const commit = () => {
    const d = detail;
    if (!d) return;
    const staged = d.uncommitted.filter((f) => f.staged).length;
    const all = d.uncommitted.length;
    openPrompt({
      title: staged ? `✅ Commit ${staged} staged file${staged === 1 ? '' : 's'}` : `✅ Stage all ${all} and commit`,
      subtitle: `git commit -m on ${d.branch}${staged ? '' : ' (nothing is staged, so everything is added first: git add .)'}. The first line is the summary.`,
      placeholder: 'What changed, and why',
      submitLabel: 'Commit',
      onSubmit: (message) => void run('Committing…', 'commit', { message }, (res) => `✅ Committed ${String(res.hash ?? '')}${res.stagedAll ? ' (staged everything first)' : ''} on ${d.branch}`),
    });
  };

  const push = () => {
    const d = detail;
    if (!d?.current) return;
    const branch = d.current;
    const go = () =>
      void run('Pushing…', 'push', {}, () => `⬆️ Pushed ${branch} to origin/${branch}`).then((ok) => {
        if (ok) void loadPr();
      });
    if (d.defaultBranch === branch)
      confirmDialog(
        `Push straight to ${branch}?`,
        `${branch} is the branch pull requests go into on GitHub, so this skips review. The usual way is to commit on a branch of its own, push that and open a pull request.`,
        'Push anyway',
        go,
      );
    else go();
  };

  const openPr = () => {
    const d = detail;
    if (!d?.current || !d.defaultBranch) return;
    openPrompt({
      title: '🔀 Open a pull request',
      subtitle: `${d.current} → ${d.defaultBranch}${d.github ? ` on ${d.github}` : ''}. The first line is the title; the rest is the description.`,
      initial: d.outgoing[0]?.subject ?? '',
      placeholder: 'Title',
      submitLabel: 'Open PR ↗',
      onSubmit: (text) => {
        const [first, ...rest] = text.split('\n');
        void run('Opening a pull request…', 'pr', { title: first.trim(), body: rest.join('\n').trim() }, (res) => `🔀 Pull request: ${String(res.url ?? '')}`).then((ok) => {
          if (ok) void loadPr();
        });
      },
    });
  };

  const renderFooter = () => {
    const d = detail;
    const live = !!d && !d.error && !!d.current && d.branch === d.current;
    footer.hidden = repo === null || !d || !!d.error;
    footer.replaceChildren();
    if (footer.hidden || !d) return;
    if (!live) {
      footer.append(h('span.grow', {}, h('span', {}, `${d.branch} isn't checked out here, so this is a look only. Stage, commit and push work on ${d.current ?? 'a checked-out branch'}.`)));
      return;
    }
    const staged = d.uncommitted.filter((f) => f.staged).length;
    const unstaged = d.uncommitted.filter((f) => f.unstaged || f.status === '?').length;
    const busy = !!acting || fetching;
    const summary = h('span.grow', {});
    if (acting) summary.append(h('span.spinner'), h('span', {}, acting));
    else {
      const bits = [
        d.uncommitted.length ? `${d.uncommitted.length} uncommitted` : 'nothing uncommitted',
        staged ? `${staged} staged` : '',
        d.compare.unpublished ? `not on GitHub yet${d.ahead ? ` · ${d.ahead} commit${d.ahead === 1 ? '' : 's'}` : ''}` : d.compare.ref ? `${d.ahead ? `↑${d.ahead} to push` : 'nothing to push'}${d.behind ? ` · ↓${d.behind} to pull` : ''}` : '',
      ];
      summary.append(...bits.filter(Boolean).map((b) => h('span', {}, b)));
    }
    const stageAll = h('button.btn.git-big', { type: 'button', title: 'git add . — stage every change, new files too' }, `➕ git add .${unstaged ? ` (${unstaged})` : ''}`);
    stageAll.disabled = busy || !unstaged;
    stageAll.addEventListener('click', () => void run('Staging everything…', 'stage', {}, () => `➕ Staged ${unstaged} file${unstaged === 1 ? '' : 's'}`));
    const commitBtn = h('button.btn.git-big', { type: 'button', title: staged ? 'git commit -m: commit what is staged' : 'Nothing staged: stage everything, then commit' }, staged ? `✅ Commit ${staged}…` : '✅ Commit…');
    commitBtn.disabled = busy || !d.uncommitted.length;
    commitBtn.addEventListener('click', commit);
    const pullBtn = !d.compare.unpublished && d.behind ? h('button.btn', { type: 'button', title: `git pull --ff-only from ${d.compare.ref}` }, `⬇️ Pull ${d.behind}`) : null;
    if (pullBtn) {
      pullBtn.disabled = busy;
      pullBtn.addEventListener('click', () => void run('Pulling…', 'pull', {}, () => `⬇️ Pulled ${d.compare.ref} into ${d.current}`));
    }
    const publish = d.compare.unpublished || !d.compare.ref;
    const pushBtn = h('button.btn.git-big.primary', { type: 'button', title: publish ? `git push -u origin ${d.current}: put this branch on GitHub` : `git push origin ${d.current}` }, publish ? '⬆️ Publish branch' : `⬆️ Push${d.ahead ? ` ${d.ahead}` : ''}`);
    pushBtn.disabled = busy || (!publish && !d.ahead) || (!!d.behind && !publish);
    if (!publish && d.behind && d.ahead) pushBtn.title = 'GitHub has commits this branch lacks: pull first';
    pushBtn.addEventListener('click', push);
    const prSlot = h('span.pr-slot');
    const known = pr;
    if (known && d.defaultBranch && d.current !== d.defaultBranch && known.branch === d.current) {
      const open = known.pr;
      if (open) prSlot.append(h('a.btn', { href: open.url, target: '_blank', rel: 'noopener', title: 'Open on GitHub' }, `🔀 ${pullRequestLabel(open)} ↗`));
      if (!open || open.state !== 'OPEN') {
        const b = h('button.btn', { type: 'button', title: publish ? 'Publish the branch first' : d.ahead ? 'Push first' : `Open a pull request into ${d.defaultBranch}` }, '🔀 Open PR…');
        b.disabled = busy || publish || d.ahead > 0;
        b.addEventListener('click', openPr);
        prSlot.append(b);
      }
    }
    footer.append(summary, stageAll, commitBtn, ...(pullBtn ? [pullBtn] : []), pushBtn, prSlot);
  };

  const renderDetail = (changed: boolean) => {
    const d = detail;
    if (!d) return;
    title.textContent = `🌿 ${d.name}`;
    status.textContent = d.github ? `🐙 ${d.github}` : '';
    renderFilesHead();
    renderFooter();
    // Checked out another branch since: its pull request is someone else's.
    if (pr && pr.branch !== undefined && d.current && pr.branch !== d.current) void loadPr();
    if (!changed) return;
    renderBranches();
    if (d.error) {
      lists.replaceChildren();
      return renderEmpty();
    }
    // Keep the file shown if it's still changed; otherwise the first one.
    if (!currentFile()) {
      selected = null;
      renderLists();
      const first = order[0];
      if (first) select(first);
      else renderEmpty();
      return;
    }
    renderLists();
    renderDiffHead();
    void loadDiff(true);
  };

  el.addEventListener('keydown', (e) => {
    if (repo === null || !order.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k') return;
    const i = order.findIndex((o) => selected && o.mode === selected.mode && o.path === selected.path);
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1)))];
    if (next) select(next);
    e.preventDefault();
  });

  pullsBtn.addEventListener('click', () => {
    modal.close();
    actions.pulls();
  });
  refresh.addEventListener('click', () => {
    if (repo === null) void loadGitRepos();
    else void fetchNow();
  });

  const unsubs = [onGitRepos(renderRepos)];
  let ticks = 0;
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (++ticks % 4 === 0) void loadOffice();
    if (repo === null) renderRepos();
    else if (!fetching && !acting) void loadDetail();
  }, POLL_MS);
  const modal = openModal(el, {
    doing: '🌿 at the Git board',
    onClose: () => {
      closed = true;
      unsubs.forEach((u) => u());
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  if (startRepo) openRepo(startRepo);
  else if (gitRepos.list?.repos.length === 1 && gitRepos.list.floorIsRepo) {
    // A floor that is one repository: straight to it, with the list a click away.
    openRepo('.');
  } else renderRepos();
  void loadGitRepos().then(() => {
    if (!startRepo && repo === null && gitRepos.list?.floorIsRepo) openRepo('.');
  });
  void loadOffice();
  setTimeout(() => el.focus(), 30);
}
