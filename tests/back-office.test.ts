import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building } from '../src/server/building.js';
import { backOfficeFloors, floorNumber, mainFloors } from '../src/shared/floors.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'office back office '));
  const data = path.join(root, 'office');
  const a = path.join(root, 'alpha');
  const b = path.join(root, 'beta');
  mkdirSync(data); mkdirSync(a); mkdirSync(b);
  return { root, data, a, b, close: () => rmSync(root, { recursive: true, force: true }) };
}

const saved = (data: string) => JSON.parse(readFileSync(path.join(data, 'floors.json'), 'utf8')) as Record<string, unknown>[];

test('a floor added into the Back Office is saved and reloaded with the flag', () => {
  const f = fixture();
  try {
    const building = new Building(f.data, f.root);
    const main = building.addLocal(f.a, 'Owner');
    const back = building.addLocal(f.b, 'Owner', true);
    assert.ok(typeof main !== 'string' && typeof back !== 'string');
    assert.equal(main.backOffice, undefined);
    assert.equal(back.backOffice, true);
    // Main floors keep floors.json as it was: no field at all.
    assert.deepEqual(saved(f.data).map((d) => d.backOffice), [undefined, true]);
    const again = new Building(f.data, f.root).list();
    assert.deepEqual(again.map((d) => [d.id, !!d.backOffice]), [[main.id, false], [back.id, true]]);
  } finally { f.close(); }
});

test('an older floors.json without the field loads every floor on the main list', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.data, 'floors.json'), JSON.stringify([
      { id: 'alpha', name: 'alpha', dir: f.a, palette: 0, addedBy: 'Owner', addedAt: 1 },
      { id: 'beta', name: 'beta', dir: f.b, palette: 1, addedBy: 'Owner', addedAt: 2, backOffice: 'yes' },
    ]));
    const list = new Building(f.data, f.root).list();
    assert.equal(list.length, 2);
    assert.ok(list.every((d) => !d.backOffice));
  } finally { f.close(); }
});

test('moving a floor to the Back Office and back flips and persists the flag', () => {
  const f = fixture();
  try {
    const building = new Building(f.data, f.root);
    const def = building.addLocal(f.a, 'Owner');
    assert.ok(typeof def !== 'string');
    assert.equal(building.setBackOffice(def.id, true), def);
    assert.equal(new Building(f.data, f.root).list()[0].backOffice, true);
    assert.equal(building.setBackOffice(def.id, false), def);
    assert.equal(def.backOffice, undefined);
    assert.equal(new Building(f.data, f.root).list()[0].backOffice, undefined);
    assert.equal(building.setBackOffice('nope', true), 'No such floor');
  } finally { f.close(); }
});

test('the panels number main floors 1, 2, … and Back Office floors B1, B2, …', () => {
  const floors = [{ id: 'a' }, { id: 'b', backOffice: true }, { id: 'c' }, { id: 'd', backOffice: true }];
  assert.deepEqual(mainFloors(floors).map((f) => f.id), ['a', 'c']);
  assert.deepEqual(backOfficeFloors(floors).map((f) => f.id), ['b', 'd']);
  assert.deepEqual(floors.map((f) => floorNumber(floors, f.id)), ['1', 'B1', '2', 'B2']);
  assert.equal(floorNumber(floors, 'missing'), '');
});
