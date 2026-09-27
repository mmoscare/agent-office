export interface RepositoryWorktree {
  repository: string;
  name: string;
  /** Worktree path relative to the floor, not to the source repository. */
  path: string;
  branch: string;
  base: string;
  from?: string;
  pr?: { number: number; url: string };
}

export interface WorkerWorkspace {
  /** Shared parent of this worker's worktrees, relative to the floor. */
  path: string;
  repositories: RepositoryWorktree[];
}
