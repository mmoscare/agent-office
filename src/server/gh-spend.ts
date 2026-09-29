/**
 * What the office itself spends of the GitHub user's hourly GraphQL quota, by source, so a quota
 * that keeps running out can be put down to the office or to something else signed in as the same
 * user. Board reads ask GitHub what they cost (exact); other gh commands are estimated from what
 * they send (about one point a GraphQL request, measured with GH_DEBUG=api). Workers' own gh
 * commands run in their terminals, outside the server, and aren't counted here.
 */

/** One source's calls and points in a window. */
export interface SpendTally {
  source: string;
  calls: number;
  points: number;
  /** Points that were estimated rather than reported by GitHub. */
  estimated: number;
}

export interface SpendReport {
  /** The window (ms). */
  from: number;
  to: number;
  points: number;
  estimated: number;
  /** gh calls that used only the REST API, which has its own quota. */
  rest: number;
  sources: SpendTally[];
}

/** gh subcommands that change something: a lookup, then a mutation. */
const WRITES = /^(create|merge|close|reopen|edit|ready|comment|review|delete|lock|unlock|transfer|pin|unpin)$/;

/**
 * The GraphQL points a gh call spent, and whether GitHub said so (`rateLimit.cost` in the output)
 * or it's estimated. `undefined` for REST-only calls.
 */
export function graphqlCost(args: string[], out = ''): { points: number; exact: boolean } | undefined {
  const cost = /"rateLimit"\s*:\s*\{[^{}]*"cost"\s*:\s*(\d+)/.exec(out);
  if (cost) return { points: Number(cost[1]), exact: true };
  const [cmd, sub] = args;
  if (cmd === 'api') return args.includes('graphql') ? { points: 1, exact: false } : undefined;
  if (cmd === 'pr' && sub === 'create') return { points: 3, exact: false };
  if ((cmd === 'pr' || cmd === 'issue') && WRITES.test(sub ?? '')) return { points: 2, exact: false };
  if (cmd === 'pr' || cmd === 'issue' || (cmd === 'repo' && (sub === 'view' || sub === 'clone'))) return { points: 1, exact: false };
  return undefined;
}

/** Where an unlabelled gh call came from, by what it asks. */
export function sourceOf(args: string[]): string {
  const [cmd, sub] = args;
  if (cmd === 'pr' && sub === 'list' && args.includes('--head')) return 'branch PR lookups';
  if (cmd === 'pr' && sub === 'create') return 'PR create';
  if ((cmd === 'pr' || cmd === 'issue') && WRITES.test(sub ?? '')) return 'board actions';
  if (cmd === 'repo') return 'repo info';
  return `other ${[cmd, sub].filter(Boolean).join(' ')}`.trim();
}

export class GhSpend {
  private window = new Map<string, SpendTally>();
  private rest = 0;
  private from: number;
  /** The last few flushed windows, oldest first. */
  readonly history: SpendReport[] = [];

  constructor(private now = Date.now) {
    this.from = now();
  }

  /** A finished gh call; `limited` when GitHub refused it for the rate limit (which costs nothing). */
  record(args: string[], out: string, source?: string, limited = false) {
    const cost = graphqlCost(args, out);
    if (!cost) {
      this.rest++;
      return;
    }
    const key = source ?? sourceOf(args);
    const t = this.window.get(key) ?? { source: key, calls: 0, points: 0, estimated: 0 };
    t.calls++;
    if (!limited) {
      t.points += cost.points;
      if (!cost.exact) t.estimated += cost.points;
    }
    this.window.set(key, t);
  }

  /** Since the last flush, biggest spender first. */
  report(): SpendReport {
    const sources = [...this.window.values()].sort((a, b) => b.points - a.points || a.source.localeCompare(b.source));
    return {
      from: this.from,
      to: this.now(),
      points: sources.reduce((n, t) => n + t.points, 0),
      estimated: sources.reduce((n, t) => n + t.estimated, 0),
      rest: this.rest,
      sources,
    };
  }

  /** The report, then a fresh window. */
  flush(): SpendReport {
    const r = this.report();
    this.history.push(r);
    if (this.history.length > 8) this.history.shift();
    this.window.clear();
    this.rest = 0;
    this.from = r.to;
    return r;
  }
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * One line for the server log. `~` marks estimated points; `a/b` is points/calls.
 * e.g. `GitHub GraphQL spent by the office 01:15–01:30Z: 212 points (~14 estimated), 5 REST calls — board pulls agent-office 60/12, …; quota 4210 left, resets 02:18Z`
 */
export function spendLine(r: SpendReport, quota?: { remaining: number; resetAt: number }): string {
  const parts = r.sources.map((t) => `${t.source} ${t.estimated === t.points && t.points ? '~' : ''}${t.points}/${t.calls}`);
  const left = quota && quota.resetAt > r.to ? `; quota ${quota.remaining} left, resets ${hhmm(quota.resetAt)}Z` : '';
  return `GitHub GraphQL spent by the office ${hhmm(r.from)}–${hhmm(r.to)}Z: ${r.points} points${r.estimated ? ` (~${r.estimated} estimated)` : ''}, ${r.rest} REST calls${parts.length ? ` — ${parts.join(', ')}` : ''}${left}`;
}
