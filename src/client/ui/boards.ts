import { DESK_BY_ID } from '../../shared/layout';
import { ghKey, ghRef, type AgentEffort, type AgentProvider, type GhIssue, type GhPull, type GhWhere, type UnshippedItem, type WorkerInfo, type PullWork } from '../../shared/protocol';
import { pullWorkers } from '../../shared/pull-work';
import { recoveryTitle } from '../../shared/task-status';
import type { Net } from '../net';
import { store, workerForPull } from '../state';
import { h, openModal, timeAgo } from './dom';
import { labelChip, openIssue, openPull } from './pull';
import { providerLabel } from './provider';
import { pullWorkIndicators } from './pull-work';
import type { MeetingPreset } from './meeting';
import { ghTrouble, groupByRepo, manyRepos, pullSections, pullStatus } from './pr-board-model';
import { diffStat, emptyRow, pill, repoHeading, row, section, skeletonRows } from './pr-board-parts';
import { unshippedSection } from './unshipped-list';

export interface BoardActions {
  /** Start a worker on a ready-made prompt (shown for editing first). */
  assign(prompt: string, title: string, pullWork?: PullWork): void;
  /** Your own prompt about an issue or PR; `context` goes first so the worker knows which. */
  ask(context: string, title: string, pullWork?: PullWork): void;
  /** Walks you to the desk a pull request came from. */
  goToDesk(deskId: string): void;
  /** Put an issue (of `repo`, on a floor of several) on the 📋 task queue; a worker is seated for it when there's room. */
  queue(prompt: string, title: string, issue: number, provider?: AgentProvider, model?: string, effort?: AgentEffort, repo?: string): void;
  /** Take the issue's card off the board, to carry to a desk or the queue. */
  pickUp(issue: GhIssue): void;
  /** Call a meeting about it: the meeting room's form, filled in. */
  meeting(preset: MeetingPreset): void;
  /** Turn the PR board over to the floor's Git repositories (ui/git-board.ts). */
  gitBoard?(): void;
}

/** ` --repo owner/name` for gh, on a floor that's a folder of checkouts: from there gh can't tell which repository is meant. */
export function repoFlag(it: GhWhere): string {
  return it.repo ? ` --repo ${it.repo}` : '';
}

/** Which checkout to work in, on a floor that's a folder of them ('' on a floor that's one). */
export function checkoutNote(it: GhWhere): string {
  return it.repo ? `It's in ${it.repo}, which is checked out in the \`${it.repoDir ?? '.'}\` folder here: cd into it and do the work there.\n\n` : '';
}

/** The task a worker gets for an issue, from the board, a carried card or the queue. */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title' | 'repo' | 'repoDir'>): string {
  return `Work on GitHub issue ${it.repo ? `${it.repo}` : ''}#${it.number}: "${it.title}".\n\n${checkoutNote(it)}Read it first with \`gh issue view ${it.number} --comments${repoFlag(it)}\`. Create a new branch, implement the change, verify it, then open a pull request that closes #${it.number}.`;
}

const TILTS = ['-1.2deg', '0.8deg', '-0.4deg', '1.4deg', '0deg', '-0.9deg'];
const NOTE_COLORS = ['#fff7b0', '#ffd6e0', '#caffbf', '#bde0fe', '#ffe5b4'];

interface Column<T> {
  title: string;
  items: T[];
}

function issueColumns(items: GhIssue[]): Column<GhIssue>[] {
  const open = items.filter((i) => i.state === 'OPEN');
  const inProgress = open.filter((i) => i.assignees.length > 0 || i.labels.some((l) => /progress|doing|wip|started/i.test(l.name)) || store.taskForIssue(i.number, i.repo)?.status === 'running');
  const todo = open.filter((i) => !inProgress.includes(i));
  const closed = items.filter((i) => i.state !== 'OPEN').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  return [
    { title: '📥 Open', items: todo },
    { title: '🚧 In progress', items: inProgress },
    { title: '✅ Closed', items: closed },
  ];
}

function labelChips(labels: { name: string; color: string }[]) {
  return labels.slice(0, 4).map(labelChip);
}

const CHECK_ICON: Record<GhPull['checks'], string> = { pass: '🟢', fail: '🔴', pending: '🟡', none: '' };

/** A chip naming a worker and desk, color-coded to match the worker back on the floor. */
function workerChip(w: WorkerInfo, title: string) {
  return h('span.desk-link', { style: `--dot:${w.color}`, title }, `🪑 ${w.name} · ${DESK_BY_ID.get(w.deskId)?.label ?? 'a desk'}`);
}

/** A chip naming the worker and desk a pull request came from. */
function deskChip(w: WorkerInfo) {
  return workerChip(w, `Opened from ${w.name}'s desk (${w.worktree?.branch ?? 'its branch'})`);
}

/** Where an issue stands on the 📋 queue, for its card. */
function queueChip(issue: GhIssue): Node | '' {
  const t = store.taskForIssue(issue.number, issue.repo);
  if (!t) return '';
  const provider = providerLabel(t.provider, store.project);
  if (t.status === 'queued') return h('span.qchip', {}, `${store.queue.tasks.find((x) => x.status === 'queued') === t ? '📋 up next' : '📋 queued'} · ${provider}`);
  if (t.status === 'running') {
    const w = t.workerId ? store.workers.get(t.workerId) : undefined;
    if (w) return workerChip(w, `${w.name} is working on this at ${DESK_BY_ID.get(w.deskId)?.label ?? 'a desk'} · ${provider}`);
    return h('span.qchip.running', {}, `🤖 ${t.workerName ?? 'a worker'} · ${provider}`);
  }
  return t.pr ? h('span.qchip.done', {}, `🔀 PR #${t.pr.number} · ${provider}`) : '';
}

/** The repository a card is in, on a floor that's a folder of several. */
function repoChip(it: GhWhere): Node | '' {
  return it.repo ? h('span.qchip', { title: it.repo }, `📁 ${it.repoDir ?? it.repo}`) : '';
}

/** The Unshipped work section, fed from the store (see ui/unshipped-list.ts). */
function unshipped(net: Net, actions: BoardActions): HTMLElement {
  const u = store.unshipped;
  const recoveryOf = (it: UnshippedItem) => store.queue.tasks.find((t) => t.title === recoveryTitle(it.branch, it.repository) && t.status !== 'done');
  const workerOf = (it: UnshippedItem) => (it.workerId ? store.workers.get(it.workerId) : undefined);
  return unshippedSection({
    ...u,
    recovery: (it) => {
      const t = recoveryOf(it);
      return t && { running: t.status === 'running', workerName: t.workerName };
    },
    workerColor: (it) => workerOf(it)?.color,
    rescan: () => net.send({ t: 'unshipped.scan' }),
    recover: (it) => net.send({ t: 'unshipped.recover', key: it.key }),
    goToWorker: (it) => {
      const w = workerOf(it);
      if (w) actions.goToDesk(w.deskId);
    },
  });
}

/** What to say when GitHub didn't answer, by why. */
function troubleText(error: string, haveItems: boolean): { icon: string; text: string; sub: string } {
  const kept = haveItems ? ' Showing the last list it gave.' : '';
  switch (ghTrouble(error)) {
    case 'rate-limit':
      return { icon: '⏳', text: `GitHub's rate limit is reached.${kept}`, sub: 'The board tries again by itself; unshipped work is read from disk and still shows.' };
    case 'setup':
      return { icon: '🔑', text: `gh isn't set up on the server.${kept}`, sub: 'Install the GitHub CLI and run `gh auth login` where the office runs.' };
    case 'offline':
      return { icon: '📡', text: `Couldn't reach GitHub.${kept}`, sub: error };
    default:
      return { icon: '⚠️', text: `Couldn't load from GitHub.${kept}`, sub: error };
  }
}

/** One pull request's row. */
function pullRow(p: GhPull, showRepo: boolean, net: Net, actions: BoardActions): HTMLElement {
  const st = pullStatus(p);
  const w = st.tier === 'done' ? undefined : workerForPull(store.workers.values(), p);
  const checks = st.key !== 'failing' && st.key !== 'running' && p.checks !== 'none' && st.tier !== 'done' ? h('span', { title: `Checks ${p.checks === 'pass' ? 'pass' : p.checks}` }, CHECK_ICON[p.checks]) : '';
  return row({
    key: `p:${ghKey(p)}`,
    st: st.key,
    pill: pill(st.key, st.icon, st.label, st.hint),
    ref: showRepo ? ghRef(p) : `#${p.number}`,
    title: p.title,
    label: `${st.label}: ${ghRef(p)} ${p.title}`,
    when: timeAgo(p.updatedAt),
    compact: st.tier === 'done',
    meta: [
      h('span.prb-branch', { title: `${p.headRefName} into ${p.baseRefName}` }, `🌿 ${p.headRefName}`, h('span.prb-base', {}, ` → ${p.baseRefName}`)),
      ...pullWorkIndicators(p, actions.goToDesk),
      w && !pullWorkers([w], p).length ? deskChip(w) : '',
      ...labelChips(p.labels),
      `by ${p.author}`,
      checks,
      diffStat(p.additions, p.deletions),
    ],
    onOpen: () => openPull(p, net, actions),
  });
}

/** Rows for a section, under a heading per repository on a floor of several. */
function pullRows(items: GhPull[], showRepo: boolean, net: Net, actions: BoardActions): Node[] {
  if (!showRepo) return items.map((p) => pullRow(p, false, net, actions));
  return groupByRepo(items, (p) => p.repoDir ?? p.repo).flatMap((g) => [repoHeading(g.repo || 'this folder', g.items.length), ...g.items.map((p) => pullRow(p, true, net, actions))]);
}

/** Kept between redraws while the board is open. */
interface PullsView {
  doneOpen: boolean;
  doneAll: boolean;
}

/**
 * The Pull Requests board, top to bottom: a tally of what's where, then what needs you (PRs to
 * merge, review or fix, and work not yet in a PR), what's under way, and what's finished. On a wide
 * window the urgent sections sit on the left and the rest on the right; on a narrow one they stack.
 */
function renderPulls(body: HTMLElement, tally: HTMLElement, view: PullsView, net: Net, actions: BoardActions, rerender: () => void) {
  const st = store.pulls;
  const loading = !st.fetchedAt && !st.error;
  const unavailable = !!st.error && !st.items.length;
  const showRepo = manyRepos(st.items.map((p) => p.repo));
  const s = pullSections(st.items, view.doneAll ? Infinity : 10);
  const trouble = st.error ? troubleText(st.error, st.items.length > 0) : undefined;

  const jump = (id: string, icon: string, n: number | string, what: string, tone: string) =>
    h('button.prb-chip', { type: 'button', class: `tone-${tone}`, title: `Go to ${what}`, onclick: () => body.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' }) }, h('span', { 'aria-hidden': 'true' }, icon), h('b', {}, String(n)), what);
  const pending = loading ? '…' : unavailable ? '?' : undefined;
  tally.replaceChildren(
    jump('prb-needs', '🙋', pending ?? s.needsYou.length, s.needsYou.length === 1 ? 'needs you' : 'need you', 'needs'),
    jump('prb-unshipped', '🧳', store.unshipped.scannedAt ? store.unshipped.items.length : '…', 'unshipped', 'unshipped'),
    jump('prb-progress', '🚧', pending ?? s.inProgress.length, 'in progress', 'progress'),
    jump('prb-done', '🎉', pending ?? s.doneTotal, 'done', 'done'),
    trouble ? h('div.prb-banner', { role: 'status', title: st.error }, h('span.big', { 'aria-hidden': 'true' }, trouble.icon), h('div', {}, h('b', {}, trouble.text), h('small', {}, trouble.sub))) : '',
  );

  const blank = (icon: string, text: string, sub?: string): Node[] => (loading ? skeletonRows(2) : unavailable ? [emptyRow(trouble!.icon, 'GitHub unavailable', 'Pull requests show up here once it answers.')] : [emptyRow(icon, text, sub)]);
  const needs = section({ id: 'prb-needs', tone: 'needs', icon: '🙋', title: 'Needs you', count: s.needsYou.length, hint: 'merge, review or fix', rows: s.needsYou.length ? pullRows(s.needsYou, showRepo, net, actions) : blank('☕', 'Nothing waiting on you', 'Pull requests to review or merge land here.') });
  const progress = section({ id: 'prb-progress', tone: 'progress', icon: '🚧', title: 'In progress', count: s.inProgress.length, hint: 'drafts, running checks, changes asked', rows: s.inProgress.length ? pullRows(s.inProgress, showRepo, net, actions) : blank('🌱', 'Nothing in flight') });

  const doneRows = s.done.length ? pullRows(s.done, showRepo, net, actions) : blank('📭', 'Nothing merged yet');
  if (s.doneTotal > s.done.length || view.doneAll) {
    doneRows.push(h('li.prb-more', {}, h('button.btn.prb-tool', { type: 'button', onclick: () => ((view.doneAll = !view.doneAll), rerender()) }, view.doneAll ? 'Show fewer' : `Show all ${s.doneTotal}`)));
  }
  const done = section({ id: 'prb-done', tone: 'done', icon: '🎉', title: 'Recently done', count: s.doneTotal, hint: 'merged and closed', rows: doneRows });
  // Folds away, and stays as you left it across refreshes.
  const fold = h('button.btn.prb-tool', { type: 'button', 'aria-expanded': String(view.doneOpen), title: view.doneOpen ? 'Fold away' : 'Unfold', onclick: () => ((view.doneOpen = !view.doneOpen), rerender()) }, view.doneOpen ? '▾' : '▸');
  done.querySelector('h3')!.append(fold);
  done.classList.toggle('folded', !view.doneOpen);

  body.replaceChildren(h('div.prb-main', {}, needs, progress), h('div.prb-side', {}, unshipped(net, actions), done));
}

function card(it: GhIssue | GhPull, meta: (Node | string)[], i: number, onclick: () => void) {
  const n = it.number;
  const title = it.title;
  return h(
    'li.card',
    { style: `--tilt:${TILTS[n % TILTS.length]};background:${NOTE_COLORS[n % NOTE_COLORS.length]};--pin:${['#ef476f', '#118ab2', '#06d6a0', '#ffd166'][i % 4]}`, tabindex: 0, onclick, onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && onclick()) as EventListener },
    h('div.num', {}, ghRef(it)),
    h('div.ttl', {}, title),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
  );
}

export function openBoard(kind: 'issues' | 'pulls', net: Net, actions: BoardActions) {
  const body = h('div.body');
  const warning = h('div.board-error', { hidden: true });
  const status = h('span.board-status');
  const refresh = h('button.btn', { title: 'Refresh from GitHub', onclick: () => net.send({ t: 'gh.refresh' }) }, '🔄 Refresh');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const git = kind === 'pulls' && actions.gitBoard ? h('button.btn', { title: 'Turn the board over to the Git repositories on this floor', onclick: () => { modal.close(); actions.gitBoard?.(); } }, '🌿 Git') : null;
  const tally = h('div.prb-tally');
  const el = h(
    kind === 'pulls' ? 'div.modal.board.pr-board' : 'div.modal.board',
    { role: 'dialog', 'aria-label': kind === 'issues' ? 'Issues board' : 'Pull requests board' },
    h('header', {}, h('h2', {}, kind === 'issues' ? '📌 Issues' : '🔀 Pull Requests'), status, git, refresh, close),
    // GitHub trouble shows in the PR board's tally strip, and in this banner on the issues board.
    kind === 'pulls' ? tally : warning,
    body,
  );
  if (kind === 'pulls') body.classList.add('prb-body');
  const view: PullsView = { doneOpen: true, doneAll: false };

  const render = () => {
    const st = kind === 'issues' ? store.issues : store.pulls;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
    if (kind === 'pulls') {
      // Every refresh rebuilds the board: keep its scroll, and keyboard focus on the same row or button.
      const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused?.closest<HTMLElement>('[data-key]')?.dataset.key;
      const focusIsRow = !!focused?.matches('[data-key]');
      const focusSection = focused?.closest('section')?.id;
      const { scrollTop } = body;
      renderPulls(body, tally, view, net, actions, render);
      body.scrollTop = scrollTop;
      if (focused) {
        const row = focusKey ? body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null;
        const target = row && !focusIsRow ? row.querySelector<HTMLElement>('button') : row ?? (focusSection ? body.querySelector<HTMLElement>(`#${focusSection} h3 button:last-child`) : null);
        target?.focus({ preventScroll: true });
      }
      return;
    }
    // Every refresh rebuilds the columns, so note how far each was scrolled and put it back afterwards.
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    const { scrollLeft, scrollTop } = body;
    body.replaceChildren();
    warning.hidden = !st.error;
    if (st.error) warning.textContent = `${st.items.length ? 'Some GitHub data may be out of date' : "Couldn't load from GitHub"}: ${st.error}`;
    if (st.error && !st.items.length) return;
    for (const col of issueColumns(store.issues.items)) {
      const ul = h('ul');
      col.items.forEach((it, i) =>
        ul.append(
          card(it, [repoChip(it), ...labelChips(it.labels), queueChip(it), it.assignees.length ? `👤 ${it.assignees.join(', ')}` : `by ${it.author}`, it.comments ? `💬 ${it.comments}` : '', timeAgo(it.updatedAt)], i, () => openIssue(it, net, actions)),
        ),
      );
      if (!col.items.length) ul.append(h('li.empty', {}, 'Nothing here'));
      body.append(h('section.column', {}, h('h4', {}, col.title, h('span', {}, String(col.items.length))), ul));
    }
    body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    body.scrollLeft = scrollLeft;
    body.scrollTop = scrollTop;
  };

  const unsubs = [store.on(kind, render), store.on('queue', render)];
  // Which desk a PR came from can change (a worker sent home, a PR opened from a desk).
  if (kind === 'pulls') {
    unsubs.push(store.on('workers', render), store.on('unshipped', render));
    net.send({ t: 'unshipped.scan' });
  }
  const timer = setInterval(() => {
    const st = kind === 'issues' ? store.issues : store.pulls;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
  }, 15000);
  const modal = openModal(el, {
    doing: kind === 'issues' ? '📋 at the issues board' : '🔀 at the PR board',
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}
