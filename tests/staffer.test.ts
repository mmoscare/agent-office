import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { STATION_AGENT, stationLabel } from '../src/shared/layout.js';
import { STAFFER_BESIDE, StafferSummon, stepOnto, summonSpot, type StafferModel } from '../src/client/world/staffer.js';

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
  const spot = summonSpot({ x: 2, z: 3 }, 0);
  assert.ok(Math.hypot(spot.x - 2, spot.z - 4.25) < 0.01);

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
