/** Board reads share the server's gh login, so they also share its quota and concurrency limit. */
type Query = (args: string[], cwd: string) => Promise<string>;
const RATE_LIMIT = /rate limit|secondary rate|abuse detection/i;

export class BoardRequests {
  private tail: Promise<unknown> = Promise.resolve();
  private retryAt = 0;
  private failures = 0;

  constructor(private query: Query, private now = Date.now) {}

  run(args: string[], cwd: string): Promise<string> {
    // One board API request at a time across all floors, including requests queued before a limit.
    const pending = this.tail.then(async () => {
      if (this.now() < this.retryAt) throw this.limited();
      try {
        const out = await this.query(args, cwd);
        this.failures = 0;
        return out;
      } catch (err) {
        if (!RATE_LIMIT.test((err as Error).message)) throw err;
        const secondary = /secondary|abuse/i.test((err as Error).message);
        const delay = Math.min(60 * 60_000, (secondary ? 60_000 : 5 * 60_000) * 2 ** this.failures++);
        this.retryAt = this.now() + delay;
        if (!secondary) {
          try {
            const out = await this.query(['api', 'rate_limit'], cwd);
            const quota = JSON.parse(out).resources?.graphql;
            if (quota?.remaining === 0 && Number(quota.reset) * 1000 > this.now()) this.retryAt = Number(quota.reset) * 1000 + 1000;
          } catch { /* Keep the conservative backoff when the reset time is unavailable. */ }
        }
        throw this.limited();
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  private limited() {
    return new Error(`GitHub API rate limit reached. Board requests are paused until ${new Date(this.retryAt).toISOString()}; they will retry automatically. Signing in again will not restore this quota.`);
  }
}

const common = `number title state url author { login } labels(first:100) { nodes { name color } } createdAt updatedAt body`;
const issueFields = `${common} assignees(first:100) { nodes { login } } comments { totalCount }`;
const pullFields = `${common} isDraft reviewDecision headRefName baseRefName additions deletions
  closingIssuesReferences(first:100) { nodes { number } }
  commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`;

/** Keep the existing board limits without fetching full comment threads or every CI check. */
export async function boardList(kind: 'issues' | 'pulls', cwd: string, query: Query): Promise<any[]> {
  const issue = kind === 'issues';
  const connection = issue ? 'issues' : 'pullRequests';
  const fields = issue ? issueFields : pullFields;
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
          nodes { ${fields} } pageInfo { hasNextPage endCursor }
        }
        ${recent}
      }
    }`;
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${gql}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const response = JSON.parse(await query(args, cwd));
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
