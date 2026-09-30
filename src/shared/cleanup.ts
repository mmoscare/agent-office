// The cleanup screen (🧹 on the Git board, and the calendar's first-of-the-month reminder): pick a
// floor, then one of its repositories, then which leftover branches and worktrees to delete. The
// server (server/cleanup.ts) reads what each one holds; these are the rules both sides use for what
// starts ticked, what can't be deleted at all, and what deleting would lose.

/**
 * safe: deleting it loses nothing. work: it holds uncommitted changes or commits no remote has.
 * worker: a live worker's (send the worker home instead). protected: never deleted from here.
 * unknown: git couldn't say what it holds, so it stays.
 */
export type CleanupVerdictKind = 'safe' | 'work' | 'worker' | 'protected' | 'unknown';

export interface CleanupVerdict {
  kind: CleanupVerdictKind;
  /** Said for a person: "safe", "2 uncommitted changes, 1 unpushed commit", "Gizmo's (desk-5)…". */
  text: string;
}

export interface CleanupWorktree {
  /** Relative to the floor with forward slashes when it's inside the floor; absolute otherwise. */
  path: string;
  /** The folder is still on disk (git can list one whose folder is gone: `git worktree prune` forgets it). */
  exists: boolean;
  /** A folder under .agent-office/worktrees that git no longer lists: a half-deleted worktree. */
  stray?: boolean;
  /** Registered outside .agent-office/worktrees, e.g. a scratch "baseline" worktree in %TEMP%. */
  external?: boolean;
  detached?: boolean;
  /** A multi-repository desk's worktree: the desk (its folder under .agent-office/workspaces) and every repository it spans. */
  desk?: { name: string; repositories: string[] };
}

export interface CleanupPr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

/** What deleting each part would lose, one line per kind of loss; empty when nothing. */
export interface CleanupLoss {
  worktree: string[];
  branch: string[];
  remote: string[];
}

/** One branch (local, on origin, or both) with its worktree, or a worktree that has no branch. */
export interface CleanupItem {
  /** Names it to the server: the branch, or the worktree's path when it has none. */
  id: string;
  branch?: string;
  /** The branch exists here, and on origin (as of the last fetch). */
  local: boolean;
  remote: boolean;
  worktree?: CleanupWorktree;
  /** Its pull request on origin's GitHub repository, when it has one (see CleanupScan.prs). */
  pr?: CleanupPr;
  /** Its last commit, ISO 8601. */
  date?: string;
  verdict: CleanupVerdict;
  loses: CleanupLoss;
  /** Deleting origin's copy is offered: its PR is merged or closed. */
  remoteDeletable: boolean;
  /** Why origin's copy isn't offered, when it has one. */
  remoteWhy?: string;
  /** Pinned to "always keep" in this repository. */
  pinned: boolean;
  /** A snapshot of what was seen; the server refuses to delete anything that changed since. */
  token: string;
}

export interface CleanupScan {
  /** The repository, relative to the floor ('.' when the floor is the repository). */
  repo: string;
  name: string;
  /** owner/name of origin, when it's on GitHub. */
  github?: string;
  /** The branch the main checkout has checked out. */
  current?: string;
  defaultBranch?: string;
  /** 'ok': PRs were read; 'none': origin isn't on GitHub, so there are none; 'unknown': GitHub couldn't be asked (prError says why). */
  prs: 'ok' | 'none' | 'unknown';
  prError?: string;
  /** When origin was last fetched from here. */
  fetchedAt?: number;
  items: CleanupItem[];
}

/** What to delete of one item. */
export interface CleanupChoice {
  id: string;
  worktree?: boolean;
  branch?: boolean;
  remote?: boolean;
  /** Delete it even though it holds work: the owner ticked the box that says what would be lost. */
  force?: boolean;
  /** The item's token when it was shown. */
  token: string;
}

export interface CleanupStep {
  id: string;
  what: 'worktree' | 'branch' | 'remote';
  /** "Remove the worktree folder .agent-office/worktrees/bolt-2410". */
  label: string;
  /** Set once it ran (never on a dry run). */
  ok?: boolean;
  error?: string;
}

export interface CleanupRun {
  dryRun: boolean;
  steps: CleanupStep[];
  /** Choices refused before anything ran, and why. */
  refused: { id: string; why: string }[];
}

/** Items that can't be ticked at all: a live worker's, protected, or unreadable. */
export function cleanupLocked(it: CleanupItem): boolean {
  return it.verdict.kind === 'worker' || it.verdict.kind === 'protected' || it.verdict.kind === 'unknown';
}

/** Git won't delete a branch while a worktree has it checked out, so deleting the branch takes the worktree too. */
export function branchNeedsWorktree(it: CleanupItem): boolean {
  return !!it.worktree && !it.worktree.stray && it.worktree.exists && !it.worktree.detached;
}

/**
 * What starts ticked: safe leftovers, worktree and local branch both. Anything holding work, with an
 * open PR, a live worker's, protected or pinned starts unticked, and so does everything when GitHub
 * couldn't say which branches have open PRs. Origin's copy is never ticked to begin with.
 */
export function defaultChoice(it: CleanupItem, prs: CleanupScan['prs']): CleanupChoice {
  const on = it.verdict.kind === 'safe' && !it.pinned && prs !== 'unknown' && it.pr?.state !== 'OPEN';
  return { id: it.id, worktree: on && !!it.worktree, branch: on && it.local, remote: false, force: false, token: it.token };
}

/** What the ticked parts would lose, said for a person. */
export function cleanupLosses(it: CleanupItem, c: Pick<CleanupChoice, 'worktree' | 'branch' | 'remote'>): string[] {
  return [...(c.worktree ? it.loses.worktree : []), ...(c.branch ? it.loses.branch : []), ...(c.remote ? it.loses.remote : [])];
}
