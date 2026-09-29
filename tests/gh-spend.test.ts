import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhSpend, graphqlCost, sourceOf, spendLine } from '../src/server/gh-spend.js';

test('a board page reports its own cost; other gh commands are estimated from what they send', () => {
  const board = 'HTTP/2.0 200 OK\r\n\r\n{"data":{"repository":{},"rateLimit":{"cost":5,"remaining":4000,"resetAt":"2026-09-29T02:18:02Z"}}}';
  assert.deepEqual(graphqlCost(['api', '-i', 'graphql', '-f', 'query=…'], board), { points: 5, exact: true });
  // Measured with GH_DEBUG=api: one GraphQL request each (pr diff adds a REST one).
  for (const args of [['pr', 'view', '1', '--json', 'body'], ['pr', 'diff', '1'], ['issue', 'view', '2'], ['repo', 'view', '--json', 'nameWithOwner'], ['pr', 'list', '--head', 'b']]) {
    assert.deepEqual(graphqlCost(args, '{}'), { points: 1, exact: false }, args.join(' '));
  }
  assert.deepEqual(graphqlCost(['pr', 'merge', '3', '--squash']), { points: 2, exact: false });
  assert.deepEqual(graphqlCost(['pr', 'create', '--title', 't']), { points: 3, exact: false });
  assert.equal(graphqlCost(['api', 'repos/{owner}/{repo}/pulls/1/comments']), undefined, 'REST has its own quota');
  assert.equal(graphqlCost(['api', '--method', 'POST', 'repos/{owner}/{repo}/issues/1/comments']), undefined);
});

test('unlabelled calls are put down to what they ask', () => {
  assert.equal(sourceOf(['pr', 'list', '--head', 'office/x', '--state', 'all']), 'branch PR lookups');
  assert.equal(sourceOf(['pr', 'create', '--head', 'b']), 'PR create');
  assert.equal(sourceOf(['issue', 'edit', '4', '--add-assignee', '@me']), 'board actions');
  assert.equal(sourceOf(['repo', 'view', 'me/x']), 'repo info');
  assert.equal(sourceOf(['pr', 'view', 'office/x']), 'other pr view');
});

test('the meter tallies points per source by window, counts refusals as free, and keeps a short history', () => {
  let now = Date.parse('2026-09-29T01:15:00Z');
  const spend = new GhSpend(() => now);
  const page = (cost: number) => `{"data":{"rateLimit":{"cost":${cost},"remaining":1,"resetAt":"x"}}}`;
  spend.record(['api', '-i', 'graphql'], page(5), 'board pulls agent-office');
  spend.record(['api', '-i', 'graphql'], page(5), 'board pulls agent-office');
  spend.record(['api', '-i', 'graphql'], page(3), 'board issues agent-office');
  spend.record(['pr', 'view', '1'], '{}', 'detail windows');
  spend.record(['api', '-i', 'graphql'], '', 'board pulls agent-office', true);
  spend.record(['api', 'user'], 'me', 'detail windows');
  now += 15 * 60_000;
  const r = spend.flush();
  assert.equal(r.points, 14);
  assert.equal(r.estimated, 1);
  assert.equal(r.rest, 1);
  assert.deepEqual(r.sources[0], { source: 'board pulls agent-office', calls: 3, points: 10, estimated: 0 });
  assert.equal(spendLine(r, { remaining: 4210, resetAt: Date.parse('2026-09-29T02:18:00Z') }),
    'GitHub GraphQL spent by the office 01:15–01:30Z: 14 points (~1 estimated), 1 REST calls — board pulls agent-office 10/3, board issues agent-office 3/1, detail windows ~1/1; quota 4210 left, resets 02:18Z');
  assert.deepEqual(spend.report().sources, [], 'a new window starts empty');
  for (let i = 0; i < 10; i++) spend.flush();
  assert.equal(spend.history.length, 8);
});
