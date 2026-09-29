import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitHub, MergeWatch, findCheckouts, friendly } from '../src/server/github.js';
import { BoardRequests, QuotaPause, RESERVE } from '../src/server/github-board.js';
import { boardCadence, boardsDue, TICK_MS } from '../src/server/board-cadence.js';
import type { GhPull } from '../src/shared/protocol.js';

const pull = (number: number, state: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName: `b${number}`, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});
const numbers = (ps: GhPull[]) => ps.map((p) => p.number);

test('a pull request that was open at the last look and is merged now rings once', () => {
  const w = new MergeWatch();
  assert.deepEqual(numbers(w.look([pull(1, 'OPEN'), pull(2, 'MERGED'), pull(3, 'OPEN')])), [], 'nothing rings on the first look');
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED'), pull(3, 'CLOSED')])), [1]);
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED')])), []);
});

test('a merge from the PR window rings right away, and not again when GitHub catches up', () => {
  const w = new MergeWatch();
  w.look([pull(5, 'OPEN'), pull(6, 'OPEN')]);
  assert.equal(w.ring(5), true);
  assert.equal(w.ring(5), false);
  // A look that started before the merge still says open; the next one says merged.
  assert.deepEqual(numbers(w.look([pull(5, 'OPEN'), pull(6, 'OPEN')])), []);
  assert.deepEqual(numbers(w.look([pull(5, 'MERGED'), pull(6, 'MERGED')])), [6]);
});

test('the same PR number in two repositories of a folder floor rings for each', () => {
  const w = new MergeWatch();
  const a = (state: string): GhPull => ({ ...pull(7, state), repo: 'me/a' });
  const b = (state: string): GhPull => ({ ...pull(7, state), repo: 'me/b' });
  w.look([a('OPEN'), b('OPEN')]);
  assert.equal(w.ring(7, 'me/a'), true);
  assert.deepEqual(w.look([a('MERGED'), b('MERGED')]).map((p) => p.repo), ['me/b']);
});

test('a floor that is a folder finds the GitHub checkouts in it', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-folder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = (rel: string, origin?: string) => {
    const dir = path.join(root, rel);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  };
  repo('frontend', 'https://github.com/me/site.git');
  repo('backend', 'git@github.com:me/api.git');
  repo('owner/nested', 'https://github.com/me/nested');
  repo('copy-of-frontend', 'https://github.com/me/site');
  repo('local-only');
  repo('elsewhere', 'https://gitlab.com/me/other.git');
  mkdirSync(path.join(root, 'notes'));
  return findCheckouts(root).then((found) => {
    assert.deepEqual(
      found.map((c) => [c.repo, c.rel]),
      [['me/api', 'backend'], ['me/site', 'copy-of-frontend'], ['me/nested', 'owner/nested']],
    );
  });
});

test('folder boards keep failed repositories, throttle background reads, and recover after an error', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-board-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a', 'b']) {
    const dir = path.join(root, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', `https://github.com/me/${name}`], { cwd: dir });
  }
  let failed = '';
  let calls = 0;
  const github = new GitHub(root, () => {}, () => {}, new BoardRequests(async (_args, cwd) => {
    calls++;
    if (failed === 'all' || path.basename(cwd) === failed) throw new Error('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
    return JSON.stringify({ data: { repository: {
      hasIssuesEnabled: true,
      open: { nodes: [{ number: 1, title: 'Keep me', state: 'OPEN', createdAt: '', updatedAt: '',
        labels: { nodes: [] }, comments: { totalCount: 123 }, headRefOid: 'abc123', mergeable: 'CONFLICTING',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
      }], pageInfo: { hasNextPage: false } },
    } } });
  }));
  await github.refresh();
  assert.equal(github.issues.items.length, 2);
  assert.equal(github.issues.items[0].comments, 123);
  assert.equal(github.pulls.items[0].checks, 'pending');
  assert.equal(github.pulls.items[0].mergeable, 'CONFLICTING');
  assert.equal(github.pulls.items[0].headRefOid, 'abc123');
  assert.equal(github.pulls.items[0].repoDir, 'a');
  const initialCalls = calls;
  await github.refresh(false);
  assert.equal(calls, initialCalls, 'background refresh on a folder floor respects the five minute interval');
  failed = 'b';
  await github.refresh();
  assert.equal(github.pulls.items.length, 2, 'partial failure retains the last data for b');
  assert.match(github.pulls.error!, /me\/b:.*502/);
  const fetchedAt = github.pulls.fetchedAt;
  failed = 'all';
  await github.refresh();
  assert.equal(github.pulls.items.length, 2);
  assert.equal(github.pulls.fetchedAt, fetchedAt, 'a failed refresh is not reported as newly fetched data');
  assert.equal(github.pulls.loading, false);
  failed = '';
  await github.refresh();
  assert.equal(github.pulls.error, undefined);
});

/** A checkout of me/<name> with a GitHub origin, for a one-repository floor. */
function checkout(t: { after(fn: () => void): void }, name = 'repo'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `office-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/me/${name}`], { cwd: dir });
  return dir;
}

/** One board page, as `gh api -i graphql` prints it, with the quota the query asked about. */
const page = (remaining: number, resetAt: number) => `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${resetAt / 1000}\r\nX-Ratelimit-Resource: graphql\r\n\r\n${JSON.stringify({ data: {
  repository: { hasIssuesEnabled: true, open: { nodes: [{ number: 1, title: 'One', state: 'OPEN', createdAt: '', updatedAt: '', labels: { nodes: [] } }], pageInfo: { hasNextPage: false } } },
  rateLimit: { cost: 3, remaining, resetAt: new Date(resetAt).toISOString() },
} })}`;

test('below the reserve, background refreshes hold until the reset while a person\'s Refresh still runs', async (t) => {
  let now = Date.now();
  const resetAt = now + 10 * 60_000;
  let remaining = RESERVE - 20;
  const calls: string[] = [];
  const pulls: { paused?: string; items: number }[] = [];
  const github = new GitHub(checkout(t), () => {}, (s) => pulls.push({ paused: s.paused?.why, items: s.items.length }), new BoardRequests(async (args) => {
    calls.push(args.find((a) => a.startsWith('query='))!.includes('pullRequests') ? 'pulls' : 'issues');
    return page(remaining, resetAt);
  }, () => now));
  await github.refresh();
  assert.deepEqual(calls.sort(), ['issues', 'pulls']);
  calls.length = 0;
  pulls.length = 0;
  await github.refresh(false);
  await github.refresh(false, ['pulls']);
  assert.deepEqual(calls, [], 'background refreshes leave the last points to the workers');
  assert.deepEqual(github.pulls.paused, { until: resetAt, why: 'reserve', remaining: RESERVE - 20 });
  assert.equal(github.issues.paused?.why, 'reserve');
  assert.equal(github.pulls.items.length, 1, 'the cards stay');
  assert.deepEqual(pulls, [{ paused: 'reserve', items: 1 }], 'the board hears once, not every tick');
  await github.refresh();
  assert.deepEqual(calls.sort(), ['issues', 'pulls'], 'a person\'s Refresh still runs while points are left');
  assert.equal(github.pulls.paused, undefined);
  calls.length = 0;
  now = resetAt;
  remaining = 5000;
  await github.refresh(false, ['pulls']);
  assert.deepEqual(calls, ['pulls'], 'and background refreshes resume once the hour resets');
  assert.equal(github.pulls.paused, undefined);
  assert.ok(Date.now() - github.asked.pulls < 5000, 'the cadence counts from when the board last went to GitHub');
});

test('when the quota is out, the boards and the PR and issue windows all wait for the exact reset', async (t) => {
  const now = Date.now();
  const resetAt = Math.floor(now / 1000) * 1000 + 7 * 60_000;
  const calls: string[] = [];
  const github = new GitHub(checkout(t), () => {}, () => {}, new BoardRequests(async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    throw Object.assign(new Error(friendly('GraphQL: API rate limit already exceeded for user ID 62819637.')), {
      stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${resetAt / 1000}\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}`,
    });
  }, () => now));
  await github.refresh();
  assert.deepEqual(github.pulls.paused, { until: resetAt + 1000, why: 'limit' });
  assert.match(github.pulls.error!, /shared hourly API quota ran out.*resets at \d\d:\d\d UTC \(in 8 min\)/);
  assert.doesNotMatch(github.pulls.error!, /user ID/, 'not gh\'s own text');
  const before = calls.length;
  await assert.rejects(github.pullDetail(1), (e: QuotaPause) => e instanceof QuotaPause && e.pause.until === resetAt + 1000);
  await assert.rejects(github.issueDetail(2), QuotaPause);
  await assert.rejects(github.pullDiff(1), QuotaPause);
  assert.equal(calls.length, before, 'the windows don\'t ask GitHub again until it resets');
  await github.refresh();
  assert.equal(calls.length, before, 'nor does Refresh');
});

test('the friendly text for rate limits says whose quota ran out, when it resets, and that signing in won\'t help', () => {
  const primary = friendly('GraphQL: API rate limit already exceeded for user ID 62819637.');
  assert.match(primary, /GitHub's API rate limit: this account's shared hourly API quota ran out/);
  assert.match(primary, /resets within the hour.*Signing in again won't bring it back/);
  assert.match(friendly('You have exceeded a secondary rate limit.'), /secondary rate limit: too many requests at once/);
  assert.equal(friendly('HTTP 404: Not Found'), "gh can't find this repository on GitHub (check the remote and access)");
});

test('boards refresh every tick for people, only pull requests (and less often) for workers alone, seldom for nobody', () => {
  const people = { people: true, busy: false, checkouts: 1 };
  const workers = { people: false, busy: true, checkouts: 1 };
  const nobody = { people: false, busy: false, checkouts: 1 };
  assert.deepEqual(boardCadence(people), { issues: TICK_MS, pulls: TICK_MS });
  assert.deepEqual(boardCadence(workers), { pulls: 6 * 60_000 });
  assert.deepEqual(boardCadence({ ...workers, checkouts: 4 }), { pulls: 12 * 60_000 });
  assert.deepEqual(boardCadence(nobody), { pulls: 30 * 60_000 });
  const t0 = 1_000_000;
  const asked = { issues: t0, pulls: t0 };
  // Ticks come every 90 seconds; one that fires a moment early still counts.
  assert.deepEqual(boardsDue(people, asked, t0 + TICK_MS - 1000), ['issues', 'pulls']);
  assert.deepEqual(boardsDue(people, asked, t0 + 30_000), [], 'not again right after a Refresh');
  assert.deepEqual(boardsDue(workers, asked, t0 + 3 * TICK_MS), []);
  assert.deepEqual(boardsDue(workers, asked, t0 + 4 * TICK_MS), ['pulls'], 'the fourth tick: every six minutes');
  assert.deepEqual(boardsDue(nobody, asked, t0 + 19 * TICK_MS), []);
  assert.deepEqual(boardsDue(nobody, asked, t0 + 20 * TICK_MS), ['pulls']);
  assert.deepEqual(boardsDue(workers, { issues: 0, pulls: 0 }, t0), ['pulls'], 'issues wait for someone to walk in');
  // When the rate limit lifts, the boards it held back go at once, within what's watched.
  assert.deepEqual(boardsDue(people, asked, t0 + 1000, ['issues', 'pulls']), ['issues', 'pulls']);
  assert.deepEqual(boardsDue(workers, asked, t0 + 1000, ['issues', 'pulls']), ['pulls']);
});

test('points per floor-hour at the measured cost fall where nobody is watching', () => {
  // Measured with rateLimit { cost }: 3 points for a checkout's issues, 5 for its pull requests (one page each).
  const perHour = (every: Partial<Record<'issues' | 'pulls', number>>) => (every.issues ? (3600_000 / every.issues) * 3 : 0) + (every.pulls ? (3600_000 / every.pulls) * 5 : 0);
  assert.equal(perHour(boardCadence({ people: true, busy: true, checkouts: 1 })), 320, 'watched: as before');
  assert.equal(perHour(boardCadence({ people: false, busy: true, checkouts: 1 })), 50, 'workers only: was 320');
  assert.equal(perHour(boardCadence({ people: false, busy: false, checkouts: 1 })), 10, 'nobody: was 48');
});
