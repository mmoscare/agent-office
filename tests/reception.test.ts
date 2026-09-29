import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELEVATOR, ELEVATOR_FRONT, KIOSK, STATIONS, WHITEBOARD } from '../src/shared/layout.js';
import { route, walkable } from '../src/shared/nav.js';

const her = STATIONS.find((s) => s.station === 'inbox')!;

test('the Receptionist stands beside the whiteboard, facing the elevator doors', () => {
  assert.equal(her.freestanding, true, 'out on the floor, not against a wall');
  assert.equal(her.rotY, 0, 'she stands on the room side of her counter, facing north to the elevator');
  // In line with the elevator's doors, a few steps out from them.
  assert.ok(Math.abs(her.x - ELEVATOR.x) < ELEVATOR.doorWidth / 2, 'in line with the doors');
  assert.ok(her.z - KIOSK.depth / 2 - ELEVATOR_FRONT > 3, 'with room to step out of the elevator');
  // Beside the whiteboard's east end, level with it, not touching it (its feet reach 0.2 past the board).
  const boardEast = WHITEBOARD.x + WHITEBOARD.width / 2 + 0.2;
  const gap = her.x - KIOSK.width / 2 - boardEast;
  assert.ok(gap > 0 && gap < 1, `next to the whiteboard (a gap of ${gap.toFixed(2)} m)`);
  assert.ok(Math.abs(her.z - WHITEBOARD.z) < 0.5, 'level with it');
});

test('you walk straight out of the elevator up to her counter, and she steps out on the far side from the whiteboard', () => {
  // Her counter's front, where you stand to talk to her (rotY 0: toward the elevator).
  const front: [number, number] = [her.x, her.z - 1];
  assert.ok(walkable(...front), 'the spot in front of her counter is clear');
  const way = route([ELEVATOR.x, ELEVATOR_FRONT + 0.6], front);
  assert.equal(way.length, 2, 'a straight walk from the elevator doors');
  assert.ok(!walkable(her.x, her.z), 'her counter is in the way');
  assert.ok(!walkable(her.x, her.z + KIOSK.stand), 'so is she');
  // East of her there's floor; west is the whiteboard.
  assert.ok(walkable(her.x + KIOSK.width / 2 + 0.6, her.z + KIOSK.stand));
  assert.ok(!walkable(her.x - KIOSK.width / 2 - 0.3, her.z));
});
