import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { branchPulls, branchPullsPath, createPull, rateLimitOf } from '../src/server/github-rest.js';

/** A checkout with these remotes, and nothing else. */
function checkout(t: { after(fn: () => void): void }, remotes: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-rest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['remote', 'add', name, url], { cwd: dir });
  return dir;
}

/** gh, answering with `out` and noting what it was asked. */
function fake(out: string | ((args: string[]) => string)) {
  const calls: string[][] = [];
  const query = async (args: string[]) => {
    calls.push(args);
    return typeof out === 'string' ? out : out(args);
  };
  return { calls, query };
}

const headers = (status: string, h: Record<string, string | number>) => `HTTP/2.0 ${status}\n${Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;

test("a branch's PRs are asked of origin's repository by name, over REST, the branch's slash encoded", async (t) => {
  // An upstream remote too: gh's {owner}/{repo} could pick it; the adapter never does.
  const dir = checkout(t, { origin: 'git@github.com:mmoscare/agent-office.git', upstream: 'https://github.com/AgentSystemLabs/agent-office.git' });
  const gh = fake('[]');
  assert.deepEqual(await branchPulls('office/fizz-6d06', dir, gh.query), []);
  assert.deepEqual(gh.calls, [['api', '-i', 'repos/mmoscare/agent-office/pulls?state=all&head=mmoscare:office%2Ffizz-6d06&per_page=100']]);
  assert.equal(branchPullsPath({ owner: 'me', name: 'app' }, 'feature/a b#c', 'open'), 'repos/me/app/pulls?state=open&head=me:feature%2Fa%20b%23c&per_page=100');
});

test('a named repository wins over origin; another GitHub host goes by --hostname', async (t) => {
  const dir = checkout(t, { origin: 'https://github.com/me/origin.git' });
  const gh = fake('[]');
  await branchPulls('office/a-1', dir, gh.query, 'Me/Named');
  await branchPulls('office/a-1', dir, gh.query, 'github.com/me/workspace', 'open');
  await branchPulls('office/a-1', dir, gh.query, 'GHE.example.com/team/tool');
  assert.deepEqual(gh.calls, [
    ['api', '-i', 'repos/Me/Named/pulls?state=all&head=Me:office%2Fa-1&per_page=100'],
    ['api', '-i', 'repos/me/workspace/pulls?state=open&head=me:office%2Fa-1&per_page=100'],
    ['api', '-i', '--hostname', 'ghe.example.com', 'repos/team/tool/pulls?state=all&head=team:office%2Fa-1&per_page=100'],
  ]);
});

test('a checkout whose origin is not on GitHub is refused without asking gh', async (t) => {
  const gh = fake('[]');
  await assert.rejects(branchPulls('office/a-1', checkout(t, {}), gh.query), /origin remote isn't on GitHub/);
  await assert.rejects(branchPulls('office/a-1', checkout(t, { origin: '../elsewhere' }), gh.query), /origin remote isn't on GitHub/);
  await assert.rejects(branchPulls('office/a-1', checkout(t, {}), gh.query, 'not a repo'), /isn't a GitHub repository/);
  assert.equal(gh.calls.length, 0);
});

test('REST states map onto OPEN, CLOSED and MERGED, with url, head branch and head commit', async (t) => {
  const dir = checkout(t, { origin: 'https://github.com/me/app' });
  const pr = (number: number, state: string, merged_at: string | null) => ({ number, state, merged_at, html_url: `https://github.com/me/app/pull/${number}`, head: { ref: 'office/x-1', sha: `sha${number}` } });
  const body = JSON.stringify([pr(3, 'open', null), pr(2, 'closed', '2026-09-28T21:54:54Z'), pr(1, 'closed', null)]);
  const out = headers('200 OK', { 'X-Ratelimit-Remaining': 4975, 'X-Ratelimit-Reset': 1790647178 }) + body;
  assert.deepEqual(await branchPulls('office/x-1', dir, fake(out).query), [
    { number: 3, url: 'https://github.com/me/app/pull/3', state: 'OPEN', headRefName: 'office/x-1', headRefOid: 'sha3' },
    { number: 2, url: 'https://github.com/me/app/pull/2', state: 'MERGED', headRefName: 'office/x-1', headRefOid: 'sha2' },
    { number: 1, url: 'https://github.com/me/app/pull/1', state: 'CLOSED', headRefName: 'office/x-1', headRefOid: 'sha1' },
  ]);
});

test("rate limits are told apart from other failures, with the reset from gh api -i's headers", () => {
  const now = 1_790_645_000_000;
  const err = (message: string, stdout?: string) => Object.assign(new Error(message), { stdout });
  const primary = headers('403 Forbidden', { 'X-Ratelimit-Remaining': 0, 'X-Ratelimit-Reset': 1790647178 }) + '{"message":"API rate limit exceeded"}';
  assert.deepEqual(rateLimitOf(err('API rate limit exceeded for user ID 62819637. (HTTP 403)', primary), now), { secondary: false, resetAt: 1790647178000 });
  // No message to go by, but GitHub's headers say the quota is gone.
  assert.deepEqual(rateLimitOf(err('Forbidden (HTTP 403)', primary), now), { secondary: false, resetAt: 1790647178000 });
  // GraphQL's (gh pr create's) and a message without headers: no reset known.
  assert.deepEqual(rateLimitOf(err('GraphQL: API rate limit already exceeded for user ID 62819637.'), now), { secondary: false, resetAt: undefined });
  const secondary = headers('403 Forbidden', { 'Retry-After': 60, 'X-Ratelimit-Remaining': 4000 }) + '{}';
  assert.deepEqual(rateLimitOf(err('You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)', secondary), now), { secondary: true, resetAt: now + 60_000 });
  assert.deepEqual(rateLimitOf(err('You have triggered an abuse detection mechanism.'), now), { secondary: true, resetAt: undefined });
  // A 404 that happened to spend the last point is still a 404.
  assert.equal(rateLimitOf(err("gh can't find this repository on GitHub (check the remote and access)", headers('404 Not Found', { 'X-Ratelimit-Remaining': 0, 'X-Ratelimit-Reset': 1 }) + '{}'), now), undefined);
  assert.equal(rateLimitOf(err('connect ETIMEDOUT'), now), undefined);
});

test('gh pr create is the normal path; when GraphQL is out of quota the PR is created over REST instead', async (t) => {
  const dir = checkout(t, { origin: 'https://github.com/me/app.git', upstream: 'https://github.com/author/app.git' });
  const pr = { head: 'office/x-1', base: 'personal', title: 'Title', body: '@not-a-file {owner}' };
  const ok = fake('Creating pull request\nhttps://github.com/me/app/pull/7\n');
  assert.match(await createPull(ok.query, dir, { ...pr, repository: 'me/app' }), /pull\/7/);
  assert.deepEqual(ok.calls, [['pr', 'create', '--repo', 'me/app', '--head', 'office/x-1', '--base', 'personal', '--title', 'Title', '--body', '@not-a-file {owner}']]);

  const limited = fake((args) => {
    if (args[0] === 'pr') throw new Error('GraphQL: API rate limit already exceeded for user ID 62819637.');
    return 'https://github.com/me/app/pull/8\n';
  });
  assert.equal(await createPull(limited.query, dir, pr), 'https://github.com/me/app/pull/8');
  assert.deepEqual(limited.calls[1], ['api', '--method', 'POST', 'repos/me/app/pulls', '-f', 'base=personal', '-f', 'head=office/x-1', '-f', 'title=Title', '-f', 'body=@not-a-file {owner}', '--jq', '.html_url']);

  // No base given: the repository's default branch, as gh pr create would pick.
  const noBase = fake((args) => {
    if (args[0] === 'pr') throw new Error('GraphQL: API rate limit already exceeded for user ID 62819637.');
    return args.includes('.default_branch') ? 'main\n' : 'https://github.com/me/app/pull/9';
  });
  assert.equal(await createPull(noBase.query, dir, { head: 'office/x-1', title: 'T', body: '' }), 'https://github.com/me/app/pull/9');
  assert.deepEqual(noBase.calls[1], ['api', 'repos/me/app', '--jq', '.default_branch']);
  assert.ok(noBase.calls[2].includes('base=main'));

  for (const message of ['You have exceeded a secondary rate limit', 'a pull request already exists']) {
    const failing = fake(() => {
      throw new Error(message);
    });
    await assert.rejects(createPull(failing.query, dir, pr), new RegExp(message));
    assert.equal(failing.calls.length, 1, `${message}: no REST retry`);
  }
});
