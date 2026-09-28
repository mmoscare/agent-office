import { DESK_BY_ID } from '../../shared/layout';
import { ghRef, type AgentEffort, type AgentProvider, type GhIssue, type GhPull, type GhWhere, type UnshippedItem, type WorkerInfo } from '../../shared/protocol';
import { agentForBranch } from '../../shared/pulls';
import { recoveryTitle } from '../../shared/task-status';
import type { Net } from '../net';
import { store, workerForPull } from '../state';
import { h, openModal, timeAgo } from './dom';
import { labelChip, openIssue, openPull } from './pull';
import { providerLabel } from './provider';
import type { MeetingPreset } from './meeting';

export interface BoardActions {
  /** Start a worker on a ready-made prompt (shown for editing first). */
  assign(prompt: string, title: string): void;
  /** Your own prompt about an issue or PR; `context` goes first so the worker knows which. */
  ask(context: string, title: string): void;
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

function pullColumns(items: GhPull[]): Column<GhPull>[] {
  const open = items.filter((p) => p.state === 'OPEN');
  return [
    { title: '✏️ Draft', items: open.filter((p) => p.isDraft) },
    { title: '👀 In review', items: open.filter((p) => !p.isDraft && p.reviewDecision !== 'APPROVED') },
    { title: '👍 Approved', items: open.filter((p) => !p.isDraft && p.reviewDecision === 'APPROVED') },
    { title: '🎉 Merged', items: items.filter((p) => p.state === 'MERGED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30) },
    { title: '🗑️ Closed', items: items.filter((p) => p.state === 'CLOSED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20) },
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

/** The agent whose branch a pull request came from, once its worker has left the desk: small, beside the author. */
function agentChip(pr: GhPull): Node | '' {
  const name = agentForBranch(pr.headRefName);
  return name ? h('span.pr-agent', { title: `Submitted by ${name} (${pr.headRefName})` }, `🤖 ${name}`) : '';
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

/**
 * The PR board's first column: office branches holding work that no open or merged PR carries (see
 * server/unshipped.ts), each with a button that queues a fresh worker to recover it into a PR.
 */
function unshippedColumn(net: Net, actions: BoardActions): HTMLElement {
  const u = store.unshipped;
  const ul = h('ul');
  if (u.error) ul.append(h('li.unshipped-note', {}, `Couldn't look through the branches: ${u.error}`));
  if (u.prNote) ul.append(h('li.unshipped-note', {}, `❔ GitHub couldn't be asked about some branches (${u.prNote}), so they may have a PR after all. Showing what's on disk.`));
  u.items.forEach((it) => ul.append(unshippedCard(it, net, actions)));
  if (!u.items.length && !u.error) ul.append(h('li.empty', {}, u.scannedAt ? 'Nothing unshipped 🎉' : 'Looking through the branches…'));
  const rescan = h('button.btn.unshipped-rescan', { type: 'button', title: 'Look through the branches again', disabled: u.scanning, onclick: () => net.send({ t: 'unshipped.scan' }) }, u.scanning ? '…' : '🔄');
  return h(
    'section.column.unshipped',
    { title: 'Office branches with uncommitted changes or commits that no open or merged pull request carries' },
    h('h4', {}, '🧳 Unshipped work', h('span', {}, rescan, ` ${u.items.length}`)),
    ul,
  );
}

function unshippedCard(it: UnshippedItem, net: Net, actions: BoardActions): HTMLElement {
  const w = it.workerId ? store.workers.get(it.workerId) : undefined;
  const recovery = store.queue.tasks.find((t) => t.title === recoveryTitle(it.branch, it.repository) && t.status !== 'done');
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const meta: (Node | string)[] = [
    it.repository ? h('span.qchip', { title: it.repository }, `📁 ${it.repository}`) : '',
    `🤖 ${it.workerName ?? 'unknown worker'} · ${it.worker === 'active' ? 'working' : it.worker === 'idle' ? 'at its desk' : 'gone'}`,
    it.dirty ? h('span.unshipped-count', {}, `📝 ${plural(it.dirty, 'uncommitted file')}`) : '',
    it.commits ? h('span.unshipped-count', {}, `📦 ${plural(it.commits, 'commit')} not on ${it.base ?? 'base'}`) : '',
    it.unpushed ? `⬆ ${it.unpushed} unpushed` : '',
    it.added || it.deleted ? h('span', {}, h('span', { style: 'color:#2a9d4b' }, `+${it.added ?? 0}`), ' ', h('span', { style: 'color:#c3423f' }, `-${it.deleted ?? 0}`)) : '',
    it.pr === 'unknown' ? h('span.qchip', { title: 'GitHub could not be asked; it may have a PR' }, '❔ PR unknown') : '',
    it.modifiedAt ? timeAgo(it.modifiedAt) : '',
  ];
  const action = it.worker === 'active'
    ? h('span.qchip.running', { title: 'Its worker is still running; wait for it to finish' }, '🤖 in progress')
    : recovery
      ? h('span.qchip', {}, recovery.status === 'running' ? `🤖 recovery running · ${recovery.workerName ?? ''}` : '📋 recovery queued')
      : h('button.btn', {
          type: 'button',
          title: `Queue a task: a fresh worker copies this work onto the latest ${it.base ?? 'base branch'} and opens a pull request, leaving this worktree as it is`,
          onclick: (e: Event) => {
            e.stopPropagation();
            net.send({ t: 'unshipped.recover', key: it.key });
          },
        }, '📋 Queue a PR');
  const open = () => w && actions.goToDesk(w.deskId);
  return h(
    'li.card.unshipped-card',
    { tabindex: 0, title: it.path ? `Worktree: ${it.path}` : 'Its worktree folder is gone; only the branch is left', onclick: open, onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && open()) as EventListener },
    h('div.num', {}, `🌿 ${it.branch}`),
    h('div.ttl', {}, it.taskTitle ?? it.path ?? it.branch),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
    h('div.unshipped-action', {}, action),
  );
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
  const status = h('span.board-status');
  const refresh = h('button.btn', { title: 'Refresh from GitHub', onclick: () => net.send({ t: 'gh.refresh' }) }, '🔄 Refresh');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const git = kind === 'pulls' && actions.gitBoard ? h('button.btn', { title: 'Turn the board over to the Git repositories on this floor', onclick: () => { modal.close(); actions.gitBoard?.(); } }, '🌿 Git') : null;
  const el = h('div.modal.board', { role: 'dialog', 'aria-label': kind === 'issues' ? 'Issues board' : 'Pull requests board' }, h('header', {}, h('h2', {}, kind === 'issues' ? '📌 Issues' : '🔀 Pull Requests'), status, git, refresh, close), body);

  const render = () => {
    const st = kind === 'issues' ? store.issues : store.pulls;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
    // Every refresh rebuilds the columns, so note how far each was scrolled and put it back afterwards.
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    const { scrollLeft, scrollTop } = body;
    body.replaceChildren();
    if (st.error && !st.items.length) {
      // What's on disk doesn't need GitHub: unshipped work still shows when it can't be reached.
      if (kind === 'pulls') body.append(unshippedColumn(net, actions));
      body.append(h('div.board-error', {}, `Couldn't load from GitHub: ${st.error}`, h('br'), h('small', {}, "The server runs `gh` in the floor's folder, or in each GitHub checkout inside it when the folder isn't one itself — make sure it is installed and authenticated (gh auth login).")));
      return;
    }
    if (kind === 'issues') {
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
    } else {
      body.append(unshippedColumn(net, actions));
      for (const col of pullColumns(store.pulls.items)) {
        const ul = h('ul');
        col.items.forEach((it, i) => {
          const w = workerForPull(store.workers.values(), it);
          ul.append(
            card(
              it,
              [
                repoChip(it),
                w ? deskChip(w) : agentChip(it),
                ...labelChips(it.labels),
                `by ${it.author}`,
                it.reviewDecision === 'CHANGES_REQUESTED' ? '🛠 changes requested' : '',
                CHECK_ICON[it.checks],
                h('span', { style: 'color:#2a9d4b' }, `+${it.additions}`),
                h('span', { style: 'color:#c3423f' }, `-${it.deletions}`),
                timeAgo(it.updatedAt),
              ],
              i,
              () => openPull(it, net, actions),
            ),
          );
        });
        if (!col.items.length) ul.append(h('li.empty', {}, 'Nothing here'));
        body.append(h('section.column', {}, h('h4', {}, col.title, h('span', {}, String(col.items.length))), ul));
      }
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
