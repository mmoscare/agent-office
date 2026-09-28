import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AUTHOR_REPO, PERSONAL_REPO, type AuthorUpdates } from '../shared/author-updates.js';
import { normalizeRepo, sameRepo } from '../shared/floors.js';

type Git = (dir: string, args: string[]) => Promise<string>;
const git: Git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, encoding: 'utf8', timeout: 45_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
    // Git's stderr can contain credential-bearing remote URLs. Keep errors useful but sanitized.
    if (err) reject(new Error(`Git ${args[0]} failed. Check the repository, network access and Git authentication on the server.`));
    else resolve(stdout.trim());
  });
});

/** One shared, bounded fetch per floor, regardless of how many browsers watch its board. */
export class AuthorUpdateMonitor {
  private cache = new Map<string, { at: number; state?: AuthorUpdates; pending?: Promise<AuthorUpdates> }>();
  constructor(private run: Git = git, private now = Date.now) {}

  async read(dir: string, refresh = false): Promise<AuthorUpdates> {
    const key = await realpath(dir);
    const previous = this.cache.get(key);
    if (previous?.pending) return previous.pending;
    // Manual checks still have a short cooldown to avoid fetch storms.
    if (previous?.state && this.now() - previous.at < (refresh ? 10_000 : 5 * 60_000)) return previous.state;
    const entry: { at: number; state?: AuthorUpdates; pending?: Promise<AuthorUpdates> } = { at: this.now() };
    this.cache.set(key, entry);
    entry.pending = this.check(key).then(state => {
      entry.state = state;
      entry.at = this.now();
      entry.pending = undefined;
      return state;
    });
    return entry.pending;
  }

  private async check(dir: string): Promise<AuthorUpdates> {
    const run = (args: string[]) => this.run(dir, args);
    const state: AuthorUpdates = { enabled: false };
    try {
      // Only the main checkout's own floor, never a portfolio parent, subdirectory or worker worktree.
      const top = await realpath(await run(['rev-parse', '--show-toplevel']));
      const common = await realpath(path.resolve(dir, await run(['rev-parse', '--git-common-dir'])));
      if (top !== dir || common !== await realpath(path.join(dir, '.git')).catch(() => '')) return state;
      if (!sameRepo(normalizeRepo(await run(['remote', 'get-url', 'origin'])), PERSONAL_REPO)) return state;
      state.enabled = true;
      state.dir = dir;
      if (!sameRepo(normalizeRepo(await run(['remote', 'get-url', 'upstream'])), AUTHOR_REPO)) {
        throw new Error(`Configure upstream to https://github.com/${AUTHOR_REPO}.git to check the author's updates.`);
      }
      // Inspect the actual personal branch, not whichever branch a worker happened to start from.
      const personal = await run(['rev-parse', '--verify', 'refs/heads/personal^{commit}']);
      const worktrees = await run(['worktree', 'list', '--porcelain', '-z']);
      for (const record of worktrees.split('\0\0')) {
        const fields = record.split('\0');
        if (!fields.includes('branch refs/heads/personal')) continue;
        state.personalDir = fields.find(f => f.startsWith('worktree '))?.slice(9);
      }
      if (state.personalDir) {
        state.merging = !!await this.run(state.personalDir, ['rev-parse', '--verify', 'MERGE_HEAD']).catch(() => '');
        state.conflicts = (await this.run(state.personalDir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      }
      // Update only the remote tracking ref; no checkout, branch move, merge, build or restart here.
      await run(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'upstream', 'refs/heads/main:refs/remotes/upstream/main']);
      const latest = await run(['rev-parse', '--verify', 'refs/remotes/upstream/main^{commit}']);
      // An unrelated/shallow history must not look like a safe update.
      await run(['merge-base', personal, latest]);
      state.latest = latest;
      state.behind = Number(await run(['rev-list', '--count', `${personal}..${latest}`]));
      state.changes = (await run(['log', '-20', '--format=%H%x00%s', `${personal}..${latest}`])).split('\n').filter(Boolean).map(line => {
        const [sha, subject] = line.split('\0');
        return { sha, subject };
      });
      state.checkedAt = this.now();
    } catch (err) {
      if (state.enabled) state.error = (err as Error).message;
    }
    return state;
  }
}

export const authorUpdates = new AuthorUpdateMonitor();
