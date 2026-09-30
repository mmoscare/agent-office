import { execFile } from 'node:child_process';
import { normalizeRepo } from '../shared/floors.js';
import { workspaceGitHubRepo } from './workspaces.js';

// A branch's pull requests over GitHub's REST API. The boards' lists use GraphQL, whose hourly quota
// every client signed in to the account shares and often runs dry; REST has a separate 5,000/hour
// quota, so "does this branch have a PR?" still gets an answer then. The repository is always named
// explicitly (the checkout's origin, or a workspace's repository): gh's {owner}/{repo} placeholders
// can resolve to another remote, such as a fork's upstream.

/** gh, as github.ts runs it: resolves to stdout; a failure's Error may carry `stdout` (gh api -i's headers). */
type Query = (args: string[], cwd: string, timeout?: number) => Promise<string>;

/** A pull request as the office's callers know it from `gh pr list --json`. */
export interface BranchPull {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  headRefOid?: string;
}

/** Why GitHub refused: its hourly quota ran out, or a secondary (burst) limit. `resetAt`: when to ask again (ms), when GitHub said. */
export interface RateLimit {
  secondary: boolean;
  resetAt?: number;
}

const RATE_LIMIT = /rate limit|abuse detection/i;

interface Repo {
  host?: string;
  owner: string;
  name: string;
}

/** owner/name, or host/owner/name as workspaceGitHubRepo writes it. */
function parseRepo(repository: string): Repo | undefined {
  const parts = repository.split('/');
  const host = parts.length === 3 ? parts.shift()!.toLowerCase() : undefined;
  const repo = normalizeRepo(parts.join('/'));
  if (!repo || parts.length !== 2) return undefined;
  const [owner, name] = repo.split('/');
  return { host: host === 'github.com' ? undefined : host, owner, name };
}

function originUrl(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout.trim())));
}

/** The repository to ask: `repository` when given, else the checkout's origin remote. */
async function repoOf(cwd: string, repository?: string): Promise<Repo> {
  let named = repository;
  if (!named) {
    const url = await originUrl(cwd);
    try {
      named = url && (normalizeRepo(url) ?? workspaceGitHubRepo(url));
    } catch {
      named = undefined;
    }
  }
  const repo = named ? parseRepo(named) : undefined;
  if (!repo) throw new Error(repository ? `${repository} isn't a GitHub repository` : "This checkout's origin remote isn't on GitHub");
  return repo;
}

const hostArgs = (r: Repo) => (r.host ? ['--hostname', r.host] : []);

/** gh api -i's output: the status line and headers (names lowercased), then the body. Plain JSON is all body. */
function splitResponse(out: string): { status: number; headers: Map<string, string>; body: string } {
  const headers = new Map<string, string>();
  if (!out.startsWith('HTTP/')) return { status: 0, headers, body: out };
  const end = /\r?\n\r?\n/.exec(out);
  const [statusLine, ...lines] = (end ? out.slice(0, end.index) : out).split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { status: Number(statusLine.split(' ')[1]) || 0, headers, body: end ? out.slice(end.index + end[0].length) : '' };
}

/** Whether a gh failure was GitHub's rate limit, and when it lifts (from `gh api -i`'s headers, when the error carries them). */
export function rateLimitOf(err: unknown, now = Date.now()): RateLimit | undefined {
  const message = (err as Error)?.message ?? '';
  const { status, headers } = splitResponse(String((err as { stdout?: unknown })?.stdout ?? ''));
  const exhausted = (status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0';
  if (!RATE_LIMIT.test(message) && !exhausted) return undefined;
  const secondary = /secondary|abuse/i.test(message) && !exhausted;
  const retryAfter = Number(headers.get('retry-after'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  const resetAt = retryAfter > 0 ? now + retryAfter * 1000 : exhausted && reset > 0 ? reset * 1000 : undefined;
  return { secondary, resetAt };
}

/** The REST path listing `branch`'s pull requests in `repo`: the head is owner:branch, the branch encoded (office branches hold a "/"). */
export function branchPullsPath(repo: { owner: string; name: string }, branch: string, state: 'all' | 'open' = 'all'): string {
  return `repos/${repo.owner}/${repo.name}/pulls?state=${state}&head=${repo.owner}:${encodeURIComponent(branch)}&per_page=100`;
}

/**
 * `branch`'s pull requests, newest first, over REST. `repository` is owner/name or host/owner/name;
 * without it, the checkout's origin. Rejects when GitHub can't be asked; rateLimitOf() says whether
 * that was its rate limit.
 */
export async function branchPulls(branch: string, cwd: string, query: Query, repository?: string, state: 'all' | 'open' = 'all'): Promise<BranchPull[]> {
  const repo = await repoOf(cwd, repository);
  const { body } = splitResponse(await query(['api', '-i', ...hostArgs(repo), branchPullsPath(repo, branch, state)], cwd));
  return (JSON.parse(body || '[]') as any[]).map((p) => ({
    number: Number(p.number),
    url: String(p.html_url ?? ''),
    state: p.merged_at ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN',
    headRefName: String(p.head?.ref ?? ''),
    headRefOid: p.head?.sha ?? undefined,
  }));
}

/** A pull request merged into a branch, for the clipboard's ✨ What's new (change-notes.ts). */
export interface MergedPull {
  number: number;
  title: string;
  body: string;
  url: string;
  /** When it merged (ms). */
  mergedAt: number;
  /** When GitHub last saw it change (ms): the lists are paged by this. */
  updatedAt: number;
  /** The commit that merged it into the base. */
  sha?: string;
  /** The branch it came from. */
  head: string;
}

/**
 * The pull requests merged into `base` of the checkout's origin repository, most recently updated
 * first, over REST. Pages through closed ones until a page reaches back past `since` (ms; 0 for all
 * of them), at most `maxPages` of 100; `complete` says whether it got that far. `web` is the
 * repository's page, for links to its commits.
 */
export async function mergedPulls(base: string, cwd: string, query: Query, since = 0, maxPages = 20): Promise<{ web: string; pulls: MergedPull[]; complete: boolean }> {
  const repo = await repoOf(cwd);
  const web = `https://${repo.host ?? 'github.com'}/${repo.owner}/${repo.name}`;
  const pulls: MergedPull[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const list = `repos/${repo.owner}/${repo.name}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=100&page=${page}`;
    const items = JSON.parse(splitResponse(await query(['api', '-i', ...hostArgs(repo), list], cwd)).body || '[]') as any[];
    for (const p of items) {
      if (!p?.merged_at) continue;
      pulls.push({
        number: Number(p.number),
        title: String(p.title ?? ''),
        body: String(p.body ?? ''),
        url: String(p.html_url ?? ''),
        mergedAt: Date.parse(p.merged_at),
        updatedAt: Date.parse(p.updated_at ?? p.merged_at),
        sha: typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : undefined,
        head: String(p.head?.ref ?? ''),
      });
    }
    const last = items[items.length - 1];
    if (items.length < 100 || (since && Date.parse(last?.updated_at) < since)) return { web, pulls, complete: true };
  }
  return { web, pulls, complete: false };
}

/**
 * `gh pr create`, and when GitHub's GraphQL quota ran out, the same pull request over REST instead.
 * Resolves to the output, the PR's URL on its last line. Without `base`, the repository's default branch.
 */
export async function createPull(query: Query, cwd: string, pr: { repository?: string; head: string; base?: string; title: string; body: string }, timeout = 60_000): Promise<string> {
  try {
    return await query(['pr', 'create', ...(pr.repository ? ['--repo', pr.repository] : []), '--head', pr.head, ...(pr.base ? ['--base', pr.base] : []), '--title', pr.title, '--body', pr.body], cwd, timeout);
  } catch (err) {
    // A secondary limit slows every API down alike; only the GraphQL quota is worth going around.
    const limit = rateLimitOf(err);
    if (!limit || limit.secondary) throw err;
    const repo = await repoOf(cwd, pr.repository);
    const base = pr.base ?? (await query(['api', ...hostArgs(repo), `repos/${repo.owner}/${repo.name}`, '--jq', '.default_branch'], cwd)).trim();
    // -f sends each value as a plain string: no @file reading, no {owner} filling in.
    const fields = { base, head: pr.head, title: pr.title, body: pr.body };
    const args = ['api', ...hostArgs(repo), '--method', 'POST', `repos/${repo.owner}/${repo.name}/pulls`, ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]), '--jq', '.html_url'];
    return (await query(args, cwd, timeout)).trim();
  }
}
