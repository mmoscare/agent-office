import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BALCONY, BALCONY_DOOR, FLOOR, GOLF_TEE, KIOSK, LOFT, STAIRS, STATIONS, STATION_AGENT, stationLabel } from '../src/shared/layout.js';
import { deskPoint, walkable } from '../src/shared/nav.js';
import { STAFFER_BESIDE, StafferSummon, stepOnto, summonSpot, type Footing, type StafferModel } from '../src/client/world/staffer.js';
import { wayTo, zoneOf } from '../src/client/walkto.js';
import { Departures } from '../src/client/world/leaving.js';
import type { Worker } from '../src/client/world/character.js';
import type { Laptop } from '../src/client/world/laptop.js';
import type { DeskView } from '../src/client/world/office.js';

test('the queue agent keeps his name and wears staffer/queue agent on the label', () => {
  assert.equal(STATION_AGENT.queue.name, 'Queue agent');
  assert.equal(STATION_AGENT.queue.label, 'staffer/queue agent');
  assert.equal(stationLabel('queue'), 'staffer/queue agent');
  assert.equal(stationLabel('issues'), 'Issues agent');
  assert.equal(stationLabel('inbox'), 'Receptionist');
});

function agent(parent: THREE.Object3D): StafferModel {
  const root = new THREE.Group();
  parent.add(root);
  return { root, walking: false, stopDancing() {} };
}

test('U walks him to the spot in front of you, and again beside him sends him back', () => {
  const home = new THREE.Group();
  home.position.set(-7.8, 0, -8);
  const office = new THREE.Group();
  const steps: number[] = [];
  const staffer = new StafferSummon(office, () => 0, () => steps.push(1));
  const model = agent(home);
  const spot = summonSpot([], { x: 2, y: 0, z: 3 }, 0);
  assert.ok(spot);
  assert.ok(Math.hypot(spot.x - 2, spot.z - 4.25) < 0.01);
  assert.equal(spot.y, 0);

  assert.equal(staffer.call(model, [{ x: spot.x, z: spot.z }], 'to'), 'coming');
  assert.equal(model.root.parent, office);
  for (let i = 0; i < 80; i++) staffer.update(0.1);
  assert.equal(staffer.phase, 'here');
  assert.ok(Math.hypot(model.root.position.x - spot.x, model.root.position.z - spot.z) < 0.05);
  assert.ok(steps.length > 0, 'he takes footsteps on the way');
  assert.equal(model.walking, false);

  const kiosk = staffer.kioskAt();
  assert.ok(kiosk);
  assert.ok(Math.hypot(kiosk.x - home.position.x, kiosk.z - home.position.z) < 0.01);
  assert.equal(staffer.call(model, [kiosk], 'back'), 'back');
  for (let i = 0; i < 80; i++) staffer.update(0.1);
  assert.equal(staffer.phase, 'home');
  assert.equal(model.root.parent, home);
  assert.equal(model.root.position.x, 0);
  assert.equal(model.root.scale.x, 1);
});

test('calling him again while he is still on the way retargets, and does not send him back', () => {
  const home = new THREE.Group();
  const office = new THREE.Group();
  const staffer = new StafferSummon(office, () => 0, () => {});
  const model = agent(home);
  staffer.call(model, [{ x: 10, z: 0 }], 'to');
  staffer.update(0.2);
  assert.equal(staffer.phase, 'to');
  assert.ok(Math.hypot(model.root.position.x, model.root.position.z) < STAFFER_BESIDE);
  staffer.call(model, [{ x: 0, z: 8 }], 'to');
  for (let i = 0; i < 40; i++) staffer.update(0.1);
  assert.equal(staffer.phase, 'here');
  assert.ok(Math.hypot(model.root.position.x, model.root.position.z - 8) < 0.05);
  assert.equal(model.root.parent, office);
});

test('a floor change puts him back on the kiosk', () => {
  const home = new THREE.Group();
  const office = new THREE.Group();
  const staffer = new StafferSummon(office, () => 0, () => {});
  const model = agent(home);
  staffer.call(model, [{ x: 4, z: 4 }], 'to');
  staffer.clear();
  assert.equal(staffer.phase, 'home');
  assert.equal(model.root.parent, home);
  assert.equal(model.walking, false);
});

test('he climbs a step and does not fall through the loft onto the floor below', () => {
  const floor = { minX: -20, maxX: 20, minZ: -20, maxZ: 20, top: 0 };
  const step = { minX: 0, maxX: 1, minZ: -1, maxZ: 1, top: 0.2 };
  const loft = { minX: 5, maxX: 12, minZ: 5, maxZ: 12, top: 3 };
  assert.equal(stepOnto([floor, step], 0.5, 0, 0), 0.2);
  assert.equal(stepOnto([floor, loft], 8, 8, 3), 3);
  assert.equal(stepOnto([floor, { ...floor, fence: true, top: 1.5 }], 0, 0, 0), 0);
});

// ---- Where he comes to stand: on your own floor --------------------------------------------------

const QUEUE = STATIONS.find((s) => s.station === 'queue')!;
/** Where he stands at his kiosk, behind its counter. */
const [kx, kz] = deskPoint(QUEUE, 0, KIOSK.stand);
const KIOSK_AT = { x: kx, y: 0, z: kz };
/** The golf bag leaning on the wall by the balcony doors, as world/golf.ts puts it. */
const BAG: Footing = { minX: GOLF_TEE.bag.x - 0.2, maxX: GOLF_TEE.bag.x + 0.2, minZ: BALCONY.minZ, maxZ: GOLF_TEE.bag.z + 0.2, top: 1 };

/**
 * The parts of the building the summon cares about, as world/office.ts builds them: the office floor,
 * the loft with glass on its north and west sides (open at the top of the stairs) and the stairs up to
 * it, and the balcony with the railing round its three open sides and the golf bag.
 */
function building(): Footing[] {
  const c: Footing[] = [{ minX: FLOOR.minX, maxX: FLOOR.maxX, minZ: FLOOR.minZ, maxZ: FLOOR.maxZ, top: 0 }];
  c.push({ minX: LOFT.minX, maxX: LOFT.maxX, minZ: LOFT.minZ, maxZ: LOFT.maxZ, bottom: LOFT.y - 0.25, top: LOFT.y });
  c.push({ minX: LOFT.minX, maxX: LOFT.maxX, minZ: LOFT.minZ, maxZ: LOFT.minZ + 0.12, bottom: LOFT.y, top: 99 });
  c.push({ minX: LOFT.minX, maxX: LOFT.minX + 0.12, minZ: LOFT.minZ, maxZ: STAIRS.minZ, bottom: LOFT.y, top: 99 });
  const run = (STAIRS.toX - STAIRS.fromX) / STAIRS.steps;
  for (let i = 1; i <= STAIRS.steps; i++) c.push({ minX: STAIRS.fromX + (i - 1) * run, maxX: STAIRS.fromX + i * run, minZ: STAIRS.minZ, maxZ: STAIRS.maxZ, top: (i * LOFT.y) / STAIRS.steps });
  const { minX, maxX, minZ, maxZ } = BALCONY;
  c.push({ minX, maxX, minZ, maxZ, bottom: -0.3, top: 0 });
  c.push({ minX, maxX, minZ: maxZ - 0.11, maxZ: maxZ - 0.01, bottom: -0.3, top: 99 });
  c.push({ minX: minX + 0.01, maxX: minX + 0.11, minZ, maxZ, bottom: -0.3, top: 99 });
  c.push({ minX: maxX - 0.11, maxX: maxX - 0.01, minZ, maxZ, bottom: -0.3, top: 99 });
  c.push(BAG);
  return c;
}

/** Calls him from the kiosk to `spot` and lets him walk there. */
function summonTo(colliders: Footing[], spot: { x: number; y: number; z: number }) {
  const home = new THREE.Group();
  home.position.set(KIOSK_AT.x, 0, KIOSK_AT.z);
  const staffer = new StafferSummon(new THREE.Group(), (x, z, y) => stepOnto(colliders, x, z, y), () => {});
  const model = agent(home);
  const way = wayTo(KIOSK_AT, spot);
  staffer.call(model, way, 'to');
  for (let i = 0; i < 600 && staffer.phase !== 'here'; i++) staffer.update(0.1);
  return { staffer, way, at: model.root.position };
}

/** Whether a walk along `way` comes within `pad` of the box, a few centimetres at a time. */
function walksInto(way: { x: number; z: number }[], box: Footing, pad: number): boolean {
  for (let i = 1; i < way.length; i++) {
    const [a, b] = [way[i - 1], way[i]];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.03);
    for (let j = 0; j <= n; j++) {
      const x = a.x + ((b.x - a.x) * j) / n;
      const z = a.z + ((b.z - a.z) * j) / n;
      if (x > box.minX - pad && x < box.maxX + pad && z > box.minZ - pad && z < box.maxZ + pad) return true;
    }
  }
  return false;
}

test('at the loft edge, facing out through the glass, he comes up to the loft beside you, not the floor below', () => {
  const colliders = building();
  const at = { x: LOFT.minX + 0.45, y: LOFT.y, z: 9.5 };
  const west = -Math.PI / 2;
  // Straight in front of you is out through the glass, over the office floor three meters down.
  assert.equal(zoneOf({ x: at.x - 1.25, y: at.y, z: at.z }), 'floor');
  const spot = summonSpot(colliders, at, west);
  assert.ok(spot);
  assert.equal(spot.y, LOFT.y);
  assert.equal(zoneOf(spot), 'loft');
  assert.ok(spot.x > LOFT.minX + 0.12 + 0.28, `clear of the glass: ${spot.x}`);
  // Beside you, so U there sends him back rather than calling him again.
  assert.ok(Math.hypot(spot.x - at.x, spot.z - at.z) < STAFFER_BESIDE);
  const { staffer, at: p } = summonTo(colliders, spot);
  assert.equal(staffer.phase, 'here');
  assert.ok(Math.hypot(p.x - spot.x, p.z - spot.z) < 0.05);
  assert.ok(Math.abs(p.y + 0.07 - LOFT.y) < 0.05, `up on the loft floor, not at ${p.y.toFixed(2)}`);
});

test('at the balcony railing, facing out, he stands on the deck beside you, not out in the air', () => {
  const colliders = building();
  const at = { x: BALCONY_DOOR.u, y: 0, z: BALCONY.maxZ - 0.5 };
  // Straight in front of you is past the railing, with nothing under him.
  assert.ok(at.z + 1.25 > BALCONY.maxZ);
  const spot = summonSpot(colliders, at, 0);
  assert.ok(spot);
  assert.equal(spot.y, 0);
  assert.equal(zoneOf(spot), 'balcony');
  assert.ok(spot.z < BALCONY.maxZ - 0.11 - 0.28 && spot.x > BALCONY.minX + 0.11 + 0.28 && spot.x < BALCONY.maxX - 0.11 - 0.28, `inside the railing: ${spot.x}, ${spot.z}`);
  assert.ok(Math.hypot(spot.x - at.x, spot.z - at.z) < STAFFER_BESIDE);
  const { staffer, at: p } = summonTo(colliders, spot);
  assert.equal(staffer.phase, 'here');
  assert.ok(Math.hypot(p.x - spot.x, p.z - spot.z) < 0.05);
  assert.ok(Math.abs(p.y + 0.07) < 0.05, `on the deck, not at ${p.y.toFixed(2)}`);
});

test('on the balcony he stands clear of the golf bag, and his way out there goes round it', () => {
  const colliders = building();
  // By the bag, facing it and the wall behind.
  const at = { x: GOLF_TEE.bag.x, y: 0, z: 14.6 };
  const spot = summonSpot(colliders, at, Math.PI);
  assert.ok(spot);
  assert.equal(zoneOf(spot), 'balcony');
  const way = wayTo(KIOSK_AT, spot);
  const outside = way.findIndex((p) => p.z > FLOOR.maxZ);
  assert.ok(outside > 0);
  assert.ok(!walksInto([...way.slice(outside), spot], BAG, 0.2), `not through the bag: ${JSON.stringify(way.slice(outside))}`);
});

test('on the office floor by the balcony doors, facing out, he stays in the room with you', () => {
  const at = { x: BALCONY_DOOR.u, y: 0, z: FLOOR.maxZ - 0.6 };
  // Straight in front of you is out on the balcony.
  assert.equal(zoneOf({ x: at.x, y: 0, z: at.z + 1.25 }), 'balcony');
  const spot = summonSpot(building(), at, 0);
  assert.ok(spot);
  assert.equal(spot.y, 0);
  assert.equal(zoneOf(spot), 'floor');
  assert.ok(walkable(spot.x, spot.z));
});

test('with no room round you, he still comes to the floor you are on', () => {
  const at = { x: LOFT.minX + 0.6, y: LOFT.y, z: 10 };
  const wall = (minX: number, maxX: number, minZ: number, maxZ: number): Footing => ({ minX: at.x + minX, maxX: at.x + maxX, minZ: at.z + minZ, maxZ: at.z + maxZ, bottom: LOFT.y, top: LOFT.y + 1 });
  const boxedIn = [wall(-0.6, -0.5, -0.6, 0.6), wall(0.5, 0.6, -0.6, 0.6), wall(-0.6, 0.6, -0.6, -0.5), wall(-0.6, 0.6, 0.5, 0.6)];
  const spot = summonSpot([...building(), ...boxedIn], at, -Math.PI / 2);
  assert.ok(spot);
  assert.equal(spot.y, LOFT.y);
  assert.equal(zoneOf(spot), 'loft');
});

test('outside the building he does not come', () => {
  assert.equal(summonSpot(building(), { x: FLOOR.minX - 1, y: 0, z: 6.5 }, 0), null);
});

// ---- Sent home while he's away from his kiosk --------------------------------------------------

test('sent home while he is over by you, he packs up there and walks back past his kiosk and out, without flying', () => {
  const colliders = building();
  // What's underfoot, and the street out past the building.
  const ground = (x: number, z: number, y: number) => {
    let g = -3;
    for (const c of colliders) if (c.top < 50 && y >= c.top - 0.1 && c.top > g && x > c.minX - 0.28 && x < c.maxX + 0.28 && z > c.minZ - 0.28 && z < c.maxZ + 0.28) g = c.top;
    return g;
  };
  const scene = new THREE.Group();
  const office = new THREE.Group();
  const model = { root: new THREE.Group(), walking: false, stopDancing() {}, leave() {}, say() {}, update() {}, dispose() {} };
  office.add(model.root);
  model.root.position.set(4, -0.07, 4);
  const laptop = { root: new THREE.Group(), shut: () => true, dispose() {} };
  const desk = { def: QUEUE, chair: null } as unknown as DeskView;
  let up = 0;
  const departures = new Departures(scene, ground, () => {}, () => up++, () => false);
  departures.add(model as unknown as Worker, laptop as unknown as Laptop, desk, true);
  assert.equal(model.root.parent, scene);
  const dt = 1 / 30;
  const start = model.root.position.clone();
  let stride = 0;
  let byKiosk = Infinity;
  for (let t = 0; t < 90 && model.root.parent; t += dt) {
    const was = model.root.position.clone();
    departures.update(dt, t);
    const p = model.root.position;
    stride = Math.max(stride, Math.hypot(p.x - was.x, p.z - was.z));
    byKiosk = Math.min(byKiosk, Math.hypot(p.x - QUEUE.x, p.z - QUEUE.z));
    if (t < 1.4) assert.ok(Math.hypot(p.x - start.x, p.z - start.z) < 0.01, 'he packs up where he stands');
  }
  assert.ok(stride <= 2.3 * dt + 1e-6, `a walking stride a frame at most, not ${stride.toFixed(2)} m`);
  assert.ok(byKiosk < 2, 'back past his kiosk on the way out');
  assert.equal(model.root.parent, null, 'out of the building and gone');
  assert.equal(up, 1);
});
