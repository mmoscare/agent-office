import { DESK_BY_ID } from '../../shared/layout';
import { ghKey, ghRef, type AgentEffort, type AgentProvider, type GhIssue, type GhLabel, type GhPull, type GhWhere, type UnshippedItem, type WorkerInfo, type PullWork } from '../../shared/protocol';
import { pullWorkers } from '../../shared/pull-work';
import { recoveryTitle } from '../../shared/task-status';
import type { Net } from '../net';
import { store, workerForPull } from '../state';
import { h, openModal, timeAgo } from './dom';
import { labelChip, openIssue, openLabels, openPull } from './pull';
import { providerLabel } from './provider';
import { pullWorkIndicators } from './pull-work';
import type { MeetingPreset } from './meeting';
import { ghTrouble, groupByRepo, pullSections, pullStatus, showsRepo } from './pr-board-model';
import { diffStat, emptyRow, pill, repoHeading, row, section, skeletonRows, submitterChip } from './pr-board-parts';
import { unshippedSection } from './unshipped-list';
import { mountTodoBoard, type TodoBoard } from './todos';
import { mountNotesPad, type NotesPad } from './notes';
import { officePrompt } from './prompts';

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

/** The task a worker gets for an issue, from the board, a carried card or the queue (the 'issue.work' prompt). On a folder floor the worker is also told which checkout. */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title'> & Partial<Pick<GhIssue, 'url' | 'repo' | 'repoDir'>>): string {
  const prompt = officePrompt('issue.work', issueVars(it));
  return it.repo ? `${checkoutNote(it)}Add \`${repoFlag(it).trim()}\` to every \`gh\` command.\n\n${prompt}` : prompt;
}

/** What an issue's prompts fill in. A carried card has no URL, but the board usually knows it. */
export function issueVars(it: Pick<GhIssue, 'number' | 'title'> & { url?: string; repo?: string }) {
  return { number: it.number, title: it.title, url: it.url ?? store.issues.items.find((i) => i.number === it.number && (!it.repo || i.repo === it.repo))?.url ?? '' };
}

const TILTS = ['-1.2deg', '0.8deg', '-0.4deg', '1.4deg', '0deg', '-0.9deg'];
const NOTE_COLORS = ['#fff7b0', '#ffd6e0', '#caffbf', '#bde0fe', '#ffe5b4'];

interface Column<T> {
  /** Names the column in your saved label filters. */
  key: string;
  title: string;
  items: T[];
  /** Shows at most this many (after the label filter). */
  max?: number;
}

const byUpdated = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

function issueColumns(items: GhIssue[]): Column<GhIssue>[] {
  const open = items.filter((i) => i.state === 'OPEN');
  const inProgress = open.filter((i) => i.assignees.length > 0 || i.labels.some((l) => /progress|doing|wip|started/i.test(l.name)) || store.taskForIssue(i.number, i.repo)?.status === 'running');
  const todo = open.filter((i) => !inProgress.includes(i));
  return [
    { key: 'open', title: '📥 Open', items: todo },
    { key: 'progress', title: '🚧 In progress', items: inProgress },
    { key: 'closed', title: '✅ Closed', items: items.filter((i) => i.state !== 'OPEN').sort(byUpdated), max: 40 },
  ];
}

/** The labels each column is filtered to (column key → label names), per floor and board, kept in this browser. */
type LabelFilters = Record<string, string[]>;

function filtersKey(kind: 'issues' | 'pulls'): string {
  return `agent-office.board-labels.${store.floor ?? store.project?.dir ?? ''}.${kind}`;
}

function loadFilters(kind: 'issues' | 'pulls'): LabelFilters {
  const out: LabelFilters = {};
  try {
    const saved = JSON.parse(localStorage.getItem(filtersKey(kind)) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) if (Array.isArray(v) && v.length) out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // storage blocked or garbled
  }
  return out;
}

function saveFilters(kind: 'issues' | 'pulls', filters: LabelFilters) {
  try {
    localStorage.setItem(filtersKey(kind), JSON.stringify(filters));
  } catch {
    // storage blocked
  }
}

/** Every label on the board's cards, by name, for the column filters. */
function boardLabels(items: { labels: { name: string; color: string }[] }[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const it of items) for (const l of it.labels) if (!all.has(l.name)) all.set(l.name, l.color);
  return all;
}

function labelChips(labels: GhLabel[]) {
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
    compactDetail: st.tier === 'done' ? submitterChip(p.headRefName) : '',
    meta: [
      h('span.prb-branch', { title: `${p.headRefName} into ${p.baseRefName}` }, `🌿 ${p.headRefName}`, h('span.prb-base', {}, ` → ${p.baseRefName}`)),
      ...pullWorkIndicators(p, actions.goToDesk),
      // A worker still at its desk names itself; once it's gone, its branch still says who it was.
      w && !pullWorkers([w], p).length ? deskChip(w) : submitterChip(p.headRefName),
      ...labelChips(p.labels),
      `by ${p.author}`,
      checks,
      diffStat(p.additions, p.deletions),
    ],
    action: h('button.btn.prb-tool', { type: 'button', title: 'Change the labels', 'aria-label': `Change the labels on ${ghRef(p)}`, onclick: () => openLabels('pull', p, net) }, '🏷️'),
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

/** Click-to-filter state shared with the issues columns and the PR board. */
interface LabelUi {
  filters: LabelFilters;
  picking: string | null;
  toggle(key: string): void;
  setFilter(key: string, labels: string[]): void;
  picker(col: Column<GhPull>, all: Map<string, string>, picked: string[]): HTMLElement;
}

/**
 * The Pull Requests board, top to bottom: a tally of what's where, then what needs you (PRs to
 * merge, review or fix, and work not yet in a PR), what's under way, and what's finished. On a wide
 * window the urgent sections sit on the left and the rest on the right; on a narrow one they stack.
 * The labels chip filters every section, the same way a column header does on the issues board.
 */
function renderPulls(body: HTMLElement, tally: HTMLElement, view: PullsView, net: Net, actions: BoardActions, rerender: () => void, labels: LabelUi) {
  const st = store.pulls;
  const loading = !st.fetchedAt && !st.error;
  const unavailable = !!st.error && !st.items.length;
  const picked = labels.filters.pulls ?? [];
  const items = picked.length ? st.items.filter((p) => p.labels.some((l) => picked.includes(l.name))) : st.items;
  const showRepo = showsRepo(items.map((p) => p.repo));
  const s = pullSections(items, view.doneAll ? Infinity : 10);
  const trouble = st.error ? troubleText(st.error, st.items.length > 0) : undefined;
  const all = boardLabels(st.items);

  const jump = (id: string, icon: string, n: number | string, what: string, tone: string) =>
    h('button.prb-chip', { type: 'button', class: `tone-${tone}`, 'data-focus': `tally-${id}`, title: `Go to ${what}`, onclick: () => body.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' }) }, h('span', { 'aria-hidden': 'true' }, icon), h('b', {}, String(n)), what);
  const pending = loading ? '…' : unavailable ? '?' : undefined;
  const labelChipBtn = h(
    'button.prb-chip',
    {
      type: 'button',
      class: picked.length ? 'tone-needs' : '',
      'data-focus': 'tally-labels',
      'aria-expanded': String(labels.picking === 'pulls'),
      title: picked.length ? `Only pull requests labelled ${picked.join(' or ')}. Click to change.` : 'Filter by label',
      onclick: () => labels.toggle('pulls'),
    },
    h('span', { 'aria-hidden': 'true' }, '🏷️'),
    h('b', {}, picked.length ? String(picked.length) : 'all'),
    'labels',
  );
  tally.replaceChildren(
    jump('prb-needs', '🙋', pending ?? s.needsYou.length, s.needsYou.length === 1 ? 'needs you' : 'need you', 'needs'),
    jump('prb-unshipped', '🧳', store.unshipped.scannedAt ? store.unshipped.items.length : '…', 'unshipped', 'unshipped'),
    jump('prb-progress', '🚧', pending ?? s.inProgress.length, 'in progress', 'progress'),
    jump('prb-done', '🎉', pending ?? s.doneTotal, 'done', 'done'),
    labelChipBtn,
    trouble ? h('div.prb-banner', { role: 'status', title: st.error }, h('span.big', { 'aria-hidden': 'true' }, trouble.icon), h('div', {}, h('b', {}, trouble.text), h('small', {}, trouble.sub))) : '',
  );
  if (labels.picking === 'pulls') tally.append(labels.picker({ key: 'pulls', title: '🔀 Pull requests', items: st.items }, all, picked));
  else if (picked.length) {
    tally.append(
      h(
        'div.col-active',
        {},
        ...picked.map((name) => labelChip({ name, color: all.get(name) ?? '#dddddd' })),
        h('button.col-clear', { type: 'button', 'aria-label': 'Clear label filter', title: 'Show every pull request', 'data-focus': 'clear-pulls', onclick: () => labels.setFilter('pulls', []) }, '✕'),
      ),
    );
  }

  const blank = (icon: string, text: string, sub?: string): Node[] =>
    loading ? skeletonRows(2) : unavailable ? [emptyRow(trouble!.icon, 'GitHub unavailable', 'Pull requests show up here once it answers.')] : picked.length ? [emptyRow('🏷️', 'Nothing with those labels')] : [emptyRow(icon, text, sub)];
  const needs = section({ id: 'prb-needs', tone: 'needs', icon: '🙋', title: 'Needs you', count: s.needsYou.length, hint: 'merge, review or fix', rows: s.needsYou.length ? pullRows(s.needsYou, showRepo, net, actions) : blank('☕', 'Nothing waiting on you', 'Pull requests to review or merge land here.') });
  const progress = section({ id: 'prb-progress', tone: 'progress', icon: '🚧', title: 'In progress', count: s.inProgress.length, hint: 'drafts, running checks, changes asked', rows: s.inProgress.length ? pullRows(s.inProgress, showRepo, net, actions) : blank('🌱', 'Nothing in flight') });

  const doneRows = s.done.length ? pullRows(s.done, showRepo, net, actions) : blank('📭', 'Nothing merged yet');
  if (s.doneTotal > s.done.length || view.doneAll) {
    doneRows.push(h('li.prb-more', {}, h('button.btn.prb-tool', { type: 'button', 'data-focus': 'done-more', onclick: () => ((view.doneAll = !view.doneAll), rerender()) }, view.doneAll ? 'Show fewer' : `Show all ${s.doneTotal}`)));
  }
  const done = section({ id: 'prb-done', tone: 'done', icon: '🎉', title: 'Recently done', count: s.doneTotal, hint: 'merged and closed', rows: doneRows });
  // Folds away, and stays as you left it across refreshes.
  const fold = h('button.btn.prb-tool', { type: 'button', 'aria-expanded': String(view.doneOpen), title: view.doneOpen ? 'Fold away' : 'Unfold', onclick: () => ((view.doneOpen = !view.doneOpen), rerender()) }, view.doneOpen ? '▾' : '▸');
  done.querySelector('h3')!.append(fold);
  done.classList.toggle('folded', !view.doneOpen);

  body.replaceChildren(h('div.prb-main', {}, needs, progress), h('div.prb-side', {}, unshipped(net, actions), done));
}

function card(it: GhIssue | GhPull, meta: (Node | string)[], i: number, onclick: () => void, onLabels: () => void) {
  const n = it.number;
  const title = it.title;
  return h(
    'li.card',
    {
      style: `--tilt:${TILTS[n % TILTS.length]};background:${NOTE_COLORS[n % NOTE_COLORS.length]};--pin:${['#ef476f', '#118ab2', '#06d6a0', '#ffd166'][i % 4]}`,
      tabindex: 0,
      onclick,
      onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && onclick()) as EventListener,
    },
    h('button.card-labels', { type: 'button', title: 'Change the labels', 'aria-label': `Change the labels on ${ghRef(it)}`, onclick: ((e: Event) => (e.stopPropagation(), onLabels())) as EventListener }, '🏷️'),
    h('div.num', {}, ghRef(it)),
    h('div.ttl', {}, title),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
  );
}

/** Which side of the issues board shows: your own 🔥 To Do (the default), its other side your 🗒️ Notes pad, or the floor's GitHub issues. */
export type IssuesView = 'todo' | 'notes' | 'issues';

export function openBoard(kind: 'issues' | 'pulls', net: Net, actions: BoardActions, opts: { view?: IssuesView } = {}) {
  const body = h('div.body');
  const warning = h('div.board-error', { hidden: true });
  const status = h('span.board-status');
  const refresh = h('button.btn', { title: 'Refresh from GitHub', onclick: () => net.send({ t: 'gh.refresh' }) }, '🔄 Refresh');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const git = kind === 'pulls' && actions.gitBoard ? h('button.btn', { title: 'Turn the board over to the Git repositories on this floor', onclick: () => { modal.close(); actions.gitBoard?.(); } }, '🌿 Git') : null;
  const tally = h('div.prb-tally');
  // The issues board opens on your own To Do board, which follows you onto every floor; 📌 Issues turns it over.
  let view: IssuesView = kind === 'issues' ? (opts.view ?? 'todo') : 'issues';
  let todo: TodoBoard | undefined;
  let notes: NotesPad | undefined;
  const title = h('h2', {}, kind === 'issues' ? '📌 Issues' : '🔀 Pull Requests');
  const tab = (to: IssuesView, label: string, hint: string) => h('button.btn', { type: 'button', 'aria-pressed': 'false', 'data-view': to, title: hint, onclick: () => show(to) }, label);
  const tabs = kind === 'issues' ? h('div.board-tabs', { role: 'group', 'aria-label': 'Board' }, tab('todo', '🔥 To Do', 'Your own to-do list: the same on every floor'), tab('notes', '🗒️ Notes', 'Turn it over to your own notes pad: notes, pictures and links to watch'), tab('issues', '📌 Issues', "This floor's GitHub issues")) : null;
  const el = h(
    kind === 'pulls' ? 'div.modal.board.pr-board' : 'div.modal.board',
    { role: 'dialog', 'aria-label': kind === 'issues' ? 'Issues board' : 'Pull requests board' },
    h('header', {}, title, tabs, status, git, refresh, close),
    // GitHub trouble shows in the PR board's tally strip, and in this banner on the issues board.
    kind === 'pulls' ? tally : warning,
    body,
  );
  if (kind === 'pulls') body.classList.add('prb-body');
  const pullsView: PullsView = { doneOpen: true, doneAll: false };

  let turning = false;
  /** Turns the issues board over to `to`. To and from 🗒️ Notes it flips right over, like turning the pad around. */
  const show = (to: IssuesView) => {
    const was = view;
    if (to === was || turning) return;
    if (was === 'notes') notes?.flush();
    const swap = () => {
      view = to;
      render();
      if (to === 'todo') todo?.focus();
      if (to === 'notes') notes?.focus();
    };
    if ((was === 'notes') === (to === 'notes') || typeof el.animate !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return swap();
    turning = true;
    const turn = (fromDeg: number, toDeg: number, duration: number, easing: string) => el.animate([{ transform: `perspective(1800px) rotateY(${fromDeg}deg)` }, { transform: `perspective(1800px) rotateY(${toDeg}deg)` }], { duration, easing });
    turn(0, 90, 170, 'ease-in')
      .finished.catch(() => undefined)
      .then(() => {
        swap();
        return turn(-90, 0, 230, 'ease-out').finished;
      })
      .catch(() => undefined)
      .finally(() => (turning = false));
  };

  const filters = loadFilters(kind);
  /** The column whose label picker is open, if any. */
  let picking: string | null = null;
  const setFilter = (key: string, labels: string[]) => {
    if (labels.length) filters[key] = labels;
    else delete filters[key];
    saveFilters(kind, filters);
    render();
  };

  /** Toggles for every label on the board; the column shows cards with any of the ones picked. */
  const labelPicker = <T extends GhIssue | GhPull>(col: Column<T>, all: Map<string, string>, picked: string[]) => {
    const names = [...new Set([...all.keys(), ...picked])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const list = h('div.col-labels');
    for (const name of names) {
      const on = picked.includes(name);
      const n = col.items.filter((it) => it.labels.some((l) => l.name === name)).length;
      list.append(
        h(
          'button.label-pick',
          { type: 'button', 'aria-pressed': String(on), 'data-focus': `${col.key}:${name}`, title: `${n} in ${col.title.replace(/^\S+ /, '')}`, onclick: () => setFilter(col.key, on ? picked.filter((x) => x !== name) : [...picked, name]) },
          labelChip({ name, color: all.get(name) ?? '#dddddd' }),
          h('small', {}, String(n)),
        ),
      );
    }
    if (!names.length) list.append(h('small', {}, 'No labels on this board yet.'));
    const hint = picked.length ? 'Showing cards with any of these labels' : 'Pick labels to show only their cards';
    return h('div.col-filter', {}, list, h('div.col-filter-foot', {}, h('small', {}, hint), picked.length ? h('button.btn.small', { type: 'button', onclick: () => setFilter(col.key, []) }, 'Clear') : null));
  };

  /** A column of cards. Click its header to filter it by label. */
  const column = <T extends GhIssue | GhPull>(col: Column<T>, all: Map<string, string>, cardOf: (it: T, i: number) => HTMLElement) => {
    const picked = filters[col.key] ?? [];
    const matching = picked.length ? col.items.filter((it) => it.labels.some((l) => picked.includes(l.name))) : col.items;
    const shown = matching.slice(0, col.max);
    const ul = h('ul');
    shown.forEach((it, i) => ul.append(cardOf(it, i)));
    if (!shown.length) ul.append(h('li.empty', {}, picked.length ? 'Nothing here with those labels' : 'Nothing here'));
    const open = picking === col.key;
    const count = picked.length ? `${shown.length} / ${col.items.slice(0, col.max).length}` : String(shown.length);
    const head = h(
      'button.col-head',
      {
        type: 'button',
        'aria-expanded': String(open),
        'data-focus': col.key,
        title: picked.length ? `Only cards labelled ${picked.join(' or ')}. Click to change.` : 'Filter by label',
        onclick: () => {
          picking = open ? null : col.key;
          render();
        },
      },
      h('span', {}, col.title),
      h('span.col-count', {}, count, h('span.col-caret', { 'aria-hidden': 'true' }, open ? '▴' : '▾')),
    );
    const sectionEl = h('section.column', { class: picked.length ? 'filtered' : '' }, h('h4', {}, head));
    if (open) sectionEl.append(labelPicker(col, all, picked));
    else if (picked.length) {
      sectionEl.append(
        h(
          'div.col-active',
          {},
          ...picked.map((name) => labelChip({ name, color: all.get(name) ?? '#dddddd' })),
          h('button.col-clear', { type: 'button', 'aria-label': 'Clear label filter', title: 'Show every card', onclick: () => setFilter(col.key, []) }, '✕'),
        ),
      );
    }
    sectionEl.append(ul);
    return sectionEl;
  };

  const render = () => {
    el.classList.toggle('notes-mode', view === 'notes');
    if (view === 'todo' || view === 'notes') {
      const side = view === 'todo' ? (todo ??= mountTodoBoard(net)) : (notes ??= mountNotesPad(net));
      title.textContent = view === 'todo' ? '🔥 To Do' : '🗒️ Notes';
      el.setAttribute('aria-label', view === 'todo' ? 'To Do board' : 'Notes');
      tabs?.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
      status.hidden = refresh.hidden = warning.hidden = true;
      body.classList.toggle('todo-body', view === 'todo');
      body.classList.toggle('notes-body', view === 'notes');
      if (body.firstChild !== side.el || body.childNodes.length !== 1) body.replaceChildren(side.el);
      return;
    }
    if (kind === 'issues') {
      title.textContent = '📌 Issues';
      el.setAttribute('aria-label', 'Issues board');
      tabs?.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
      status.hidden = refresh.hidden = false;
      if (body.classList.contains('todo-body') || body.classList.contains('notes-body')) {
        body.classList.remove('todo-body', 'notes-body');
        body.replaceChildren();
      }
    }
    const st = kind === 'issues' ? store.issues : store.pulls;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
    if (kind === 'pulls') {
      // Every refresh rebuilds the board and its tally: keep the scroll, and keyboard focus on the same
      // tally chip, row, or button in that row.
      const active = document.activeElement;
      const focused = active instanceof HTMLElement && (body.contains(active) || tally.contains(active)) ? active : null;
      const focusId = focused?.dataset.focus;
      const focusRow = focused?.closest<HTMLElement>('[data-key]');
      const focusKey = focusRow?.dataset.key;
      const focusButton = focusRow && focused !== focusRow ? [...focusRow.querySelectorAll<HTMLElement>('button')].indexOf(focused!) : -1;
      const focusSection = focused?.closest('section')?.id;
      const { scrollTop } = body;
      renderPulls(body, tally, pullsView, net, actions, render, { filters, picking, toggle: (key) => { picking = picking === key ? null : key; render(); }, setFilter, picker: labelPicker });
      body.scrollTop = scrollTop;
      if (focused) {
        const same = focusId ? el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`) : null;
        const rowEl = focusKey ? body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null;
        const inRow = rowEl && focusButton >= 0 ? rowEl.querySelectorAll<HTMLElement>('button')[focusButton] ?? rowEl : rowEl;
        const target = same ?? inRow ?? (focusSection ? body.querySelector<HTMLElement>(`#${focusSection} h3 button:last-child`) : null);
        target?.focus({ preventScroll: true });
      }
      return;
    }
    // Every refresh rebuilds the columns, so note how far each was scrolled and put it back afterwards,
    // and keep focus on the header or label toggle it was on.
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    const { scrollLeft, scrollTop } = body;
    const active = document.activeElement;
    const focused = active && body.contains(active) ? active.getAttribute('data-focus') : null;
    body.replaceChildren();
    warning.hidden = !st.error;
    if (st.error) warning.textContent = `${st.items.length ? 'Some GitHub data may be out of date' : "Couldn't load from GitHub"}: ${st.error}`;
    if (st.error && !st.items.length) return;
    const all = boardLabels(st.items);
    for (const col of issueColumns(store.issues.items)) {
      body.append(
        column(col, all, (it, i) =>
          card(it, [repoChip(it), ...labelChips(it.labels), queueChip(it), it.assignees.length ? `👤 ${it.assignees.join(', ')}` : `by ${it.author}`, it.comments ? `💬 ${it.comments}` : '', timeAgo(it.updatedAt)], i, () => openIssue(it, net, actions), () => openLabels('issue', it, net)),
        ),
      );
    }
    body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    body.scrollLeft = scrollLeft;
    body.scrollTop = scrollTop;
    if (focused !== null) [...body.querySelectorAll<HTMLElement>('[data-focus]')].find((b) => b.dataset.focus === focused)?.focus();
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
      todo?.destroy();
      notes?.destroy();
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
  if (view === 'todo') todo?.focus();
  if (view === 'notes') notes?.focus();
}
