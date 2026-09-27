import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerBranch, WorkerInfo } from '../shared/protocol.js';

const exec = promisify(execFile);

/** Read HEAD from each worker checkout, not its source repo or saved creation branch. */
export async function workerBranches(root: string, worker: Pick<WorkerInfo, 'worktree' | 'workspace'>): Promise<WorkerBranch[]> {
  const repositories = worker.workspace
    ? worker.workspace.repositories.map(repo => ({ cwd: path.join(root, repo.path), repository: repo.repository }))
    : [{ cwd: worker.worktree ? path.join(root, worker.worktree.path) : root, repository: undefined }];
  return Promise.all(repositories.map(async ({ cwd, repository }) => {
    const result: WorkerBranch = repository === undefined ? {} : { repository };
    const opts = { cwd, encoding: 'utf8' as const, timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true };
    try {
      // symbolic-ref also works before a new repository's first commit.
      result.branch = (await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], opts)).stdout.trim() || undefined;
    } catch {
      try {
        result.commit = (await exec('git', ['rev-parse', '--short', 'HEAD'], opts)).stdout.trim() || undefined;
      } catch { /* Missing, unreadable, or non-Git directory: no branch to display. */ }
    }
    return result;
  }));
}
