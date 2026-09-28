import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardRequests, boardList } from '../src/server/github-board.js';

test('all floors share a serial request queue and stop queued reads until the primary reset', async () => {
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
    if (args[1] === 'rate_limit') return JSON.stringify({ resources: { graphql: { remaining: 0, reset: 2000 } } });
    if (limited) throw new Error('GraphQL: API rate limit already exceeded for user ID 123');
    return 'ok';
  }, () => now);
  const results = await Promise.allSettled([reads.run(['api', 'graphql'], 'a'), reads.run(['api', 'graphql'], 'b')]);
  assert.ok(results.every((r) => r.status === 'rejected' && /paused until.*retry automatically/.test(r.reason.message)));
  assert.equal(calls.length, 2, 'only the first read and one reset lookup reach gh');
  await assert.rejects(reads.run(['api', 'graphql'], 'c'), /Signing in again will not restore/);
  assert.equal(calls.length, 2);
  now = 2_001_000;
  limited = false;
  assert.deepEqual(await Promise.all([reads.run(['api', 'graphql'], 'a'), reads.run(['api', 'graphql'], 'b')]), ['ok', 'ok']);
  assert.equal(peak, 1);
});

test('secondary limits back off exponentially without another API call; ordinary errors do not pause', async () => {
  let now = 0;
  let calls = 0;
  let message = 'secondary rate limit';
  const reads = new BoardRequests(async () => { calls++; throw new Error(message); }, () => now);
  await assert.rejects(reads.run([], ''), /00:01:00/);
  now = 60_000;
  await assert.rejects(reads.run([], ''), /00:03:00/);
  now = 179_999;
  await assert.rejects(reads.run([], ''), /paused/);
  assert.equal(calls, 2);
  now = 180_000;
  message = 'gh is not installed';
  await assert.rejects(reads.run([], ''), /not installed/);
  await assert.rejects(reads.run([], ''), /not installed/);
  assert.equal(calls, 4);
});

test('primary limits use a conservative fallback when quota lookup fails', async () => {
  let calls = 0;
  const reads = new BoardRequests(async () => { calls++; throw new Error('API rate limit exceeded'); }, () => 0);
  await assert.rejects(reads.run([], ''), /00:05:00/);
  await assert.rejects(reads.run([], ''), /00:05:00/);
  assert.equal(calls, 2);
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
    return response(nodes, calls === 1 ? {
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
