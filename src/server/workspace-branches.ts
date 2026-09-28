import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceBranch } from '../shared/workspaces.js';

const exec = promisify(execFile);
const FORMAT = '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)';

function records(output: string) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [ref, commit, type, symbolic] = line.trim().split('\0');
    return { ref, commit, type, symbolic };
  }).filter(r => r.type === 'commit' && !r.symbolic);
}

/** Local refs only: this never fetches, switches a checkout, or contacts GitHub. */
export async function workspaceBranches(dir: string): Promise<WorkspaceBranch[]> {
  const { stdout } = await exec('git', ['for-each-ref', FORMAT, 'refs/heads/', 'refs/remotes/'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  return records(stdout).map(r => ({
    ref: r.ref,
    name: r.ref.replace(/^refs\/(heads|remotes)\//, ''),
    remote: r.ref.startsWith('refs/remotes/'),
  }));
}

/** Resolve an exact branch to a commit before any worktrees are created. No revision expressions. */
export function workspaceStart(dir: string, ref: string): { base: string; from: string; fromRef: string } {
  if (typeof ref !== 'string' || ref.length > 1024 || !/^refs\/(heads\/[^/]|remotes\/[^/]+\/[^/])/.test(ref)) {
    throw new Error('Choose a local or remote starting branch from the list');
  }
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, windowsHide: true,
  }).trim();
  let commit: string | undefined;
  try {
    git(['check-ref-format', ref]);
    commit = records(git(['for-each-ref', FORMAT, ref])).find(r => r.ref === ref)?.commit;
  } catch { /* Report a stale or invalid selection without falling back to HEAD. */ }
  if (!commit) throw new Error(`Starting branch ${ref.replace(/^refs\/(heads|remotes)\//, '')} is unavailable. Reopen the branch picker.`);
  let from = ref.replace(/^refs\/(heads|remotes)\//, '');
  if (ref.startsWith('refs/remotes/')) {
    const remote = git(['remote']).split('\n').filter(Boolean).sort((a, b) => b.length - a.length).find(r => from.startsWith(`${r}/`));
    from = from.slice(remote ? remote.length + 1 : from.indexOf('/') + 1);
  }
  return { base: commit, from, fromRef: ref };
}
