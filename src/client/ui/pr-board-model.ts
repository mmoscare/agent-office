import type { GhPull, UnshippedItem } from '../../shared/protocol';

/**
 * What the Pull Requests board shows, worked out without the DOM (ui/boards.ts draws it, and the 3D
 * wall in world/boards.ts orders its notes by it): each PR's status, which section it goes in, and
 * the order within a section.
 */

/** Where a pull request stands, most urgent first (the order of PR_STATUS). */
export type PullStatusKey = 'conflict' | 'failing' | 'ready' | 'review' | 'changes' | 'running' | 'draft' | 'merged' | 'closed';

/** The board's sections, in reading order: what needs you, what's under way, what's finished. */
export type PullTier = 'needs-you' | 'in-progress' | 'done';

export interface PullStatus {
  key: PullStatusKey;
  tier: PullTier;
  icon: string;
  label: string;
  /** One line on why it's here, for the tooltip. */
  hint: string;
}

export const PR_STATUS: Record<PullStatusKey, PullStatus> = {
  conflict: { key: 'conflict', tier: 'needs-you', icon: '⚔️', label: 'Conflicts', hint: 'It conflicts with its base branch: resolve that before it can merge' },
  failing: { key: 'failing', tier: 'needs-you', icon: '🔴', label: 'Checks failing', hint: 'At least one check failed' },
  ready: { key: 'ready', tier: 'needs-you', icon: '✅', label: 'Ready to merge', hint: 'Approved, and its checks pass (or it has none)' },
  review: { key: 'review', tier: 'needs-you', icon: '👀', label: 'Needs review', hint: 'Waiting for your review' },
  changes: { key: 'changes', tier: 'in-progress', icon: '🛠', label: 'Changes requested', hint: 'A review asked for changes' },
  running: { key: 'running', tier: 'in-progress', icon: '🟡', label: 'Checks running', hint: 'Its checks are still running' },
  draft: { key: 'draft', tier: 'in-progress', icon: '✏️', label: 'Draft', hint: 'Still a draft' },
  merged: { key: 'merged', tier: 'done', icon: '🎉', label: 'Merged', hint: 'Merged' },
  closed: { key: 'closed', tier: 'done', icon: '🗑️', label: 'Closed', hint: 'Closed without merging' },
};

const RANK = Object.fromEntries(Object.keys(PR_STATUS).map((k, i) => [k, i])) as Record<PullStatusKey, number>;

/** A PR's status. A draft stays a draft whatever its checks say; conflicts beat failing checks, which beat the review. */
export function pullStatus(p: Pick<GhPull, 'state' | 'isDraft' | 'reviewDecision' | 'checks' | 'mergeable'>): PullStatus {
  if (p.state === 'MERGED') return PR_STATUS.merged;
  if (p.state !== 'OPEN') return PR_STATUS.closed;
  if (p.isDraft) return PR_STATUS.draft;
  if (p.mergeable === 'CONFLICTING') return PR_STATUS.conflict;
  if (p.checks === 'fail') return PR_STATUS.failing;
  if (p.reviewDecision === 'CHANGES_REQUESTED') return PR_STATUS.changes;
  if (p.checks === 'pending') return PR_STATUS.running;
  return p.reviewDecision === 'APPROVED' ? PR_STATUS.ready : PR_STATUS.review;
}

/** Most urgent first; within a status, the most recently updated first. */
export function comparePulls(a: GhPull, b: GhPull): number {
  return RANK[pullStatus(a).key] - RANK[pullStatus(b).key] || b.updatedAt.localeCompare(a.updatedAt);
}

export interface PullSections {
  needsYou: GhPull[];
  inProgress: GhPull[];
  /** Merged and closed, newest first, at most `doneLimit`. */
  done: GhPull[];
  /** How many finished ones there are in all (done may be cut short). */
  doneTotal: number;
}

export function pullSections(items: GhPull[], doneLimit = 30): PullSections {
  const sorted = [...items].sort(comparePulls);
  const tier = (t: PullTier) => sorted.filter((p) => pullStatus(p).tier === t);
  const done = tier('done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { needsYou: tier('needs-you'), inProgress: tier('in-progress'), done: done.slice(0, doneLimit), doneTotal: done.length };
}

export interface RepoGroup<T> {
  /** The repository ('' when an item doesn't say, as on a floor that's one repository). */
  repo: string;
  items: T[];
}

/**
 * Items grouped by repository, keeping their order within each and ordering the groups by where
 * their first item came (so the repository with the most urgent item leads).
 */
export function groupByRepo<T>(items: T[], repoOf: (it: T) => string | undefined): RepoGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const r = repoOf(it) ?? '';
    const g = groups.get(r);
    if (g) g.push(it);
    else groups.set(r, [it]);
  }
  return [...groups].map(([repo, items]) => ({ repo, items }));
}

/** Whether a floor's PRs or unshipped branches come from more than one repository, so the board should say which. */
export function manyRepos(repos: Iterable<string | undefined>): boolean {
  const seen = new Set<string>();
  for (const r of repos) if (r) seen.add(r.toLowerCase());
  return seen.size > 1;
}

/** Why GitHub didn't answer, from gh's error text, so the board can say what to do about it. */
export type GhTrouble = 'rate-limit' | 'setup' | 'offline' | 'other';

export function ghTrouble(error: string): GhTrouble {
  if (/rate.?limit|abuse detection/i.test(error)) return 'rate-limit';
  if (/auth login|not logged|authentication|HTTP 401|bad credentials|ENOENT|not recognized|command not found/i.test(error)) return 'setup';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|could not resolve host|network|timed? ?out/i.test(error)) return 'offline';
  return 'other';
}

/**
 * The Unshipped work rows in the order they're worth acting on: ones you can queue a PR for first,
 * then ones with a recovery already queued or running, then ones whose worker is still mid-turn;
 * within those, the most recently touched first.
 */
export function sortUnshipped(items: UnshippedItem[], hasRecovery: (it: UnshippedItem) => boolean): UnshippedItem[] {
  const rank = (it: UnshippedItem) => (it.worker === 'active' ? 2 : hasRecovery(it) ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
}
