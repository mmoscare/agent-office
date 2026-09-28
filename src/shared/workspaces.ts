export interface WorkspaceBranch {
  /** Full ref, so a local branch and a remote branch with the same name stay distinct. */
  ref: string;
  name: string;
  remote: boolean;
}

/** A local Git checkout found inside a floor. Paths are relative to that floor. */
export interface WorkspaceRepository {
  path: string;
  name: string;
  branch?: string;
  branches?: WorkspaceBranch[];
  dirty: number;
  error?: string;
}

export interface WorkspaceRepositories {
  repositories: WorkspaceRepository[];
  truncated: boolean;
}

export interface WorkspaceRequest {
  repositories: string[];
  /** Selected starting refs keyed by repository path. Missing uses that checkout's current HEAD. */
  startRefs?: Record<string, string>;
  /** A new branch in each selected repo. Empty uses the worker's generated office/* branch. */
  branch?: string;
}

export interface RepositoryWorktree {
  repository: string;
  name: string;
  /** Worktree path relative to the floor, not to the source repository. */
  path: string;
  branch: string;
  base: string;
  from?: string;
  fromRef?: string;
  pr?: { number: number; url: string };
}

export interface WorkerWorkspace {
  /** Shared parent of this worker's worktrees, relative to the floor. */
  path: string;
  repositories: RepositoryWorktree[];
}
