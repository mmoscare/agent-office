import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardRequests, QuotaPause, RESERVE, boardList, bodyQuota, headerQuota, quotaMessage, splitHeaders } from '../src/server/github-board.js';

/** What `gh api -i` prints: the status line and headers, a blank line, then the body. */
const withHeaders = (body: string, h: Record<string, string | number>) =>
  `HTTP/2.0 200 OK\n${Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`;
/** gh's refusal when the GraphQL quota is out, with the headers `-i` printed before it gave up. */
const refusal = (resetSeconds: number, stdout = true) => Object.assign(new Error('GraphQL: API rate limit already exceeded for user ID 123.'), {
  stdout: stdout ? withHeaders('{"errors":[{"type":"RATE_LIMITED"}]}', { 'X-Ratelimit-Remaining': 0, 'X-Ratelimit-Reset': resetSeconds, 'X-Ratelimit-Resource': 'graphql', 'X-Ratelimit-Used': 5000 }) : '',
});

test('all floors share a serial queue, and a refusal pauses queued reads until the reset its own headers give', async () => {
  let now = 1_000_000;
  const calls: string[][] = [];
  let limited = true;
  let active = 0;
  let peak = 0;
  const reads = new BoardRequests(async (args) => {
    calls.push(args);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (limited) throw refusal(2000);
    return 'ok';
  }, () => now);
  const results = await Promise.allSettled([reads.run(['api', '-i', 'graphql'], 'a'), reads.run(['api', '-i', 'graphql'], 'b')]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason instanceof QuotaPause && r.reason.pause.until === 2_001_000));
  assert.equal(calls.length, 1, 'only the first read reaches gh: no reset lookup at all');
  assert.ok(!calls.flat().includes('rate_limit'), '`gh api rate_limit` is never asked: its GraphQL numbers are stale');
  await assert.rejects(reads.run(['api', 'graphql'], 'c'), /shared hourly API quota ran out.*resets at 00:33 UTC \(in 17 min\).*Signing in again won't/);
  assert.equal(calls.length, 1);
  assert.deepEqual(reads.quota, { remaining: 0, resetAt: 2_000_000 });
  now = 2_001_000;
  limited = false;
  assert.deepEqual(await Promise.all([reads.run(['api', 'graphql'], 'a'), reads.run(['api', 'graphql'], 'b')]), ['ok', 'ok']);
  assert.equal(peak, 1);
});

test('a refusal without headers (the PR window) asks a free probe for the reset, or uses the last reading', async () => {
  let now = 1_000_000;
  const calls: string[][] = [];
  const reads = new BoardRequests(async (args) => {
    calls.push(args);
    if (args.join(' ').includes('rateLimit{remaining resetAt}')) throw refusal(1600);
    throw refusal(0, false);
  }, () => now);
  await assert.rejects(reads.direct(['pr', 'view', '7', '--json', 'body'], 'floor'), (e: QuotaPause) => e.pause.until === 1_601_000 && e.pause.why === 'limit');
  assert.deepEqual(calls.map((a) => a.slice(0, 3).join(' ')), ['pr view 7', 'api -i graphql']);
  // No headers, but a reading whose hour is still running: its reset, with no probe.
  now = 1_700_000;
  const readings = new BoardRequests(async () => { throw refusal(0, false); }, () => now);
  readings.note({ remaining: 12, resetAt: 1_900_000 });
  await assert.rejects(readings.direct(['issue', 'view', '1'], ''), (e: QuotaPause) => e.pause.until === 1_901_000);
});

test('secondary limits back off exponentially without another API call; ordinary errors do not pause', async () => {
  let now = 0;
  let calls = 0;
  let message = 'You have exceeded a secondary rate limit';
  const reads = new BoardRequests(async () => { calls++; throw new Error(message); }, () => now);
  await assert.rejects(reads.run([], ''), /secondary rate limit.*00:01 UTC/);
  now = 60_000;
  await assert.rejects(reads.run([], ''), /00:03 UTC/);
  now = 179_999;
  await assert.rejects(reads.run([], ''), (e: QuotaPause) => e.pause.why === 'secondary');
  assert.equal(calls, 2);
  now = 180_000;
  message = 'gh is not installed';
  await assert.rejects(reads.run([], ''), /not installed/);
  await assert.rejects(reads.run([], ''), /not installed/);
  assert.equal(calls, 4);
});

test('primary limits fall back to a conservative pause when no reset can be found', async () => {
  let calls = 0;
  const reads = new BoardRequests(async () => { calls++; throw new Error('API rate limit exceeded'); }, () => 0);
  await assert.rejects(reads.run([], ''), /resets at 00:05 UTC/);
  await assert.rejects(reads.run([], ''), /00:05 UTC/);
  assert.equal(calls, 2, 'the read, and one probe for the reset');
});

test('below the reserve, background reads wait for the reset while a person\'s reads still go', async () => {
  let now = 1_000_000;
  const reset = new Date(1_600_000).toISOString();
  const reads = new BoardRequests(async () => withHeaders(`{"data":{"rateLimit":{"cost":5,"remaining":${RESERVE - 1},"resetAt":"${reset}"}}}`, { 'X-Ratelimit-Remaining': RESERVE + 4, 'X-Ratelimit-Reset': 1600, 'X-Ratelimit-Resource': 'graphql' }), () => now);
  assert.equal(reads.paused(true), undefined, 'nothing is known yet');
  const body = await reads.run(['api', '-i', 'graphql'], '');
  assert.ok(body.startsWith('{"data"'), 'headers are split off before the board sees the body');
  assert.deepEqual(reads.quota, { remaining: RESERVE - 1, resetAt: 1_600_000 }, 'the body\'s rateLimit is the latest word');
  assert.deepEqual(reads.paused(true), { until: 1_600_000, why: 'reserve', remaining: RESERVE - 1 });
  assert.equal(reads.paused(false), undefined);
  assert.equal(await reads.direct(['pr', 'view', '1'], '').then(() => 'went'), 'went');
  assert.match(quotaMessage(reads.paused(true)!, now), /nearly used up \(499 points left\).*00:26 UTC \(in 10 min\).*Refresh still works/);
  now = 1_600_000;
  assert.equal(reads.paused(true), undefined, 'the reserve lifts with the reset');
});

test('a person\'s read is not queued behind a floor\'s board pages', async () => {
  let release!: () => void;
  const reads = new BoardRequests(async (args) => (args[0] === 'slow' ? new Promise<string>((r) => (release = () => r('page'))) : 'detail'));
  const page = reads.run(['slow'], '');
  assert.equal(await reads.direct(['pr', 'view', '1'], ''), 'detail');
  release();
  assert.equal(await page, 'page');
});

test('quota readings come from -i headers and from the rateLimit field', () => {
  const raw = withHeaders('{"data":{"repository":{"open":{"nodes":[{"body":"quoted \\"rateLimit\\":{\\"cost\\":99}"}]}},"rateLimit":{"cost":3,"remaining":4210,"resetAt":"2026-09-29T02:18:02Z"}}}', {
    'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': 4213, 'X-Ratelimit-Reset': 1790648282, 'X-Ratelimit-Resource': 'graphql',
  });
  const { headers, body } = splitHeaders(raw);
  assert.deepEqual(headerQuota(headers), { remaining: 4213, resetAt: 1790648282000 });
  assert.deepEqual(bodyQuota(body), { remaining: 4210, resetAt: Date.parse('2026-09-29T02:18:02Z'), cost: 3 });
  assert.equal(headerQuota({ 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }), undefined, 'the REST bucket is another quota');
  assert.deepEqual(splitHeaders('{"plain":1}'), { headers: {}, body: '{"plain":1}' });
});


const item = (number: number, state = 'OPEN') => ({ number, state, createdAt: `${number}`.padStart(4, '0'), labels: { nodes: [{ name: 'bug', color: 'ffffff' }] } });
const response = (nodes: any[], rest = {}, cursor?: string) => JSON.stringify({ data: { repository: {
  hasIssuesEnabled: true,
  open: { nodes, pageInfo: { hasNextPage: !!cursor, endCursor: cursor } }, ...rest,
} } });

test('issues paginate only open items to 300, count comments, and retain closed issues', async () => {
  let calls = 0;
  const items = await boardList('issues', 'floor', async (args, cwd) => {
    assert.equal(cwd, 'floor');
    assert.ok(args.includes('owner={owner}') && args.includes('name={repo}'));
    const gql = args.find((s) => s.startsWith('query='))!;
    assert.match(gql, /comments \{ totalCount \}/);
    // What each page cost and what's left come free with it, and -i brings the headers a refusal still has.
    assert.match(gql, /rateLimit \{ cost remaining resetAt \}/);
    assert.equal(args[1], '-i');
    assert.equal(gql.includes('closed:'), calls === 0);
    if (calls) assert.ok(args.includes(`cursor=page${calls}`));
    const nodes = Array.from({ length: 100 }, (_, i) => ({ ...item(calls * 100 + i), comments: { totalCount: 237 }, assignees: { nodes: [{ login: 'owner' }] } }));
    calls++;
    return response(nodes, calls === 1 ? { closed: { nodes: [item(999, 'CLOSED')] } } : {}, `page${calls}`);
  });
  assert.equal(calls, 3);
  assert.equal(items.length, 301);
  assert.equal(items[0].comments, 237);
  assert.deepEqual(items[0].assignees, [{ login: 'owner' }]);
  assert.equal(items.at(-1).state, 'CLOSED');
});

test('PRs retain merge/closed states, check summary and closing links; open pagination stops at 150', async () => {
  let calls = 0;
  const items = await boardList('pulls', '', async (args) => {
    const gql = args.find((s) => s.startsWith('query='))!;
    assert.match(gql, /statusCheckRollup \{ state \}/);
    // Unshipped work matches a merged PR to its branch by the head commit.
    assert.match(gql, /\bheadRefOid\b/);
    // Conflicts are asked of open PRs only (the board's ⚔️ Conflicts pill).
    assert.match(gql.slice(0, gql.indexOf('pageInfo')), /\bmergeable\b/);
    assert.doesNotMatch(gql.slice(gql.indexOf('pageInfo')), /\bmergeable\b/);
    assert.doesNotMatch(gql, /contexts|checkRuns/);
    assert.match(gql, calls ? /first:50/ : /first:100/);
    const nodes = Array.from({ length: calls ? 50 : 100 }, (_, i) => item(calls * 100 + i));
    calls++;
    // As `gh api -i` prints it: headers first.
    return 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4000\r\n\r\n' + response(nodes, calls === 1 ? {
      merged: { nodes: [{ ...item(888, 'MERGED'), closingIssuesReferences: { nodes: [{ number: 42 }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }] },
      closed: { nodes: [item(999, 'CLOSED')] },
    } : {}, 'more');
  });
  assert.equal(calls, 2);
  assert.equal(items.length, 152);
  const merged = items.find((p) => p.state === 'MERGED');
  assert.deepEqual(merged.statusCheckRollup, [{ state: 'FAILURE' }]);
  assert.deepEqual(merged.closingIssuesReferences, [{ number: 42 }]);
  assert.deepEqual(items[0].statusCheckRollup, []);
});

test('GraphQL partial errors and disabled issues are errors rather than an empty successful board', async () => {
  await assert.rejects(boardList('issues', '', async () => JSON.stringify({ errors: [{ message: 'rate limit exceeded' }] })), /rate limit/);
  await assert.rejects(boardList('issues', '', async () => response([], { hasIssuesEnabled: false })), /disabled issues/);
});
