import type { UnshippedItem } from '../../shared/protocol';
import { h, timeAgo } from './dom';
import { diffStat, emptyRow, pill, repoHeading, row, section, skeletonRows } from './pr-board-parts';
import { groupByRepo, showsRepo, sortUnshipped } from './pr-board-model';

/**
 * The Pull Requests board's 🧳 Unshipped work section: office branches holding work that no open or
 * merged PR carries (found by server/unshipped.ts). It only draws what it's given, so the board
 * passes plain data and callbacks.
 */
export interface UnshippedListProps {
  items: UnshippedItem[];
  /** 0 until the first scan comes back. */
  scannedAt: number;
  scanning: boolean;
  error?: string;
  /** Why some PR statuses are unknown (GitHub rate-limited or offline). */
  prNote?: string;
  /** Set when GitHub's rate limit is why, instead of gh's words in prNote. */
  prLimit?: { secondary: boolean; resetAt?: number };
  /** A recovery task already on the queue for it. */
  recovery(it: UnshippedItem): { running: boolean; workerName?: string } | undefined;
  /** Its worker's colour, while that worker is still in the office. */
  workerColor(it: UnshippedItem): string | undefined;
  rescan(): void;
  /** Queue a fresh worker to turn it into a PR. */
  recover(it: UnshippedItem): void;
  /** Walk to its worker's desk (only offered while the worker is there). */
  goToWorker?(it: UnshippedItem): void;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const WORKER_STATE: Record<UnshippedItem['worker'], string> = { active: 'working', idle: 'at its desk', gone: 'gone home' };

export function unshippedSection(p: UnshippedListProps): HTMLElement {
  const items = sortUnshipped(p.items, (it) => !!p.recovery(it));
  const rows: Node[] = [];
  if (p.error) rows.push(h('li.prb-note.bad', {}, `⚠️ Couldn't look through the branches: ${p.error}`));
  if (p.prLimit) rows.push(h('li.prb-note', {}, limitNote(p.prLimit)));
  else if (p.prNote) rows.push(h('li.prb-note', {}, `❔ GitHub couldn't be asked about some branches (${p.prNote}), so they may have a PR after all. Showing what's on disk.`));
  const many = showsRepo(items.map((it) => it.repository));
  for (const g of groupByRepo(items, (it) => (many ? it.repository : undefined))) {
    if (many) rows.push(repoHeading(g.repo || 'this folder', g.items.length));
    for (const it of g.items) rows.push(unshippedRow(it, p));
  }
  if (!items.length && !p.error) rows.push(...(p.scannedAt ? [emptyRow('🎉', 'Every branch is shipped', 'No office branch holds work without a PR.')] : skeletonRows(1)));
  const rescan = h('button.btn.prb-tool', { type: 'button', title: 'Look through the branches again', 'aria-label': 'Rescan branches', disabled: p.scanning, onclick: () => p.rescan() }, p.scanning ? '⏳' : '🔄');
  return section({ id: 'prb-unshipped', tone: 'unshipped', icon: '🧳', title: 'Unshipped work', count: items.length, hint: 'on a branch, no PR yet', tools: [rescan], rows });
}

/** Why PR statuses are unknown when it's GitHub's rate limit, in plain words rather than gh's. */
export function limitNote(limit: { secondary: boolean; resetAt?: number }): string {
  const why = limit.secondary ? 'GitHub asked the office to slow down for a few minutes' : "The GitHub account's shared hourly API quota ran out";
  const when = limit.resetAt ? ` It ${limit.secondary ? 'lifts' : 'resets'} at ${clock(limit.resetAt)}.` : '';
  return `❔ ${why}, so some branches may have a PR after all.${when} Showing what's on disk.`;
}

function unshippedRow(it: UnshippedItem, p: UnshippedListProps): HTMLElement {
  const recovery = p.recovery(it);
  const color = p.workerColor(it);
  const unknown = it.pr === 'unknown';
  const action =
    it.worker === 'active'
      ? h('span.prb-state', { title: 'Its worker is still running; wait for it to finish' }, '🤖 still working')
      : recovery
        ? h('span.prb-state', {}, recovery.running ? `🤖 recovery running${recovery.workerName ? ` · ${recovery.workerName}` : ''}` : '📋 recovery queued')
        : h('button.btn.primary.prb-act', {
            type: 'button',
            title: `Queue a task: a fresh worker copies this work onto the latest ${it.base ?? 'base branch'} and opens a pull request, leaving this worktree as it is`,
            onclick: () => p.recover(it),
          }, '📋 Queue a PR');
  const go = p.goToWorker && color && it.worker !== 'gone' ? () => p.goToWorker?.(it) : undefined;
  return row({
    key: `u:${it.key}`,
    st: unknown ? 'unknown' : 'unshipped',
    pill: unknown ? pill('unknown', '❔', 'PR unknown', "GitHub couldn't be asked, so it may have a PR after all") : pill('unshipped', '🧳', 'No PR', 'No open or merged pull request carries this work'),
    title: it.taskTitle ?? 'No linked task',
    label: `Unshipped work on ${it.branch}${go ? '. Enter walks to its desk' : ''}`,
    when: it.modifiedAt ? timeAgo(it.modifiedAt) : undefined,
    meta: [
      h('span.prb-branch', { title: it.path ? `Worktree: ${it.path}` : 'Its worktree folder is gone; only the branch is left' }, `🌿 ${it.branch}`, h('span.prb-base', {}, ` → ${it.base ?? 'base'}`)),
      h('span.prb-worker', { style: color ? `--dot:${color}` : undefined, class: color ? '' : 'gone' }, `${it.workerName ?? 'unknown worker'} · ${WORKER_STATE[it.worker]}`),
      it.dirty ? h('span.prb-warn', {}, `📝 ${plural(it.dirty, 'uncommitted file')}`) : '',
      it.commits ? h('span.prb-warn', {}, `📦 ${plural(it.commits, 'commit')}`) : '',
      it.unpushed ? h('span.prb-warn', {}, `⬆ ${it.unpushed} unpushed`) : '',
      it.added || it.deleted ? diffStat(it.added, it.deleted) : '',
    ],
    action,
    onOpen: go,
  });
}
