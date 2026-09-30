// npm run build && node tests/autonomous-ui.mjs
// The 🏢 Autonomous Tasks whiteboard in the built client, and the double-click that shows every
// kanban card's notes, subtasks and pictures (ui/todo-details.ts), against a local WebSocket fixture
// that keeps both lists the way the office does. No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { applyTodo, checkTodoAction } from '../dist/server/shared/todos.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = process.argv[2] ?? path.join(codeDir, '.agent-office/autonomous-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const floors = [{ id: 'app', name: 'Agent Office', palette: 0 }];
const info = (f) => ({ ...f, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, workers: 0, busy: 0, waiting: 0, attention: [] });
const view = (id) => ({
  floor: id, project: { name: 'Agent Office', dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers: [],
  issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
  queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
  meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
  jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
});
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const send = (ws, msg) => ws.send(JSON.stringify(msg));
// A 1×1 PNG, standing in for every picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pic = (n) => `${String(n).padStart(32, 'b')}.png`;
const lists = {
  mine: [{ id: 'mine000001', text: 'Book the dentist', column: 'urgent', at: 1 }],
  autonomous: [
    { id: 'auto000001', text: 'Film the product demo', column: 'urgent', at: 2, notes: 'From the old tracker · High', subtasks: [{ id: 'sub0000001', text: 'Outline', done: true }], images: [pic(1)] },
    { id: 'auto000002', text: 'Draft the onboarding guide', column: 'todo', at: 3 },
  ],
};
const changes = { mine: [], autonomous: [] };
wss.on('connection', (ws) => {
  send(ws, {
    t: 'welcome', you: 'test', peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null },
    me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 }, ...view('app'),
  });
  send(ws, { t: 'todos', items: lists.mine });
  send(ws, { t: 'todos', board: 'autonomous', items: lists.autonomous });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'todo') return;
    const board = msg.board === 'autonomous' ? 'autonomous' : 'mine';
    const change = checkTodoAction(msg.change);
    assert.ok(change, `a well-formed change: ${JSON.stringify(msg.change)}`);
    changes[board].push(change);
    lists[board] = [...applyTodo(lists[board], change)];
    // Like the office: everyone gets the Autonomous board, and the sender learns it answers its change.
    for (const c of wss.clients) send(c, { t: 'todos', items: lists[board], ...(board === 'autonomous' ? { board, ...(c === ws ? { mine: true } : {}) } : {}) });
  });
});
/** A change to the Autonomous board from someone else in the office. */
const someoneElse = (change) => {
  lists.autonomous = [...applyTodo(lists.autonomous, change)];
  for (const c of wss.clients) send(c, { t: 'todos', board: 'autonomous', items: lists.autonomous });
};

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const uploads = [];
  await page.route('**/api/**', (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/todo-image' && req.method() === 'GET') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (p === '/api/todo-image') {
      const { dataURL } = JSON.parse(req.postData() ?? '{}');
      assert.match(dataURL, /^data:image\/png;base64,/);
      uploads.push(dataURL);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: pic(uploads.length + 1) }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(p === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const saveStand = async (name) => {
    const data = await page.evaluate(() => window.__office.autonomousBoard().canvas.toDataURL('image/png'));
    await writeFile(path.join(screenshotDir, name), Buffer.from(data.split(',')[1], 'base64'));
  };
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.autonomousBoard && window.__office.store.autonomous.length === 2);
  assert.equal(await page.evaluate(() => window.__office.autonomousBoard().face.material.map?.image === window.__office.autonomousBoard().canvas), true, 'the stand shows the board');
  await saveStand('stand.png');

  // Walk up to the stand (it faces -z, toward the drawing whiteboard) and press E.
  await page.evaluate(() => {
    const p = window.__office.player;
    p.setView('first');
    p.pos.set(5.4, 0, 2.4);
    p.camYaw = Math.PI;
    p.lookPitch = 0;
  });
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('Autonomous Tasks'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, 'stand-3d.png') });
  await page.keyboard.press('e');
  const board = page.getByRole('dialog', { name: 'Autonomous Tasks board', exact: true });
  await board.locator('.todo-card').first().waitFor();
  await page.waitForFunction(() => document.activeElement?.matches?.('input.todo-input'));
  assert.equal(await board.locator('input.todo-input').inputValue(), '', 'the E that opened it is not typed into the add box');
  const column = (name) => board.locator(`.todo-col[data-column="${name}"]`);
  const card = (text) => board.locator('.todo-card', { hasText: text });
  // The To Do's kanban, exactly: same four columns.
  assert.deepEqual(await board.locator('.todo-col h3 .todo-title').allInnerTexts(), ['🔥 Active', '⚡ Urgent', '🌱 Not urgent', '✅ Completed']);
  assert.deepEqual(await column('urgent').locator('.todo-text').allInnerTexts(), ['Film the product demo']);

  // As it always was until you double-click the cork: no notes, subtasks or pictures showing.
  assert.equal(await board.locator('.todo-details').count(), 0);
  await board.screenshot({ path: path.join(screenshotDir, 'board-plain.png') });
  // A double-click on a card still edits it, and doesn't reveal anything.
  await card('Draft the onboarding guide').locator('.todo-text').dblclick();
  await board.locator('textarea.todo-edit').waitFor();
  await board.locator('textarea.todo-edit').press('Enter');
  assert.equal(await board.locator('.todo-details').count(), 0);

  // Double-click the board around the cards: every card shows its details.
  await board.locator('.todo-board').dblclick({ position: { x: 5, y: 5 } });
  await board.locator('.todo-details').first().waitFor();
  assert.equal(await board.locator('.todo-details').count(), 2);
  const seeded = card('product demo');
  assert.equal(await seeded.locator('textarea.todo-notes').inputValue(), 'From the old tracker · High');
  assert.equal(await seeded.locator('.todo-sub input[type=checkbox]').isChecked(), true);
  assert.equal(await seeded.locator('.todo-sub-count').innerText(), '1/1');
  assert.equal(await seeded.locator('.todo-pic img').count(), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.todo-pic img')].every((i) => i.complete && i.naturalWidth > 0));

  // Subtasks: add two, tick one off.
  const fresh = card('Draft the onboarding guide');
  const addSub = fresh.locator('input.todo-sub-add');
  await addSub.fill('Write chapter 1');
  await addSub.press('Enter');
  await fresh.locator('.todo-sub', { hasText: 'Write chapter 1' }).waitFor();
  // Ready for the next one (checked after the office's answer has redrawn the board, too).
  await page.waitForFunction(() => document.activeElement?.matches?.('input.todo-sub-add') && document.activeElement.value === '' && document.activeElement.dataset.keep === 'autonomous:auto000002:sub-add');
  await fresh.locator('input.todo-sub-add').fill('Review chapter 1');
  await fresh.locator('input.todo-sub-add').press('Enter');
  await fresh.locator('.todo-sub', { hasText: 'Review chapter 1' }).waitFor();
  await fresh.locator('.todo-sub', { hasText: 'Write chapter 1' }).locator('input[type=checkbox]').check();
  await page.waitForFunction(() => window.__office.store.autonomous.find((t) => t.id === 'auto000002')?.subtasks?.[0]?.done === true);
  assert.equal(await fresh.locator('.todo-sub-count').innerText(), '1/2');

  // Rewording a subtask while someone else changes the board: the box, the cursor and what's typed stay.
  await fresh.locator('.todo-sub', { hasText: 'Review chapter 1' }).locator('.todo-sub-text').dblclick();
  await fresh.locator('input.todo-sub-edit').fill('Review chapter 1 twice');
  someoneElse({ action: 'add', id: 'other00001', text: 'Their new card', column: 'urgent' });
  await card('Their new card').waitFor();
  await page.waitForFunction(() => document.activeElement?.matches?.('input.todo-sub-edit') && document.activeElement.value === 'Review chapter 1 twice');
  await page.keyboard.type(' today');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__office.store.autonomous.find((t) => t.id === 'auto000002')?.subtasks?.some((s) => s.text === 'Review chapter 1 twice today'));
  assert.equal(await fresh.locator('input.todo-sub-edit').count(), 0, 'done rewording');

  // Notes: typed, kept across the redraws other changes make, and sent once typing stops.
  const notes = fresh.locator('textarea.todo-notes');
  await notes.click();
  await page.keyboard.type('Keep it short.');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('One page a day.');
  await page.waitForFunction(() => window.__office.store.autonomous.find((t) => t.id === 'auto000002')?.notes === 'Keep it short.\nOne page a day.');
  assert.equal(await fresh.locator('textarea.todo-notes').evaluate((el) => el === document.activeElement), true, 'the notes keep the cursor');

  // Pictures: pick one; it goes up, and its thumbnail shows.
  await fresh.locator('input[type=file]').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  await fresh.locator('.todo-pic img').waitFor();
  assert.equal(uploads.length, 1);
  assert.deepEqual(lists.autonomous.find((t) => t.id === 'auto000002').images, [pic(2)]);
  await board.screenshot({ path: path.join(screenshotDir, 'board-details.png') });
  await saveStand('stand-details.png');

  // Double-click the cork again: tucked away, and the card is the plain card again.
  await board.locator('.todo-board').dblclick({ position: { x: 5, y: 5 } });
  await page.waitForFunction(() => !document.querySelector('.todo-details'));
  assert.equal(await card('Draft the onboarding guide').locator('.todo-text').innerText(), 'Draft the onboarding guide');
  await board.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.__office.player.setView('third'));

  // Your own To Do board is its own: plain until you double-click it, and its changes go to your list.
  await page.locator('#dock button[aria-label="To Do"]').click();
  const todo = page.getByRole('dialog', { name: 'To Do board', exact: true });
  await todo.locator('.todo-card').first().waitFor();
  assert.equal(await todo.locator('.todo-details').count(), 0);
  await todo.locator('.todo-board').dblclick({ position: { x: 5, y: 5 } });
  await todo.locator('.todo-details').first().waitFor();
  await todo.locator('input.todo-sub-add').fill('Call before 5');
  await todo.locator('input.todo-sub-add').press('Enter');
  await todo.locator('.todo-sub', { hasText: 'Call before 5' }).waitFor();
  assert.deepEqual(lists.mine[0].subtasks.map((s) => s.text), ['Call before 5']);
  assert.ok(changes.autonomous.every((c) => c.id !== 'mine000001'), 'the To Do change went to the To Do list');

  assert.deepEqual(errors, []);
  console.log(`autonomous-ui: ok (${changes.autonomous.length} + ${changes.mine.length} changes; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
