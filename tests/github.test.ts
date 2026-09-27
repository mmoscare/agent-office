import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MergeWatch, findCheckouts } from '../src/server/github.js';
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
