import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { floorRepository, workspaceRepositories } from './workspaces.js';
import { officeRoot, withGitRepository } from './git-board.js';
import { pushAdvice, type PushPreview, type PushTarget, type PushTargets } from '../shared/push.js';

/** Errors contain no raw Git output: remote URLs can contain credentials. */
async function git(dir: string, args: string[], optional = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: args[0] === 'push' ? 180_000 : 60_000,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => {
      if (!err) resolve(out.trim());
      else if (optional && typeof err.code === 'number' && !err.killed) resolve('');
      else reject(new Error(args[0] === 'push' ? 'Push failed. Check your remote access, then check again. No force push was attempted.' : `Could not ${args[0] === 'fetch' || args[0] === 'ls-remote' ? 'check the remote; check your connection and Git login' : 'read this repository'}.`));
    });
  });
}
function label(url: string): string {
  try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return url.replace(/^[^/@\s]+@(?=[^/]+:)/, ''); }
}
const sameDir = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

function targetDir(floor: string, id: string, app: string | undefined): string {
  if (id === 'office' && app) return floorRepository(app, '.');
  if (id.startsWith('floor:')) return floorRepository(floor, id.slice(6));
  throw new Error('Choose a repository from this floor or the running office.');
}
interface Snapshot { target: PushTarget; head: string; remote: string; remoteHead: string }
async function snapshot(dir: string, id: string, fresh: boolean): Promise<Snapshot> {
  const [branch, head, remote, pushUrls, dirty] = await Promise.all([
    git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], true), git(dir, ['rev-parse', '--verify', 'HEAD'], true),
    git(dir, ['remote', 'get-url', 'origin'], true), git(dir, ['remote', 'get-url', '--push', '--all', 'origin'], true),
    git(dir, ['status', '--porcelain=v1', '-unormal']),
  ]);
  const target: PushTarget = { id, name: id === 'office' ? 'Agent Office app' : path.basename(dir), dir, kind: id === 'office' ? 'office' : 'floor', branch: branch || undefined,
    ahead: 0, behind: 0, dirty: dirty.split('\n').filter(Boolean).length, published: false, hasCommits: !!head };
  let remoteHead = '';
  if (remote) {
    target.destination = `${label(pushUrls.split('\n')[0] || remote)}${branch ? ` · ${branch}` : ''}`;
    if (pushUrls !== remote) target.error = 'Origin has separate or multiple push destinations. Review that remote configuration before using Push here.';
  }
  if (branch && head && remote && !target.error) {
    const ref = `refs/heads/${branch}`;
    if (fresh) {
      const result = await git(dir, ['ls-remote', '--heads', 'origin', ref]);
      remoteHead = result.split(/\s/)[0] || '';
      if (remoteHead) {
        await git(dir, ['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:refs/remotes/origin/${branch}`]);
        remoteHead = await git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
      }
    } else remoteHead = await git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], true);
    target.published = !!remoteHead;
    if (remoteHead) {
      const [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', `${head}...${remoteHead}`])).split(/\s+/).map(Number);
      target.ahead = ahead; target.behind = behind;
    } else target.ahead = Number(await git(dir, ['rev-list', '--count', head]));
  }
  return { target, head, remote, remoteHead };
}

/** Cheap local inspection for a reminder. A preview always checks the remote before recommending a push. */
export async function pushTargets(floor: string, app = officeRoot()): Promise<PushTargets> {
  const found = await workspaceRepositories(floor);
  const locations = found.repositories.map(r => ({ id: `floor:${r.path}`, dir: floorRepository(floor, r.path) }));
  if (app) {
    try { const dir = floorRepository(app, '.'); if (!locations.some(t => sameDir(t.dir, dir))) locations.push({ id: 'office', dir }); }
    catch { /* Packaged installations have no app checkout. */ }
  }
  const targets: PushTarget[] = [];
  // Batches keep large multi-repository floors from launching too many Git processes at once.
  for (let i = 0; i < locations.length; i += 4) {
    targets.push(...await Promise.all(locations.slice(i, i + 4).map(async ({ id, dir }) => {
      try { return (await snapshot(dir, id, false)).target; }
      catch (err) { return { id, name: path.basename(dir), dir, kind: id === 'office' ? 'office' as const : 'floor' as const, ahead: 0, behind: 0, dirty: 0, published: false, hasCommits: false, error: (err as Error).message }; }
    })));
  }
  return { targets, truncated: found.truncated };
}
const reviews = new Map<string, { floor: string; id: string; dir: string; snap: Snapshot; at: number }>();
const REVIEW_MS = 10 * 60_000;

export async function previewPush(floor: string, id: string, app = officeRoot()): Promise<PushPreview> {
  const dir = targetDir(floor, id, app);
  const s = await snapshot(dir, id, true);
  const commits = s.target.ahead ? (await git(dir, ['log', '-15', '--format=%h%x09%s', s.remoteHead ? `${s.remoteHead}..${s.head}` : s.head])).split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  }) : [];
  const checkedAt = Date.now();
  let token: string | undefined;
  for (const [key, review] of reviews) if (checkedAt - review.at > REVIEW_MS) reviews.delete(key);
  if (pushAdvice(s.target).ready) {
    if (reviews.size >= 200) reviews.delete(reviews.keys().next().value!);
    token = randomUUID(); reviews.set(token, { floor, id, dir, snap: s, at: checkedAt });
  }
  return { target: s.target, commits, token, checkedAt };
}

export async function pushReviewed(floor: string, id: string, token: string, app = officeRoot()): Promise<{ branch: string; count: number } | string> {
  const review = reviews.get(token);
  if (!review || !sameDir(review.floor, floor) || review.id !== id || Date.now() - review.at > REVIEW_MS) return 'Check this repository again before pushing.';
  const dir = targetDir(floor, id, app);
  if (!sameDir(dir, review.dir)) return 'The checkout changed. Check again before pushing.';
  return withGitRepository(dir, '.', 'pushing', async lockedDir => {
    const before = review.snap;
    const now = await snapshot(lockedDir, id, true);
    if (now.head !== before.head || now.target.branch !== before.target.branch || now.remote !== before.remote || now.remoteHead !== before.remoteHead || !pushAdvice(now.target).ready) {
      reviews.delete(token);
      throw new Error('The branch, commits or remote changed since your review. Check again before pushing.');
    }
    // Push precisely the reviewed commit. New commits made concurrently are never uploaded unseen.
    await git(lockedDir, ['push', 'origin', `${before.head}:refs/heads/${before.target.branch}`]);
    // Match the ordinary Push flow for new branches without changing an existing upstream.
    if (!await git(lockedDir, ['for-each-ref', '--format=%(upstream)', `refs/heads/${before.target.branch}`])) {
      await git(lockedDir, ['branch', `--set-upstream-to=origin/${before.target.branch}`, before.target.branch!], true);
    }
    reviews.delete(token);
    return { branch: before.target.branch!, count: before.target.ahead };
  });
}
