import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building } from '../src/server/building.js';
import { listLocalFolders, localFolder, localFolderKey } from '../src/server/local-folders.js';
import { MAX_FLOORS } from '../src/shared/floors.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'office local floors '));
  const data = path.join(root, 'office');
  const project = path.join(root, 'my project');
  mkdirSync(data); mkdirSync(project);
  // This fixture contains only directories and files created by the test.
  const clean = (dir: string) => {
    assert.ok(path.resolve(dir).startsWith(root + path.sep) || path.resolve(dir) === root);
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) clean(file);
      else if (item.isSymbolicLink() && process.platform === 'win32') rmdirSync(file);
      else unlinkSync(file);
    }
    rmdirSync(dir);
  };
  return { root, data, project, close: () => clean(root) };
}

test('opens an existing multi-repository folder in place and persists it without changing project files', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.project, 'frontend')); mkdirSync(path.join(f.project, 'backend'));
    writeFileSync(path.join(f.project, 'notes.txt'), 'keep my work');
    const building = new Building(f.data, path.join(f.root, 'clones'));
    const def = building.addLocal(`"${f.project}"`, 'Owner');
    assert.ok(typeof def !== 'string');
    assert.equal(def.name, 'my project');
    assert.equal(localFolderKey(def.dir), localFolderKey(f.project));
    assert.equal(def.repo, undefined);
    assert.equal(readFileSync(path.join(f.project, 'notes.txt'), 'utf8'), 'keep my work');
    assert.deepEqual(readdirSync(f.project).sort(), ['backend', 'frontend', 'notes.txt']);
    assert.equal(new Building(f.data, f.root).list()[0].id, def.id);
    assert.equal(building.addLocal(path.join(f.project, '.'), 'Owner'), def);
    if (process.platform === 'win32') assert.equal(building.addLocal(f.project.toUpperCase(), 'Owner'), def);
    assert.equal(building.list().length, 1);
  } finally { f.close(); }
});

test('folder browser lists only directories and supports parent navigation and pasted paths', async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.project, 'Zebra')); mkdirSync(path.join(f.project, 'Alpha'));
    writeFileSync(path.join(f.project, 'private.txt'), 'not returned by the browser');
    const result = await listLocalFolders(f.project);
    assert.deepEqual(result.folders.map(d => d.name), ['Alpha', 'Zebra']);
    assert.equal(localFolderKey(result.parent!), localFolderKey(f.root));
    assert.equal(localFolder(`"${f.project}"`), result.dir);
    assert.throws(() => localFolder('relative/folder'), /full folder path/);
    assert.throws(() => localFolder(path.join(f.project, 'private.txt')), /not a file/);
    assert.throws(() => localFolder(path.join(f.project, 'missing')), /could not be opened/);
    assert.throws(() => localFolder({ dir: f.project }), /full folder path/);
    assert.throws(() => localFolder(f.project + '\0'), /full folder path/);
  } finally { f.close(); }
});

test('directory aliases reuse the existing floor', () => {
  const f = fixture();
  const alias = path.join(f.root, 'alias');
  try {
    symlinkSync(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const building = new Building(f.data, f.root);
    const def = building.addLocal(f.project, 'Owner');
    assert.equal(building.addLocal(alias, 'Owner'), def);
    assert.equal(building.list().length, 1);
  } finally { f.close(); }
});

test('new local floors respect capacity, while existing floors remain reusable', () => {
  const f = fixture();
  try {
    const saved = Array.from({ length: MAX_FLOORS }, (_, i) => ({ id: `floor-${i}`, dir: path.join(f.root, `floor-${i}`) }));
    writeFileSync(path.join(f.data, 'floors.json'), JSON.stringify(saved));
    const building = new Building(f.data, f.root);
    assert.match(building.addLocal(f.project, 'Owner') as string, /building is full/);
    assert.equal(building.list().length, MAX_FLOORS);
  } finally { f.close(); }
});

test('a failed save does not report a floor as added', () => {
  const f = fixture();
  try {
    const building = new Building(path.join(f.data, 'missing'), f.root);
    assert.match(building.addLocal(f.project, 'Owner') as string, /could not be saved/);
    assert.equal(building.list().length, 0);
    assert.ok(statSync(f.project).isDirectory());
  } finally { f.close(); }
});

test('Backoffice placement survives reloads, and reopening an existing folder does not move it', () => {
  const f = fixture();
  try {
    const building = new Building(f.data, f.root);
    const def = building.addLocal(f.project, 'Owner', 'backoffice');
    assert.ok(typeof def !== 'string');
    assert.equal(def.section, 'backoffice');
    assert.equal(building.addLocal(f.project, 'Owner'), def);
    assert.equal(def.section, 'backoffice');
    const reloaded = new Building(f.data, f.root);
    assert.equal(reloaded.list()[0].section, 'backoffice');
    assert.equal(reloaded.setSection(def.id, 'main'), undefined);
    assert.equal(new Building(f.data, f.root).list()[0].section, 'main');
    assert.equal(reloaded.list()[0].dir, def.dir);
    assert.equal(reloaded.list()[0].id, def.id);
    assert.equal(reloaded.setSection('missing', 'backoffice'), 'No such floor');
    assert.match(reloaded.setSection(def.id, 'invalid')!, /Choose/);
  } finally { f.close(); }
});

test('legacy floor placement defaults to main and failed moves roll back', () => {
  const f = fixture();
  try {
    const file = path.join(f.data, 'floors.json');
    writeFileSync(file, JSON.stringify([{ id: 'legacy', dir: f.project }, { id: 'invalid', dir: f.project, section: 'unknown' }]));
    const building = new Building(f.data, f.root);
    assert.deepEqual(building.list().map(d => d.section), ['main', 'main']);
    // Make the persistence target unwritable without depending on OS permission semantics.
    unlinkSync(file);
    mkdirSync(file);
    assert.match(building.setSection('legacy', 'backoffice')!, /could not be saved/);
    assert.equal(building.list()[0].section, 'main');
  } finally { f.close(); }
});
