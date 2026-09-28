// The Git board: the PR board's other side. Every Git repository on the floor, its branches, and
// for each branch what differs from its copy on GitHub, VS Code source-control style.

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'T' | '?';

/** One repository on the board's front: where it is and how its checked-out branch stands. */
export interface GitRepoSummary {
  /** Relative to the floor; '.' when the floor itself is the repository. */
  path: string;
  name: string;
  /** The checked-out branch; unset on a detached HEAD. */
  branch?: string;
  /** The GitHub-side branch it's compared with, e.g. origin/main; unset when it has none. */
  upstream?: string;
  /** Commits not on GitHub yet, and GitHub commits not here yet (as of the last fetch). */
  ahead: number;
  behind: number;
  /** Files with uncommitted changes, untracked ones included. */
  dirty: number;
  /** owner/name when origin is on GitHub. */
  github?: string;
  error?: string;
}

export interface GitRepoList {
  repos: GitRepoSummary[];
  /** The floor folder is itself one repository. */
  floorIsRepo: boolean;
  truncated: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  /** Its GitHub-side branch (origin/<name>), when there is one. */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Tracked a remote branch that has since been deleted. */
  gone?: boolean;
  /** Last commit. */
  date: string;
  subject: string;
}

export interface GitFileChange {
  path: string;
  /** The old name of a renamed file. */
  from?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Uncommitted list only: has changes in the index (VS Code's "Staged Changes"). */
  staged?: boolean;
  /** Uncommitted list only: has changes not added yet (VS Code's "Changes"). */
  unstaged?: boolean;
  /** GitHub list only: the checkout has uncommitted edits to it too. */
  uncommitted?: boolean;
}

export interface GitCommitLine {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitRepoDetail {
  path: string;
  name: string;
  github?: string;
  /** The branch shown. */
  branch: string;
  /** The branch checked out in the folder (unset on a detached HEAD). */
  current?: string;
  branches: GitBranchInfo[];
  /** What the GitHub list compares against. */
  compare: {
    /** e.g. origin/main; unset when there's nothing on GitHub to compare with. */
    ref?: string;
    /** The branch isn't on GitHub: `ref` is the default branch, compared from where they split. */
    unpublished?: boolean;
    note?: string;
  };
  /** Everything that differs from the GitHub copy: commits not pushed plus uncommitted edits. */
  githubFiles: GitFileChange[];
  /** What's not committed yet (only for the checked-out branch). */
  uncommitted: GitFileChange[];
  /** Commits here but not on GitHub, and on GitHub but not here. Newest first. */
  outgoing: GitCommitLine[];
  incoming: GitCommitLine[];
  ahead: number;
  behind: number;
  /** The branch GitHub treats as the default (origin/HEAD), e.g. main; pull requests target it. */
  defaultBranch?: string;
  /** When `git fetch` last brought this repository up to date from here, if it has. */
  fetchedAt?: number;
  more: number;
  error?: string;
}

export type GitDiffMode = 'github' | 'uncommitted';

export interface GitDiff {
  diff: string;
  truncated: boolean;
}

/**
 * The office's own code: the checkout it runs from, and whether what's running is the latest there
 * is. Unset when the office doesn't run from a Git checkout (an npm install).
 */
export interface OfficeStatus {
  /** The folder the office runs from. */
  dir: string;
  branch?: string;
  /** Its GitHub copy, e.g. origin/personal. */
  upstream?: string;
  /** owner/name of origin, when it's on GitHub. */
  github?: string;
  ahead: number;
  behind: number;
  /** Files with uncommitted changes there. */
  dirty: number;
  /** When its code last changed (a pull, a merge, a commit). */
  changedAt?: number;
  /** When it was last built. */
  builtAt?: number;
  /** When the running office started. */
  startedAt: number;
  /** What's left to do: pull the new code, build it, restart onto the build. */
  needs: { pull: boolean; build: boolean; restart: boolean };
  /** When GitHub was last fetched from there. */
  fetchedAt?: number;
  /** The GitHub commit it should be at (its upstream's), so a dismissed update bar comes back for the next one. */
  target?: string;
  /** Floors that are checkouts of the office's own repository, and how far behind GitHub each is. */
  floors?: { name: string; dir: string; behind: number; dirty: number }[];
  error?: string;
}
