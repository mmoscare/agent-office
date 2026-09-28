import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GhPull, UnshippedItem } from '../src/shared/protocol.js';
import { comparePulls, ghTrouble, groupByRepo, pullSections, pullStatus, showsRepo, sortUnshipped } from '../src/client/ui/pr-board-model.js';

function pr(number: number, over: Partial<GhPull> = {}): GhPull {
  return {
    number,
    title: `PR ${number}`,
    state: 'OPEN',
    isDraft: false,
    url: '',
    author: 'me',
    labels: [],
    reviewDecision: '',
    headRefName: `office/b-${number}`,
    baseRefName: 'personal',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    additions: 1,
    deletions: 0,
    checks: 'none',
    body: '',
    closes: [],
    ...over,
  };
}

test('pullStatus: drafts, conflicts, failing checks, reviews and finished PRs', () => {
  assert.equal(pullStatus(pr(1, { isDraft: true, checks: 'fail', mergeable: 'CONFLICTING' })).key, 'draft');
  assert.equal(pullStatus(pr(2, { mergeable: 'CONFLICTING', checks: 'fail' })).key, 'conflict');
  assert.equal(pullStatus(pr(3, { checks: 'fail', reviewDecision: 'APPROVED' })).key, 'failing');
  assert.equal(pullStatus(pr(4, { reviewDecision: 'CHANGES_REQUESTED' })).key, 'changes');
  assert.equal(pullStatus(pr(5, { checks: 'pending' })).key, 'running');
  assert.equal(pullStatus(pr(6, { reviewDecision: 'APPROVED', checks: 'pass' })).key, 'ready');
  assert.equal(pullStatus(pr(7, { checks: 'pass' })).key, 'review');
  assert.equal(pullStatus(pr(8, { mergeable: 'UNKNOWN' })).key, 'review', "GitHub still working out mergeability isn't a conflict");
  assert.equal(pullStatus(pr(9)).key, 'review', 'an older office sends no mergeable field');
  assert.equal(pullStatus(pr(10, { state: 'MERGED', checks: 'fail' })).key, 'merged');
  assert.equal(pullStatus(pr(11, { state: 'CLOSED' })).key, 'closed');
});

test('pullSections: needs you, in progress and done, most urgent first', () => {
  const items = [
    pr(1, { checks: 'pass', updatedAt: '2026-09-03T00:00:00Z' }),
    pr(2, { isDraft: true }),
    pr(3, { checks: 'fail' }),
    pr(4, { reviewDecision: 'APPROVED', updatedAt: '2026-09-02T00:00:00Z' }),
    pr(5, { mergeable: 'CONFLICTING' }),
    pr(6, { checks: 'pending' }),
    pr(7, { state: 'MERGED', updatedAt: '2026-09-05T00:00:00Z' }),
    pr(8, { state: 'CLOSED', updatedAt: '2026-09-06T00:00:00Z' }),
    pr(9, { state: 'MERGED', updatedAt: '2026-09-04T00:00:00Z' }),
    pr(10, { checks: 'pass', updatedAt: '2026-09-09T00:00:00Z' }),
  ];
  const s = pullSections(items, 2);
  assert.deepEqual(s.needsYou.map((p) => p.number), [5, 3, 4, 10, 1]);
  assert.deepEqual(s.inProgress.map((p) => p.number), [6, 2]);
  assert.deepEqual(s.done.map((p) => p.number), [8, 7], 'newest finished first, cut to the limit');
  assert.equal(s.doneTotal, 3);
  assert.deepEqual(items.map((p) => p.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "the store's list isn't reordered");
});

test('comparePulls orders the 3D wall the same way', () => {
  const sorted = [pr(1, { isDraft: true }), pr(2, { checks: 'fail' }), pr(3)].sort(comparePulls);
  assert.deepEqual(sorted.map((p) => p.number), [2, 3, 1]);
});

test('groupByRepo keeps order and leads with the repository of the most urgent item', () => {
  const items = [pr(1, { repo: 'o/b' }), pr(2, { repo: 'o/a' }), pr(3, { repo: 'o/b' }), pr(4)];
  const groups = groupByRepo(items, (p) => p.repo);
  assert.deepEqual(groups.map((g) => [g.repo, g.items.map((p) => p.number)]), [['o/b', [1, 3]], ['o/a', [2]], ['', [4]]]);
  assert.equal(showsRepo(items.map((p) => p.repo)), true);
  assert.equal(showsRepo(['o/a', 'o/a']), true, 'a folder floor names the repository even while only one of them has PRs');
  assert.equal(showsRepo([undefined, undefined]), false, "a floor that's one repository doesn't");
  assert.equal(showsRepo([]), false);
});

test('ghTrouble tells rate limits, setup and network trouble apart', () => {
  assert.equal(ghTrouble('GraphQL: API rate limit exceeded for user ID 1.'), 'rate-limit');
  assert.equal(ghTrouble('You have exceeded a secondary rate limit'), 'rate-limit');
  assert.equal(ghTrouble("gh isn't logged in on the server — run `gh auth login`"), 'setup');
  assert.equal(ghTrouble('spawn gh ENOENT'), 'setup');
  assert.equal(ghTrouble('error connecting to api.github.com: dial tcp: lookup api.github.com: ENOTFOUND'), 'offline');
  assert.equal(ghTrouble('something else broke'), 'other');
});

test('sortUnshipped: actionable first, then recovering, then still-working; newest within each', () => {
  const u = (key: string, over: Partial<UnshippedItem> = {}): UnshippedItem => ({ key, branch: `office/${key}`, worker: 'gone', dirty: 1, commits: 0, unpushed: 0, pr: 'none', ...over });
  const items = [u('active', { worker: 'active', modifiedAt: 9 }), u('old', { modifiedAt: 1 }), u('recovering', { modifiedAt: 8 }), u('new', { modifiedAt: 5, worker: 'idle' }), u('never')];
  const sorted = sortUnshipped(items, (it) => it.key === 'recovering');
  assert.deepEqual(sorted.map((it) => it.key), ['new', 'old', 'never', 'recovering', 'active']);
});
