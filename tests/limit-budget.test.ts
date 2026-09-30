import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetDayKey, budgetWarnings, dayBudget, overBudget } from '../src/shared/limit-budget.js';
import type { PlanWindow } from '../src/shared/protocol.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A week that started Monday 20:00 UTC and starts over the next Monday, like Claude's.
const START = Date.parse('2026-09-28T20:00:00Z');
const RESETS = START + 7 * DAY;
const week = (pct: number, label = 'Week', resetsAt = RESETS): PlanWindow => ({ label, pct, resetsAt });

test('each day of the week gets an equal seventh, from the hour it resets', () => {
  const first = dayBudget(week(0), START + HOUR)!;
  assert.equal(first.day, 1);
  assert.equal(first.share, 100 / 7);
  assert.equal(first.limit, 100 / 7);
  assert.equal(first.dayEndsAt, START + DAY);

  const third = dayBudget(week(20), START + 2 * DAY + 5 * HOUR)!;
  assert.equal(third.day, 3);
  assert.ok(Math.abs(third.limit - 300 / 7) < 1e-9);
  assert.ok(Math.abs(third.left - (300 / 7 - 20)) < 1e-9);
  assert.equal(third.dayEndsAt, START + 3 * DAY);
  assert.equal(overBudget(third), false);

  const last = dayBudget(week(99), RESETS - HOUR)!;
  assert.equal(last.day, 7);
  assert.equal(last.limit, 100);
});

test('what an earlier day left unused carries into today', () => {
  // Nothing used for four days: the fifth day may use five sevenths.
  const b = dayBudget(week(60), START + 4 * DAY + HOUR)!;
  assert.equal(overBudget(b), false);
  assert.ok(b.left > 11 && b.left < 12);
});

test('past today’s share: over budget, back within it the day the shares catch up', () => {
  // The reading that asked for this: 54% of the week gone early on day 2.
  const now = Date.parse('2026-09-30T04:36:35Z');
  const b = dayBudget(week(54), now)!;
  assert.equal(b.day, 2);
  assert.equal(overBudget(b), true);
  assert.ok(Math.abs(b.left - (200 / 7 - 54)) < 1e-9);
  // Four sevenths (57%) is the first to cover 54%: day 4 starts three days in.
  assert.equal(b.backAt, START + 3 * DAY);
  // 54% in 32.6 hours runs out about 27.7 hours later, days before the reset.
  assert.ok(b.runsOutAt !== undefined);
  assert.ok(Math.abs(b.runsOutAt - (now + (46 * (now - START)) / 54)) < 1);
  assert.ok(b.runsOutAt < RESETS);
});

test('used exactly up to today’s share counts as used up', () => {
  const b = dayBudget(week(100), RESETS - HOUR)!;
  assert.equal(b.left, 0);
  assert.equal(overBudget(b), true);
  assert.equal(b.backAt, RESETS);
});

test('no run-out estimate for a pace that lasts the week, or from too little of it', () => {
  assert.equal(dayBudget(week(10), START + 3 * DAY)!.runsOutAt, undefined);
  assert.equal(dayBudget(week(5), START + HOUR)!.runsOutAt, undefined);
  assert.equal(dayBudget(week(0), START + 3 * DAY)!.runsOutAt, undefined);
});

test('only weekly windows with a reset in the future get a budget', () => {
  const now = START + DAY;
  assert.equal(dayBudget({ label: '5h session', pct: 40, resetsAt: now + HOUR }, now), null);
  assert.equal(dayBudget({ label: 'Week', pct: 40 }, now), null);
  assert.equal(dayBudget(week(40, 'Week', now - 1), now), null);
  assert.ok(dayBudget(week(40, 'Fable week'), now));
  assert.ok(dayBudget(week(40, 'Opus week'), now));
});

test('a warning goes up once per window and budget day', () => {
  const now = START + DAY + HOUR;
  const windows = [{ label: '5h session', pct: 95, resetsAt: now + HOUR }, week(30), week(10, 'Fable week')];
  const due = budgetWarnings(windows, new Set(), now);
  assert.deepEqual(due.map((d) => d.window.label), ['Week']);
  assert.deepEqual(budgetWarnings(windows, new Set([due[0].key]), now), []);
  // The next budget day warns again while it's still over.
  const tomorrow = now + DAY;
  const again = budgetWarnings([week(45)], new Set([due[0].key]), tomorrow);
  assert.equal(again.length, 1);
  assert.notEqual(again[0].key, due[0].key);
});

test('the budget day key ignores the milliseconds the reset time moves by between reads', () => {
  const now = START + DAY + HOUR;
  const a = week(30, 'Week', RESETS + 17);
  const b = week(30, 'Week', RESETS + 943);
  assert.equal(budgetDayKey(a, dayBudget(a, now)!), budgetDayKey(b, dayBudget(b, now)!));
  const fable = week(30, 'Fable week');
  assert.notEqual(budgetDayKey(fable, dayBudget(fable, now)!), budgetDayKey(a, dayBudget(a, now)!));
});
