// npm run build && node tests/stickies-ui.mjs [screenshot-dir]
// Reminder stickies in the built client: the four reminders hang on the north wall above the To Do
// board on every floor (the Content Kanban floor too), and pointing at one and pressing E edits it.
// Against a local WebSocket fixture that keeps the list the way the office does (with the built
// shared/stickies.js). No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { applySticky, checkStickyAction, presetStickies, STICKY_ZONE } from '../dist/server/shared/stickies.js';
import { hasContentKanban } from '../dist/server/shared/content-kanban.js';
import { BOARDS } from '../dist/server/shared/layout.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(codeDir, '.agent-office/stickies-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const floors = [
  { id: 'app', name: 'Agent Office', palette: 0 },
  { id: 'autonomous-dev-projects', name: 'Autonomous-Dev-Projects', palette: 6 },
  { id: 'other', name: 'Other Project', palette: 1 },
];
const info = (f) => ({ ...f, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, workers: 0, busy: 0, waiting: 0, attention: [] });
const view = (id) => ({
  floor: id, project: { name: floors.find((f) => f.id === id).name, dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers: [],
  issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
  queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
  meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
  jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
  content: hasContentKanban(id) ? [] : null,
});
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const send = (ws, msg) => ws.send(JSON.stringify(msg));
// One list for the whole building, like the office's stickies.json for someone seen for the first time.
let stickies = presetStickies(1);
const changes = [];
wss.on('connection', (ws, req) => {
  const floor = new URL(req.url, url).searchParams.get('floor') || 'app';
  send(ws, {
    t: 'welcome', you: 'test', peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null },
    me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 }, ...view(floor),
  });
  send(ws, { t: 'stickies', items: stickies });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'sticky') return;
    const change = checkStickyAction(msg.change);
    assert.ok(change, `a well-formed change: ${JSON.stringify(msg.change)}`);
    changes.push(change);
    stickies = [...applySticky(stickies, change)];
    for (const c of wss.clients) send(c, { t: 'stickies', items: stickies });
  });
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  await page.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).pathname === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } }) }));
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Every note and the + on the scene, in world space next to the issues / To Do board they hang over.
  const wall = () => page.evaluate(() => {
    const o = window.__office;
    o.scene.updateMatrixWorld(true);
    const at = (obj) => { const e = obj.matrixWorld.elements; return { x: e[12], y: e[13], z: e[14] }; };
    const shown = (obj) => { for (let p = obj; p; p = p.parent) if (!p.visible) return false; return true; };
    const board = o.office.boardMeshes.issues;
    const notes = [];
    let add = null;
    o.scene.traverse((obj) => {
      const it = obj.userData?.interact;
      if (it?.kind === 'sticky') notes.push({ id: it.stickyId, shown: shown(obj), ...at(obj) });
      if (it?.kind === 'stickyAdd') add = { shown: shown(obj), ...at(obj) };
    });
    return { board: { ...at(board), shown: shown(board), mode: o.issuesWall().mode }, notes, add, texts: o.store.stickies.map((s) => s.text), floor: o.store.floor };
  });
  const checkFloor = async (id, count = 4) => {
    if (!page.url().startsWith(url)) await page.goto(url);
    await page.evaluate((floor) => localStorage.setItem('agent-office.floor', floor), id);
    await page.reload();
    await page.waitForFunction(() => window.__office?.store?.stickies?.length > 0);
    await page.waitForFunction((count) => { let n = 0; window.__office.scene.traverse((o) => { if (o.userData?.interact?.kind === 'sticky') n++; }); return n === count; }, count);
    const w = await wall();
    assert.equal(w.floor, id);
    assert.deepEqual(w.texts.slice(0, 4), presetStickies(1).map((s) => s.text), `${id}: the four reminders`);
    assert.equal(w.board.shown, true);
    assert.equal(w.board.mode, 'todo', `${id}: the board under them shows the To Do list`);
    assert.equal(w.notes.length, count);
    // The board is 6 m wide and 3 m tall, centered 2.1 m up: the notes hang in the strip over it (the
    // four reminders in a row right above it), on the same wall.
    const presets = new Set(presetStickies(1).map((s) => s.id));
    for (const n of w.notes) {
      assert.equal(n.shown, true, `${id}: ${n.id} is on the wall`);
      const along = n.x - w.board.x + BOARDS.issues.x;
      assert.ok(along > STICKY_ZONE.u0 && along < STICKY_ZONE.u1, `${id}: ${n.id} is in the strip by the board (u ${along})`);
      if (presets.has(n.id)) assert.ok(Math.abs(n.x - w.board.x) < 3.2, `${id}: ${n.id} is over the board (x ${n.x} vs ${w.board.x})`);
      assert.ok(n.y - w.board.y > 1.5 && n.y - w.board.y < 4.4, `${id}: ${n.id} is above the board, under the ceiling (dy ${n.y - w.board.y})`);
      assert.ok(Math.abs(n.z - w.board.z) < 0.2, `${id}: ${n.id} is on the board's wall (z ${n.z} vs ${w.board.z})`);
    }
    assert.ok(w.add?.shown && Math.abs(w.add.x - w.board.x) < 3.5 && Math.abs(w.add.z - w.board.z) < 0.2, `${id}: the + is beside them`);
    return w;
  };
  // Stand in front of a note (or the +, with no id) in first person and look straight at it.
  const aimAt = async (stickyId, hint) => {
    const at = await page.evaluate((id) => {
      let e;
      window.__office.scene.traverse((obj) => {
        const it = obj.userData?.interact;
        if (id ? it?.stickyId === id : it?.kind === 'stickyAdd') e = obj.matrixWorld.elements;
      });
      return { x: e[12], y: e[13], z: e[14] };
    }, stickyId);
    await page.evaluate((at) => {
      const p = window.__office.player;
      p.setView('first');
      p.pos.set(at.x, 0, at.z + 5.4);
      p.camYaw = 0;
      p.lookPitch = 0.6;
    }, at);
    // Pitch the view straight at it from wherever the eyes are, again while the view settles (a
    // software-rendered page draws only a few frames a second), until the hint names it.
    for (let tries = 0; ; tries++) {
      await page.waitForTimeout(600);
      await page.evaluate((at) => {
        const eye = window.__office.camera.matrixWorld.elements;
        window.__office.player.lookPitch = Math.atan2(at.y - eye[13], eye[14] - at.z);
      }, at);
      try {
        await page.waitForFunction((text) => document.querySelector('#hint')?.textContent?.includes(text), hint, { timeout: 3000 });
        return;
      } catch (err) {
        if (tries >= 5) throw err;
      }
    }
  };
  const aimAtFirstNote = () => aimAt('post45times', 'POST 4-5 TIMES A DAY');

  const seen = {};
  for (const f of floors) seen[f.id] = await checkFloor(f.id);
  // The office's scene is one for all floors, so they hang in the very same spot on each.
  for (const f of floors.slice(1)) assert.deepEqual(seen[f.id].notes.map(({ id, x, z }) => ({ id, x, z })), seen.app.notes.map(({ id, x, z }) => ({ id, x, z })));

  // Point at a note: the hint names it, and E opens its editor.
  await checkFloor('app');
  await aimAtFirstNote();
  await page.screenshot({ path: path.join(screenshotDir, 'stickies-app.png') });
  await page.keyboard.press('e');
  const editor = page.getByRole('dialog', { name: 'Sticky note', exact: true });
  const area = editor.getByRole('textbox', { name: 'Reminder' });
  await area.waitFor();
  assert.equal(await area.inputValue(), presetStickies(1)[0].text);
  await editor.getByRole('button', { name: 'orange', exact: true }).click();
  await page.waitForFunction(() => window.__office.store.stickies[0].color === 'orange' && window.__office.store.stickiesPending === 0);
  assert.deepEqual(changes, [{ action: 'color', id: 'post45times', color: 'orange' }]);
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'detached' });
  // The E that opened it didn't land in the note, so closing it changed nothing else.
  await page.waitForTimeout(600);
  assert.deepEqual(changes, [{ action: 'color', id: 'post45times', color: 'orange' }]);
  assert.equal(stickies[0].text, presetStickies(1)[0].text);

  // The + beside them: E opens an empty box, and the new note goes up with the others.
  await aimAt(null, 'New sticky');
  await page.keyboard.press('e');
  const adder = page.getByRole('dialog', { name: 'New sticky note', exact: true });
  const box = adder.getByRole('textbox', { name: 'New sticky' });
  await box.waitFor();
  await page.waitForTimeout(100);
  assert.equal(await box.inputValue(), '');
  await box.fill('call the bank');
  await adder.getByRole('button', { name: 'Stick it up', exact: true }).click();
  await page.waitForFunction(() => window.__office.store.stickies.length === 5 && window.__office.store.stickiesPending === 0);
  assert.equal(changes.at(-1).action, 'add');
  assert.equal(changes.at(-1).text, 'call the bank');
  const five = await wall();
  const added = five.notes.find((n) => n.id === changes.at(-1).id);
  // With the row over the board full, it goes in the strip's end just beside the board.
  const along = added.x - five.board.x + BOARDS.issues.x;
  assert.ok(along > STICKY_ZONE.u0 && along < STICKY_ZONE.u1, `the new note is in the strip by the board (u ${along})`);
  assert.ok(added.y - five.board.y > 1.5 && Math.abs(added.z - five.board.z) < 0.2, 'up on the wall with the others');

  // The changes follow you onto the Content Kanban floor.
  await checkFloor('autonomous-dev-projects', 5);
  assert.equal(await page.evaluate(() => window.__office.store.stickies[0].color), 'orange');
  await aimAtFirstNote();
  await page.screenshot({ path: path.join(screenshotDir, 'stickies-content-floor.png') });

  assert.deepEqual(errors, []);
  console.log(`stickies-ui: ok (${floors.length} floors; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
