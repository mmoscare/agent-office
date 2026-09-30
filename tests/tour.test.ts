import test from 'node:test';
import assert from 'node:assert/strict';
import { SeatTour, type TourSeat } from '../src/client/tour.js';
import { LOFT, OFFICE_SPOT } from '../src/shared/layout.js';

const seats: TourSeat[] = [
  { id: 'east', x: 4, z: 0 },
  { id: 'north', x: 0, z: -6 },
  { id: 'west', x: -5, z: 0 },
];

test('T starts at the nearest waiting seat, then goes clockwise, then back to the office', () => {
  const tour = new SeatTour();
  const here = { x: 1, z: -1 };
  assert.deepEqual(tour.next(seats, here), { kind: 'seat', id: 'east', n: 1, of: 3 });
  assert.deepEqual(tour.next(seats, here), { kind: 'seat', id: 'north', n: 2, of: 3 });
  assert.deepEqual(tour.next(seats, here), { kind: 'seat', id: 'west', n: 3, of: 3 });
  assert.deepEqual(tour.next(seats, here), { kind: 'office', waiting: true });
  assert.equal(tour.active, false);
  assert.deepEqual(tour.next(seats, here), { kind: 'seat', id: 'east', n: 1, of: 3 });
});

test('the first seat is the one next to you', () => {
  const tour = new SeatTour();
  assert.deepEqual(tour.next(seats, { x: -4, z: 0.2 }), { kind: 'seat', id: 'west', n: 1, of: 3 });
});

test("T skips the worker you're already behind, and a lone one sends you back to the office", () => {
  const beside = new SeatTour();
  const step = beside.next(seats, { x: 4, z: 0 }, 'east');
  assert.equal(step.kind, 'seat');
  if (step.kind === 'seat') {
    assert.notEqual(step.id, 'east');
    assert.equal(step.n, 1);
    assert.equal(step.of, 2);
  }
  assert.deepEqual(new SeatTour().next([{ id: 'only', x: 1, z: 1 }], { x: 1, z: 1 }, 'only'), { kind: 'office', waiting: true });
});

test('nobody waiting stays put; a worker that finishes drops out of the circle', () => {
  assert.deepEqual(new SeatTour().next([], { x: 0, z: 0 }), { kind: 'office', waiting: false });
  const tour = new SeatTour();
  assert.equal((tour.next(seats, { x: 1, z: -1 }) as { id: string }).id, 'east');
  const left = seats.filter((s) => s.id !== 'north');
  const step = tour.next(left, { x: 0, z: 0 });
  assert.deepEqual(step, { kind: 'seat', id: 'west', n: 2, of: 2 });
  assert.deepEqual(tour.next(left, { x: 0, z: 0 }), { kind: 'office', waiting: true });
});

test('a circle that loses everyone still ends at the office, and reset starts over beside you', () => {
  const tour = new SeatTour();
  tour.next(seats, { x: 1, z: -1 });
  assert.deepEqual(tour.next([], { x: 1, z: -1 }), { kind: 'office', waiting: true });
  tour.next(seats, { x: -4, z: 0 });
  tour.reset();
  assert.deepEqual(tour.next(seats, { x: -4, z: 0 }), { kind: 'seat', id: 'west', n: 1, of: 3 });
});

test('the office spot stands in the boss office, clear of the desk and the glass', () => {
  assert.ok(OFFICE_SPOT.x > LOFT.minX + 0.5 && OFFICE_SPOT.x < LOFT.maxX - 0.5);
  assert.ok(OFFICE_SPOT.z > LOFT.minZ + 0.5 && OFFICE_SPOT.z < LOFT.maxZ - 0.5);
  assert.equal(OFFICE_SPOT.y, LOFT.y);
  const desk = { minX: 12.7, maxX: 15.3, minZ: 9.6, maxZ: 10.8 };
  assert.ok(OFFICE_SPOT.x < desk.minX - 0.4 || OFFICE_SPOT.z < desk.minZ - 0.4);
});
