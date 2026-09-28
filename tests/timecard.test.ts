import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimeCard, timeCardKey } from '../src/server/timecard.js';
import { dayKey, hoursText, liveStints, startOfWeek, timeBetween, timeDays, TIMECARD_GRACE_MS, TIMECARD_KEEP_MS } from '../src/shared/timecard.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-timecard-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('agent-office-timecard-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A clock the test moves by hand, starting at 9:00 local time. */
function clock(start = new Date(2026, 8, 28, 9, 0).getTime()) {
  let now = start;
  return { now: () => now, at: (ms: number) => (now = ms), add: (ms: number) => (now += ms) };
}

const me = timeCardKey('acct-1', 'Michael');

test('the first window clocks in, the last one clocks out, and tabs in between do not', t => {
  const c = clock();
  const card = new TimeCard(fixture(t), c.now);
  card.join(me, 'Michael');
  c.add(10 * MIN);
  card.join(me, 'Michael'); // a second tab
  c.add(20 * MIN);
  card.leave(me); // closes one tab: still in
  assert.equal(card.state(me).open, true);
  c.add(30 * MIN);
  card.leave(me);
  const s = card.state(me);
  assert.equal(s.open, false);
  assert.equal(s.name, 'Michael');
  assert.deepEqual(s.stints, [{ start: c.now() - HOUR, end: c.now() }]);
});

test('a reload within the grace carries on the stint; a real break starts a new one', t => {
  const c = clock();
  const card = new TimeCard(fixture(t), c.now);
  card.join(me, 'Michael');
  c.add(HOUR);
  card.leave(me);
  c.add(TIMECARD_GRACE_MS - 1000);
  card.join(me, 'Michael');
  assert.equal(card.state(me).stints.length, 1);
  c.add(HOUR);
  card.leave(me);
  c.add(TIMECARD_GRACE_MS + 1000);
  card.join(me, 'Michael');
  const s = card.state(me);
  assert.equal(s.stints.length, 2);
  assert.equal(s.stints[0].end - s.stints[0].start, 2 * HOUR + TIMECARD_GRACE_MS - 1000);
});

test('a crash ends the stint at the last tick, and a restart soon after carries it on', t => {
  const dir = fixture(t);
  const c = clock();
  const first = new TimeCard(dir, c.now);
  first.join(me, 'Michael');
  c.add(30 * MIN);
  first.tick();
  c.add(40 * 1000); // the office dies here, without a leave or a flush
  const second = new TimeCard(dir, c.now);
  const s = second.state(me);
  assert.equal(s.open, false);
  assert.equal(s.stints[0].end - s.stints[0].start, 30 * MIN);
  second.join(me, 'Michael'); // the browser reconnects
  c.add(MIN);
  assert.equal(second.state(me).stints.length, 1);
  assert.equal(second.state(me).open, true);
});

test('people keep their own cards; on the shared password the name is whose card it is', t => {
  const c = clock();
  const card = new TimeCard(fixture(t), c.now);
  const guest = timeCardKey(undefined, ' Sam ');
  assert.equal(guest, timeCardKey(undefined, 'sam'));
  card.join(me, 'Michael');
  card.join(guest, 'Sam');
  c.add(HOUR);
  card.leave(guest);
  assert.equal(card.state(me).open, true);
  assert.equal(card.state(guest).open, false);
  assert.deepEqual(card.state('name:nobody'), { name: '', stints: [], open: false });
});

test('an unreadable card is left as it was and nothing is recorded over it', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'timecard.json');
  writeFileSync(file, '{ not json');
  const card = new TimeCard(dir);
  card.join(me, 'Michael');
  card.leave(me);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.match(card.state(me).saveError ?? '', /could not be read/);
});

test('stints older than the keeping period are dropped when the card is saved', t => {
  const dir = fixture(t);
  const c = clock();
  const card = new TimeCard(dir, c.now);
  card.join(me, 'Michael');
  c.add(HOUR);
  card.leave(me);
  c.add(TIMECARD_KEEP_MS + HOUR);
  card.join(me, 'Michael');
  const saved = JSON.parse(readFileSync(path.join(dir, 'timecard.json'), 'utf8'));
  assert.equal(saved.people[me].stints.length, 1);
  assert.equal(saved.people[me].stints[0].start, c.now());
});

test('a stint over midnight counts on both days, and the week starts on Monday', () => {
  const late = new Date(2026, 8, 27, 22, 30).getTime(); // Sunday
  const early = new Date(2026, 8, 28, 1, 15).getTime(); // Monday
  const days = timeDays([{ start: late, end: early }]);
  assert.deepEqual(days.map(d => [d.day, hoursText(d.ms)]), [['2026-09-28', '1h 15m'], ['2026-09-27', '1h 30m']]);
  assert.equal(startOfWeek(early), new Date(2026, 8, 28).getTime());
  assert.equal(startOfWeek(late), new Date(2026, 8, 21).getTime());
  assert.equal(timeBetween([{ start: late, end: early }], startOfWeek(early), early), 75 * MIN);
  assert.equal(dayKey(early), '2026-09-28');
});

test('an open stint runs to now on the card', () => {
  const start = new Date(2026, 8, 28, 9, 0).getTime();
  const card = { stints: [{ start: start - 3 * HOUR, end: start - 2 * HOUR }, { start, end: start + MIN }], open: true };
  const live = liveStints(card, start + 2 * HOUR);
  assert.equal(live[0].end, start - 2 * HOUR);
  assert.equal(live[1].end, start + 2 * HOUR);
  assert.equal(hoursText(12 * MIN), '12m');
});
