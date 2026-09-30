import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtAgo, fmtClock } from '../src/shared/ago.js';

const now = Date.parse('2026-09-30T14:04:00');

test('how long ago a call was', () => {
  assert.equal(fmtAgo(now - 20_000, now), 'just now');
  assert.equal(fmtAgo(now - 60_000, now), '1 min ago');
  assert.equal(fmtAgo(now - 5 * 60_000, now), '5 mins ago');
  assert.equal(fmtAgo(now - 60 * 60_000, now), '1 hour ago');
  assert.equal(fmtAgo(now - 3 * 60 * 60_000, now), '3 hours ago');
  assert.equal(fmtAgo(now - 24 * 60 * 60_000, now), 'yesterday');
  assert.equal(fmtAgo(now - 3 * 24 * 60 * 60_000, now), '3 days ago');
});

test('the clock time names the day once it is not today', () => {
  const today = fmtClock(Date.parse('2026-09-30T14:00:00'), now);
  const yesterday = fmtClock(Date.parse('2026-09-29T14:00:00'), now);
  assert.notEqual(today, yesterday);
  assert.ok(today.length > 0 && yesterday.length > today.length);
});
