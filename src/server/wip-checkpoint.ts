import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { gitError } from './worktrees.js';

const execFileP = promisify(execFile);

/** How long the office waits, all worktrees together, to save workers' uncommitted work as it goes down. */
export const CHECKPOINT_DEADLINE_MS = 5000;
/** A push that takes longer than this is given up on: the commit is safe locally either way. */
const PUSH_TIMEOUT_MS = 4000;
const GIT_TIMEOUT_MS = 3000;
const ABORT_GRACE_MS = 250;

export interface CheckpointTarget {
  /** Absolute path of a worker's worktree. */
  dir: string;
  /** The branch the office made for it, when HEAD doesn't say (detached). */
  branch: string;
}

export interface CheckpointResult {
  dir: string;
  branch: string;
  /** The WIP commit made, when there was uncommitted work. */
  hash?: string;
  pushed?: boolean;
  /** Committing failed (or the deadline passed first). */
  error?: string;
  /** The push failed: logged, never fatal. */
  pushError?: string;
}

export interface CheckpointOptions {
  deadlineMs?: number;
  pushTimeoutMs?: number;
  now?: Date;
  log?: (line: string) => void;
}

/**
 * Commits whatever each worktree holds uncommitted as a WIP checkpoint on its branch, and pushes
 * branches with unpushed commits to origin. All at once, and never past the deadline: the office is
 * going down, and a slow push or a stuck hook must not keep it from closing.
 */
export async function checkpointWorktrees(targets: CheckpointTarget[], opts: CheckpointOptions = {}): Promise<CheckpointResult[]> {
  const deadlineMs = opts.deadlineMs ?? CHECKPOINT_DEADLINE_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const abort = new AbortController();
  const results = targets.map((t): CheckpointResult => ({ dir: t.dir, branch: t.branch }));
  const work = Promise.all(targets.map((t, i) => checkpointOne(t, results[i], abort.signal, opts)));
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), deadlineMs);
  });
  const outcome = await Promise.race([work, late]);
  clearTimeout(timer);
  if (outcome === 'late') {
    // Stop whatever git is still doing: a half-finished commit leaves only an index.lock behind.
    abort.abort();
    // A moment for the killed git processes to report back, so each result says where it stopped.
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS))]);
    for (const r of results) if (!r.hash && !r.error) r.error = 'ran out of time';
  }
  for (const r of results) {
    if (r.hash) log(`  saved uncommitted work in ${r.dir} as WIP commit ${r.hash.slice(0, 12)} on ${r.branch}${r.pushed ? ' (pushed)' : ''}`);
    if (r.error) log(`  couldn't save uncommitted work in ${r.dir}: ${r.error}`);
    if (r.pushError) log(`  couldn't push ${r.branch} from ${r.dir}: ${r.pushError}`);
  }
  return results;
}

async function checkpointOne(t: CheckpointTarget, r: CheckpointResult, signal: AbortSignal, opts: CheckpointOptions) {
  // Never prompt for credentials or wait on a credential manager's window while the office goes down.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const git = async (args: string[], timeout = GIT_TIMEOUT_MS) => {
    const { stdout } = await execFileP('git', args, { cwd: t.dir, env, encoding: 'utf8', timeout, signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  };
  try {
    if (!existsSync(t.dir)) return;
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    if (head !== 'HEAD') r.branch = head;
    if (await git(['status', '--porcelain'])) {
      // `add -A` leaves out what .gitignore ignores. No hooks: a slow pre-commit mustn't eat the deadline.
      await git(['add', '-A']);
      await git(['commit', '--no-verify', '-m', `WIP checkpoint: office restart ${(opts.now ?? new Date()).toISOString()}`]);
      r.hash = await git(['rev-parse', 'HEAD']);
    }
  } catch (err) {
    r.error = signal.aborted ? 'ran out of time' : why(err);
    return;
  }
  if (r.branch === 'HEAD' || signal.aborted) return;
  try {
    const hasOrigin = await git(['remote', 'get-url', 'origin']).then(() => true, () => false);
    if (!hasOrigin) return;
    const unpushed = Number(await git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']));
    if (!unpushed) return;
    await git(['push', '-u', 'origin', r.branch], opts.pushTimeoutMs ?? PUSH_TIMEOUT_MS);
    r.pushed = true;
  } catch (err) {
    r.pushError = signal.aborted ? 'ran out of time' : why(err);
  }
}

function why(err: unknown): string {
  return (err as { killed?: boolean }).killed ? 'timed out' : gitError(err);
}
