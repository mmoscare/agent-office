import { rateLimitOf } from './github-rest.js';

// What the VP asks GitHub (see vp.ts), over REST wherever it can: the boards' GraphQL quota is shared
// by every client signed in to the account and often runs dry, while REST has its own. Only whether
// a review thread is resolved needs GraphQL, and the VP manages without it when that's refused.

/** gh, as github.ts runs it: resolves to stdout. */
export type Gh = (args: string[], cwd: string, timeout?: number) => Promise<string>;

/** Codex's review bot, whose inline comments carry a P0-P3 badge on their first line. */
export const CODEX_LOGINS = ['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector'];

export interface VpPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  headRef: string;
  headSha: string;
  /** owner/name the head branch lives in (a fork's, for a PR from one). */
  headRepo?: string;
  baseRef: string;
  createdAt: string;
  state?: 'open' | 'closed';
  merged?: boolean;
}

export interface RepoFacts {
  defaultBranch: string;
  fork: boolean;
  parent?: string;
  allowMerge: boolean;
}

function pullOf(p: any): VpPull {
  return {
    number: Number(p.number),
    title: String(p.title ?? ''),
    url: String(p.html_url ?? ''),
    draft: !!p.draft,
    author: String(p.user?.login ?? ''),
    headRef: String(p.head?.ref ?? ''),
    headSha: String(p.head?.sha ?? ''),
    headRepo: p.head?.repo?.full_name ?? undefined,
    baseRef: String(p.base?.ref ?? ''),
    createdAt: String(p.created_at ?? ''),
    state: p.state === 'closed' ? 'closed' : 'open',
    merged: !!p.merged_at || p.merged === true,
  };
}

async function getJson(gh: Gh, cwd: string, path: string): Promise<any> {
  const out = await gh(['api', path], cwd, 60_000);
  return JSON.parse(out || 'null');
}

/** Every page of a list endpoint (100 a page, up to `max` items). */
async function getAll(gh: Gh, cwd: string, path: string, max = 500): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; out.length < max; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = (await getJson(gh, cwd, `${path}${sep}per_page=100&page=${page}`)) as any[];
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export async function repoFacts(gh: Gh, cwd: string, repo: string): Promise<RepoFacts> {
  const r = await getJson(gh, cwd, `repos/${repo}`);
  return { defaultBranch: String(r?.default_branch ?? ''), fork: !!r?.fork, parent: r?.parent?.full_name ?? undefined, allowMerge: r?.allow_merge_commit !== false };
}

export async function viewerLogin(gh: Gh, cwd: string): Promise<string | undefined> {
  try {
    return String((await getJson(gh, cwd, 'user'))?.login ?? '') || undefined;
  } catch {
    return undefined;
  }
}

export async function openPulls(gh: Gh, cwd: string, repo: string): Promise<VpPull[]> {
  return (await getAll(gh, cwd, `repos/${repo}/pulls?state=open&sort=created&direction=asc`)).map(pullOf);
}

export async function pullNow(gh: Gh, cwd: string, repo: string, n: number): Promise<VpPull> {
  return pullOf(await getJson(gh, cwd, `repos/${repo}/pulls/${n}`));
}

// ---- Reviews, findings and checks ------------------------------------------------------------

export interface ReviewComment {
  id: number;
  url: string;
  author: string;
  body: string;
  path: string;
  /** null once the lines it's on changed in a later commit (the comment is outdated). */
  line: number | null;
  inReplyTo?: number;
  createdAt: string;
}

export interface IssueComment {
  id: number;
  url: string;
  author: string;
  body: string;
  createdAt: string;
}

export async function reviewComments(gh: Gh, cwd: string, repo: string, n: number): Promise<ReviewComment[]> {
  return (await getAll(gh, cwd, `repos/${repo}/pulls/${n}/comments`)).map((c) => ({
    id: Number(c.id),
    url: String(c.html_url ?? ''),
    author: String(c.user?.login ?? ''),
    body: String(c.body ?? ''),
    path: String(c.path ?? ''),
    line: typeof c.line === 'number' ? c.line : null,
    inReplyTo: typeof c.in_reply_to_id === 'number' ? c.in_reply_to_id : undefined,
    createdAt: String(c.created_at ?? ''),
  }));
}

export async function issueComments(gh: Gh, cwd: string, repo: string, n: number): Promise<IssueComment[]> {
  return (await getAll(gh, cwd, `repos/${repo}/issues/${n}/comments`)).map((c) => ({
    id: Number(c.id),
    url: String(c.html_url ?? ''),
    author: String(c.user?.login ?? ''),
    body: String(c.body ?? ''),
    createdAt: String(c.created_at ?? ''),
  }));
}

/** The reviewers whose latest say on the PR is "changes requested". */
export async function changesRequested(gh: Gh, cwd: string, repo: string, n: number): Promise<string[]> {
  const reviews = await getAll(gh, cwd, `repos/${repo}/pulls/${n}/reviews`);
  const latest = new Map<string, string>();
  for (const r of reviews) {
    const state = String(r.state ?? '');
    if (state === 'COMMENTED' || state === 'PENDING') continue;
    latest.set(String(r.user?.login ?? ''), state);
  }
  return [...latest].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([who]) => who);
}

/** Whether each review thread is resolved, by its first comment's id: GraphQL only, so undefined when that's refused. */
export async function resolvedThreads(gh: Gh, cwd: string, repo: string, n: number): Promise<Map<number, boolean> | undefined> {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}';
  try {
    const out = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${n}`], cwd, 60_000);
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const map = new Map<number, boolean>();
    for (const t of nodes) {
      const id = t?.comments?.nodes?.[0]?.databaseId;
      if (typeof id === 'number') map.set(id, !!t.isResolved);
    }
    return map;
  } catch {
    return undefined;
  }
}

export type FindingStatus = 'unfixed' | 'addressed' | 'resolved';

export interface CodexFinding {
  id: number;
  url: string;
  priority: string;
  path: string;
  /** Its first line without the badge: what Codex says is wrong. */
  title: string;
  outdated: boolean;
  status: FindingStatus;
  /** Why it counts as addressed or resolved. */
  why?: string;
}

const BADGE = /!\[(P[0-3]) Badge\]\([^)]*\)|badge\/(P[0-3])-/i;

/** Codex's P0-P3 badge on a comment's first line, when it has one. */
export function codexPriority(body: string): string | undefined {
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  const m = BADGE.exec(first);
  return m ? (m[1] ?? m[2]).toUpperCase() : undefined;
}

const isCodex = (login: string) => CODEX_LOGINS.includes(login);
const ADDRESSED = /\b(fix(ed|es)?|address(ed|es)?|resolv(ed|es)?|handled|done)\b/i;

/**
 * Codex's findings on a PR and whether each is still to fix. One counts as fixed only when its thread
 * is resolved, or when a later commit changed its lines (GitHub marks it outdated) and a reply in its
 * thread, or a later comment on the PR that points at it or at Codex's review, says it's addressed.
 * Anything short of that is unfixed: when unsure, the VP doesn't merge.
 */
export function codexFindings(comments: ReviewComment[], discussion: IssueComment[], resolved?: Map<number, boolean>): CodexFinding[] {
  const out: CodexFinding[] = [];
  for (const c of comments) {
    if (c.inReplyTo !== undefined || !isCodex(c.author)) continue;
    const priority = codexPriority(c.body);
    if (!priority) continue;
    const title = (c.body.split(/\r?\n/, 1)[0] ?? '').replace(BADGE, '').replace(/[*_`]/g, '').trim().slice(0, 160);
    const outdated = c.line === null;
    const base = { id: c.id, url: c.url, priority, path: c.path, title, outdated };
    if (resolved?.get(c.id)) {
      out.push({ ...base, status: 'resolved', why: 'its review thread is resolved' });
      continue;
    }
    const reply = comments.find((r) => r.inReplyTo === c.id && !isCodex(r.author) && r.createdAt >= c.createdAt);
    const handoff = discussion.find(
      (d) => d.createdAt > c.createdAt && !isCodex(d.author) && (d.body.includes(c.url) || d.body.includes(`r${c.id}`) || d.body.includes(String(c.id)) || (/codex/i.test(d.body) && ADDRESSED.test(d.body))),
    );
    if (outdated && (reply || handoff)) {
      out.push({ ...base, status: 'addressed', why: reply ? `its lines changed and ${reply.author} replied in the thread` : `its lines changed and a later comment says it's addressed (${handoff!.url})` });
      continue;
    }
    out.push({ ...base, status: 'unfixed', why: outdated ? 'its lines changed, but nothing says it was addressed' : "its lines haven't changed since" });
  }
  return out;
}

export interface CheckSummary {
  state: 'pass' | 'fail' | 'pending' | 'none';
  failing: string[];
  pending: string[];
}

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error']);

/** CI on a commit: its check runs and its commit statuses together. */
export async function commitChecks(gh: Gh, cwd: string, repo: string, sha: string): Promise<CheckSummary> {
  const [runs, status] = await Promise.all([getJson(gh, cwd, `repos/${repo}/commits/${sha}/check-runs?per_page=100`), getJson(gh, cwd, `repos/${repo}/commits/${sha}/status`)]);
  const failing: string[] = [];
  const pending: string[] = [];
  for (const r of runs?.check_runs ?? []) {
    const name = String(r.name ?? 'check');
    if (r.status !== 'completed') pending.push(name);
    else if (FAILED.has(String(r.conclusion ?? ''))) failing.push(name);
  }
  for (const s of status?.statuses ?? []) {
    const name = String(s.context ?? 'status');
    if (s.state === 'pending') pending.push(name);
    else if (s.state === 'failure' || s.state === 'error') failing.push(name);
  }
  const any = (runs?.check_runs?.length ?? 0) + (status?.statuses?.length ?? 0) > 0;
  return { state: failing.length ? 'fail' : pending.length ? 'pending' : any ? 'pass' : 'none', failing, pending };
}

// ---- Writing: comments and the merge --------------------------------------------------------

export async function postComment(gh: Gh, cwd: string, repo: string, n: number, body: string): Promise<string | undefined> {
  try {
    await gh(['api', '--method', 'POST', `repos/${repo}/issues/${n}/comments`, '-f', `body=${body}`], cwd, 60_000);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Merges PR `n` with a merge commit, only while its head is still `sha`: gh pr merge with
 * --match-head-commit, or the same over REST when GraphQL's quota is gone. Never deletes the branch.
 * Resolves to why it didn't merge, or undefined once it has.
 */
export async function mergePull(gh: Gh, cwd: string, repo: string, n: number, sha: string): Promise<string | undefined> {
  try {
    await gh(['pr', 'merge', String(n), '--repo', repo, '--merge', '--match-head-commit', sha], cwd, 120_000);
    return undefined;
  } catch (err) {
    const limit = rateLimitOf(err);
    if (!limit || limit.secondary) return (err as Error).message;
  }
  try {
    const out = await gh(['api', '--method', 'PUT', `repos/${repo}/pulls/${n}/merge`, '-f', 'merge_method=merge', '-f', `sha=${sha}`], cwd, 120_000);
    const body = JSON.parse(out || '{}');
    return body?.merged === false ? String(body?.message ?? 'GitHub did not merge it') : undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
