import type { GhPause } from '../shared/protocol.js';

/** Board reads share the server's gh login, so they also share its quota and concurrency limit. */
export type Query = (args: string[], cwd: string, source?: string) => Promise<string>;
export const RATE_LIMIT = /rate limit|secondary rate|abuse detection/i;
const SECONDARY = /secondary|abuse/i;

/**
 * GraphQL points (of the 5,000 a GitHub user gets an hour) kept back from background board
 * refreshes. Workers' `gh pr create`/`gh pr view` cost about 1 point a request and a person's
 * Refresh of a floor about 8 (3 for issues, 5 for pull requests, per checkout), so 500 leaves room
 * for a few hundred worker calls and several Refreshes until the hour resets. It's a tenth of the
 * bucket: most hours never get near it.
 */
export const RESERVE = 500;

/** What GitHub last said about this user's GraphQL quota. */
export interface GhQuota {
  remaining: number;
  /** When the hour's points come back (ms). */
  resetAt: number;
}

/** A read refused because the quota is out (or kept back), saying until when. */
export class QuotaPause extends Error {
  constructor(readonly pause: GhPause, now: number) {
    super(quotaMessage(pause, now));
  }
}

/** HH:MM UTC, and how long until then. */
function clock(at: number, now: number): string {
  const mins = Math.max(1, Math.ceil((at - now) / 60_000));
  return `${new Date(at).toISOString().slice(11, 16)} UTC (in ${mins} min)`;
}

/** What a person is told when GitHub's rate limit stops the office's reads, instead of gh's own text. */
export function quotaMessage(pause: Partial<GhPause>, now = Date.now()): string {
  const when = pause.until && pause.until > now ? clock(pause.until, now) : undefined;
  if (pause.why === 'secondary') return `GitHub's secondary rate limit: too many requests at once. It lifts by itself${when ? ` at ${when}` : ' within a few minutes'}; the office waits until then.`;
  if (pause.why === 'reserve') return `GitHub's hourly API quota for this account is nearly used up${pause.remaining !== undefined ? ` (${pause.remaining} points left)` : ''}. Background board refreshes wait until it resets${when ? ` at ${when}` : ''}, so workers can still open pull requests; Refresh still works.`;
  return `GitHub's API rate limit: this account's shared hourly API quota ran out (the office, its workers and anything else signed in as this GitHub user draw on it). It resets ${when ? `at ${when}` : 'within the hour'}; the office waits until then and retries by itself. Signing in again won't bring it back.`;
}

/** `gh api -i` prints the status line and headers before the body: split them off. */
export function splitHeaders(out: string): { headers: Record<string, string>; body: string } {
  if (!out.startsWith('HTTP/')) return { headers: {}, body: out };
  const end = /\r?\n\r?\n/.exec(out);
  const headers: Record<string, string> = {};
  for (const line of (end ? out.slice(0, end.index) : out).split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body: end ? out.slice(end.index + end[0].length) : '' };
}

/** The GraphQL quota in a response's X-RateLimit-* headers, which come even with a refusal. */
export function headerQuota(headers: Record<string, string>): GhQuota | undefined {
  const resource = headers['x-ratelimit-resource'];
  if (resource && resource !== 'graphql') return undefined;
  const remaining = Number(headers['x-ratelimit-remaining'] ?? NaN);
  const reset = Number(headers['x-ratelimit-reset'] ?? NaN);
  return Number.isFinite(remaining) && reset > 0 ? { remaining, resetAt: reset * 1000 } : undefined;
}

/** The `rateLimit { cost remaining resetAt }` a board query asks for, if the body has it. */
export function bodyQuota(body: string): (GhQuota & { cost: number }) | undefined {
  const m = /"rateLimit"\s*:\s*(\{[^{}]*\})/.exec(body);
  if (!m) return undefined;
  try {
    const r = JSON.parse(m[1]);
    const resetAt = Date.parse(r.resetAt);
    return Number.isFinite(r.remaining) && Number.isFinite(resetAt) ? { remaining: r.remaining, resetAt, cost: Number(r.cost) || 0 } : undefined;
  } catch {
    return undefined;
  }
}

/** Costs nothing when the quota is out, and says when it comes back. */
const PROBE = ['api', '-i', 'graphql', '-f', 'query={rateLimit{remaining resetAt}}'];

export class BoardRequests {
  private tail: Promise<unknown> = Promise.resolve();
  private retryAt = 0;
  private secondary = false;
  private failures = 0;
  /** The GraphQL quota as the last response told it; unset until one has. */
  quota?: GhQuota;

  constructor(private query: Query, private now = Date.now) {}

  /** One board API request at a time across all floors, including requests queued before a limit. */
  run(args: string[], cwd: string, source?: string): Promise<string> {
    const pending = this.tail.then(() => this.attempt(args, cwd, source));
    this.tail = pending.catch(() => {});
    return pending;
  }

  /**
   * A read a person is waiting on (the PR and issue windows): under the same pause as the boards,
   * but not queued behind a floor's worth of board pages.
   */
  direct(args: string[], cwd: string, source?: string): Promise<string> {
    return this.attempt(args, cwd, source);
  }

  /**
   * Why reads wait right now, if they do: GitHub refused (everyone waits), or, for background
   * refreshes only, the quota is below the reserve until it resets.
   */
  paused(background = false): GhPause | undefined {
    const now = this.now();
    if (now < this.retryAt) return { until: this.retryAt, why: this.secondary ? 'secondary' : 'limit' };
    const q = this.quota;
    if (background && q && q.remaining < RESERVE && now < q.resetAt) return { until: q.resetAt, why: 'reserve', remaining: q.remaining };
    return undefined;
  }

  /** A newer reading of the quota, from a response's headers or its rateLimit field. */
  note(q?: GhQuota) {
    if (q) this.quota = q;
  }

  private async attempt(args: string[], cwd: string, source?: string): Promise<string> {
    const pause = this.paused();
    if (pause) throw new QuotaPause(pause, this.now());
    try {
      const { headers, body } = splitHeaders(await this.query(args, cwd, source));
      this.note(headerQuota(headers));
      this.note(bodyQuota(body));
      this.failures = 0;
      return body;
    } catch (err) {
      if (!RATE_LIMIT.test((err as Error).message)) throw err;
      this.secondary = SECONDARY.test((err as Error).message);
      const backoff = Math.min(60 * 60_000, (this.secondary ? 60_000 : 5 * 60_000) * 2 ** this.failures++);
      this.retryAt = this.now() + backoff;
      if (!this.secondary) {
        const reset = (await this.resetOf(err as Error, cwd)) ?? 0;
        if (reset > this.now()) this.retryAt = reset + 1000;
      }
      throw new QuotaPause(this.paused()!, this.now());
    }
  }

  /**
   * When an exhausted quota comes back: from the refusal's own headers (`gh api -i`), else the
   * last reading, else a probe (free while the quota is out). `gh api rate_limit` isn't asked: its
   * GraphQL numbers lag behind the ones GitHub enforces.
   */
  private async resetOf(err: Error & { stdout?: string }, cwd: string): Promise<number | undefined> {
    const refused = headerQuota(splitHeaders(err.stdout ?? '').headers);
    if (refused) {
      this.note(refused);
      return refused.resetAt;
    }
    if (this.quota && this.quota.resetAt > this.now()) return this.quota.resetAt;
    try {
      const probe = headerQuota(splitHeaders(await this.query(PROBE, cwd, 'quota probe')).headers);
      this.note(probe);
      return probe?.resetAt;
    } catch (probeErr) {
      const q = headerQuota(splitHeaders((probeErr as { stdout?: string }).stdout ?? '').headers);
      this.note(q);
      return q?.resetAt;
    }
  }
}

const common = `number title state url author { login } labels(first:100) { nodes { name color } } createdAt updatedAt body`;
const issueFields = `${common} assignees(first:100) { nodes { login } } comments { totalCount }`;
const pullFields = `${common} isDraft reviewDecision headRefName headRefOid baseRefName additions deletions
  closingIssuesReferences(first:100) { nodes { number } }
  commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;
/** Only an open PR can conflict. `mergeable` is a scalar, so it adds nothing to the query's cost. */
const openPullFields = `${pullFields} mergeable`;

/**
 * Keep the existing board limits without fetching full comment threads or every CI check.
 * Each page also asks what it cost and how much quota is left (free), and is fetched with its
 * headers (`-i`) so a refusal still says when the quota resets.
 */
export async function boardList(kind: 'issues' | 'pulls', cwd: string, query: Query, source?: string): Promise<any[]> {
  const issue = kind === 'issues';
  const connection = issue ? 'issues' : 'pullRequests';
  const fields = issue ? issueFields : pullFields;
  const openFields = issue ? issueFields : openPullFields;
  const limit = issue ? 300 : 150;
  const items: any[] = [];
  let cursor: string | undefined;
  let count = 0;
  do {
    const recent = count === 0 ? `closed: ${connection}(first:40, states:CLOSED, orderBy:{field:CREATED_AT,direction:DESC}) { nodes { ${fields} } }
      ${issue ? '' : `merged: pullRequests(first:30, states:MERGED, orderBy:{field:CREATED_AT,direction:DESC}) { nodes { ${fields} } }`}` : '';
    const gql = `query($owner:String!, $name:String!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        ${issue ? 'hasIssuesEnabled' : ''}
        open: ${connection}(first:${Math.min(100, limit - count)}, after:$cursor, states:OPEN, orderBy:{field:CREATED_AT,direction:DESC}) {
          nodes { ${openFields} } pageInfo { hasNextPage endCursor }
        }
        ${recent}
      }
      rateLimit { cost remaining resetAt }
    }`;
    const args = ['api', '-i', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${gql}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const response = JSON.parse(splitHeaders(await query(args, cwd, source)).body);
    if (response.errors?.length) throw new Error(response.errors.map((e: any) => e.message).join('; '));
    const repo = response.data?.repository;
    if (!repo) throw new Error("gh can't find this repository on GitHub (check the remote and access)");
    if (issue && !repo.hasIssuesEnabled) throw new Error('This repository has disabled issues on GitHub');
    items.push(...repo.open.nodes, ...(repo.merged?.nodes ?? []), ...(repo.closed?.nodes ?? []));
    count += repo.open.nodes.length;
    cursor = repo.open.pageInfo.hasNextPage ? repo.open.pageInfo.endCursor : undefined;
  } while (cursor && count < limit);
  const seen = new Set<number>();
  return items.filter((it) => !seen.has(it.number) && seen.add(it.number)).map((it) => ({
    ...it,
    labels: it.labels?.nodes ?? [],
    assignees: it.assignees?.nodes ?? [],
    comments: it.comments?.totalCount ?? 0,
    closingIssuesReferences: it.closingIssuesReferences?.nodes ?? [],
    statusCheckRollup: it.commits?.nodes?.[0]?.commit?.statusCheckRollup ? [it.commits.nodes[0].commit.statusCheckRollup] : [],
  })).sort((a, b) => Number(a.state !== 'OPEN') - Number(b.state !== 'OPEN') || b.createdAt.localeCompare(a.createdAt));
}
