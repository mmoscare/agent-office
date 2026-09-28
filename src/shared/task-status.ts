// What a finished queue task really left behind, for the queue board, the whiteboard and `office-queue list`.

import type { QueueTask } from './protocol.js';

/** Why a task that was running when the office went down counts as stopped (kept as its error, as before). */
export const RESTART_ERROR = 'The office restarted while it was running';

export interface TaskStatusView {
  /** e.g. "queued", "done", "done (exited)", "done — no PR (unshipped work)", "stopped by restart". */
  text: string;
  /** Show it in the warning colour: work may be sitting unseen. */
  warn: boolean;
}

/** "3 uncommitted files, 1 unpushed commit", or '' when there's nothing. */
export function unshippedText(u: { dirty: number; commits: number } | undefined): string {
  if (!u) return '';
  const parts: string[] = [];
  if (u.dirty) parts.push(`${u.dirty} uncommitted file${u.dirty === 1 ? '' : 's'}`);
  if (u.commits) parts.push(`${u.commits} unshipped commit${u.commits === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** The task was running when the office restarted (also true of tasks saved before this was tracked). */
export function stoppedByRestart(t: Pick<QueueTask, 'outcome' | 'error'>): boolean {
  return t.outcome === 'exited' && t.error === RESTART_ERROR;
}

/** Where a task stands, honestly: a finished task whose worktree still holds work without a PR says so. */
export function taskStatus(t: Pick<QueueTask, 'status' | 'outcome' | 'error' | 'pr' | 'unshipped'>): TaskStatusView {
  if (t.status !== 'done') return { text: t.status, warn: false };
  const work = !!t.unshipped && (t.unshipped.dirty > 0 || t.unshipped.commits > 0);
  const warning = t.pr ? 'work outside PR (unshipped work)' : 'no PR (unshipped work)';
  if (stoppedByRestart(t)) return { text: `stopped by restart${work ? ` — ${warning}` : ''}`, warn: true };
  const base = t.outcome && t.outcome !== 'done' ? `done (${t.outcome})` : 'done';
  return work ? { text: `${base} — ${warning}`, warn: true } : { text: base, warn: false };
}

/** The title of the queue task that recovers a branch's unshipped work; the board finds it on the queue by it. */
export function recoveryTitle(branch: string, repository?: string): string {
  // As the queue keeps it: titles are cut at 120 characters.
  return `Recover unshipped work from ${branch}${repository && repository !== '.' ? ` (${repository})` : ''}`.slice(0, 120);
}
