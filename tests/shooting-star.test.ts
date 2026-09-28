import test from 'node:test';
import assert from 'node:assert/strict';
import { METEOR_LOWEST, alongPath, meteorAt, planMeteor } from '../src/client/world/shooting-star.js';

/** The same run of "random" numbers every time. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('every shooting star slants down the sky and burns out above the roofs', () => {
  const rand = seeded(7);
  for (let i = 0; i < 500; i++) {
    const m = planMeteor(rand);
    assert.ok(Math.abs(m.from.length() - 1) < 1e-6 && Math.abs(m.toward.length() - 1) < 1e-6);
    assert.ok(Math.abs(m.from.dot(m.toward)) < 1e-6, 'heads along the sky, not into it');
    assert.ok(m.toward.y < 0, 'falls');
    assert.ok(m.tail > 0 && m.tail <= m.arc, 'its tail is no longer than its path');
    assert.ok(m.secs >= 0.8 && m.secs <= 1.4);
    for (let k = 0; k <= 10; k++) assert.ok(alongPath(m, (m.arc * k) / 10).y >= Math.sin(METEOR_LOWEST) - 1e-9, `meteor ${i} stays above the roofs`);
  }
});

test('it flares up, moves on, and burns out with its tail behind its head', () => {
  const m = planMeteor(seeded(3));
  assert.equal(meteorAt(m, 0).glow, 0);
  assert.equal(meteorAt(m, 1).glow, 0);
  assert.ok(meteorAt(m, 0.4).glow > 0.9);
  let last = -1;
  for (let p = 0; p <= 1; p += 0.05) {
    const { head, tip, glow } = meteorAt(m, p);
    assert.ok(head >= last, 'never goes backwards');
    assert.ok(tip >= 0 && tip <= head);
    assert.ok(glow >= 0 && glow <= 1);
    last = head;
  }
  assert.ok(Math.abs(meteorAt(m, 1).head - m.arc) < 1e-9, 'ends where its path does');
});
