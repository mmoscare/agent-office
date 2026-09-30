import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_WITHIN_MS, Heartbeat, PING_EVERY_MS } from '../src/client/heartbeat.js';
import { downFor } from '../src/client/ui/connection.js';

function clock() {
  let now = 1_000_000;
  return { now: () => now, pass: (ms: number) => (now += ms) };
}

test('an office that answers every ping never counts as gone', () => {
  const c = clock();
  const beat = new Heartbeat(c.now);
  for (let i = 0; i < 20; i++) {
    assert.equal(beat.tick(), 'ping');
    c.pass(50);
    beat.heard();
    c.pass(PING_EVERY_MS);
  }
});

test('an office that stops answering without hanging up counts as gone once a ping goes unanswered too long', () => {
  const c = clock();
  const beat = new Heartbeat(c.now);
  assert.equal(beat.tick(), 'ping');
  const ticks: string[] = [];
  for (let waited = PING_EVERY_MS; waited <= ANSWER_WITHIN_MS + PING_EVERY_MS; waited += PING_EVERY_MS) {
    c.pass(PING_EVERY_MS);
    ticks.push(beat.tick());
  }
  assert.equal(ticks.at(-1), 'dead');
  assert.ok(ticks.slice(0, -1).every((t) => t === 'wait'), ticks.join());
  // Found within about 20 seconds.
  assert.ok(ticks.length * PING_EVERY_MS <= 20_000);
});

test('a background tab whose timers the browser slows to once a minute does not look like a dead office', () => {
  const c = clock();
  const beat = new Heartbeat(c.now);
  for (let i = 0; i < 10; i++) {
    assert.equal(beat.tick(), 'ping');
    c.pass(80);
    beat.heard();
    c.pass(60_000);
  }
});

test('how long the office has been gone reads plainly', () => {
  assert.equal(downFor(0), '0s');
  assert.equal(downFor(42_400), '42s');
  assert.equal(downFor(185_000), '3m 05s');
  assert.equal(downFor(3_720_000), '1h 02m');
  assert.equal(downFor(-5), '0s');
});
