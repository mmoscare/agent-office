import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTHLY_CHORES,
  choreNotificationBody,
  choreNotificationTitle,
  choresOnDay,
  choresPending,
  daysInMonth,
  monthGrid,
  monthKey,
  monthTitle,
  officeDate,
  shouldNotify,
  shiftMonth,
} from '../src/shared/calendar.js';

test('the three first-of-month chores sit on the 1st and nowhere else', () => {
  assert.equal(MONTHLY_CHORES.length, 3);
  assert.deepEqual(MONTHLY_CHORES.map(c => c.id), ['cleanup', 'mft-portfolio', 'backup']);
  assert.equal(choresOnDay(1), MONTHLY_CHORES);
  assert.deepEqual(choresOnDay(2), []);
  assert.deepEqual(choresOnDay(15), []);
  assert.match(MONTHLY_CHORES[0].title, /branches and worktrees/i);
  assert.match(MONTHLY_CHORES[1].title, /MFT and Personal Portfolio/i);
  assert.match(MONTHLY_CHORES[1].detail, /same capabilities/i);
  assert.equal(MONTHLY_CHORES[2].title, 'Backup');
});

test("the office date follows the office clock's UTC offset", () => {
  const ms = Date.UTC(2026, 9, 1, 4, 30); // 04:30 UTC on 1 Oct
  assert.deepEqual(officeDate(ms, 0), { year: 2026, month: 9, day: 1 });
  assert.deepEqual(officeDate(ms, -5 * 60), { year: 2026, month: 8, day: 30 });
  assert.deepEqual(officeDate(ms, 12 * 60), { year: 2026, month: 9, day: 1 });
});

test('month grids start on Sunday and pad empty cells', () => {
  // 1 January 2026 is a Thursday.
  assert.deepEqual(monthGrid(2026, 0)[0], [null, null, null, null, 1, 2, 3]);
  assert.equal(daysInMonth(2026, 0), 31);
  assert.equal(daysInMonth(2024, 1), 29);
  const feb = monthGrid(2024, 1).flat().filter((d): d is number => d !== null);
  assert.equal(feb.at(-1), 29);
  assert.equal(monthTitle({ year: 2026, month: 9 }), 'October 2026');
  assert.equal(monthKey({ year: 2026, month: 9 }), '2026-10');
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth({ year: 2025, month: 11 }, 1), { year: 2026, month: 0 });
});

test('chores stay pending until that month is marked done, and notify once', () => {
  const oct = { year: 2026, month: 9, day: 1 };
  const later = { year: 2026, month: 9, day: 15 };
  const nov = { year: 2026, month: 10, day: 1 };
  assert.equal(choresPending(oct, null), true);
  assert.equal(choresPending(later, null), true);
  assert.equal(choresPending(oct, '2026-10'), false);
  assert.equal(choresPending(nov, '2026-10'), true);
  assert.equal(shouldNotify(oct, null, null), true);
  assert.equal(shouldNotify(oct, null, '2026-10'), false);
  assert.equal(shouldNotify(oct, '2026-10', null), false);
  assert.equal(shouldNotify(nov, '2026-10', '2026-10'), true);
});

test('the notification names the first of the month and lists every chore', () => {
  assert.equal(choreNotificationTitle(), '📅 First of the month');
  const body = choreNotificationBody();
  assert.match(body, /Delete and clean up branches and worktrees/);
  assert.match(body, /Combine MFT and Personal Portfolio/);
  assert.match(body, /Backup/);
  assert.equal(body.split('\n').length, 3);
});
