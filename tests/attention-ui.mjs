// npm run build && node tests/attention-ui.mjs
// A built-client smoke test with a local WebSocket fixture. No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { summarizeWorkers } from '../dist/server/shared/attention.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = path.join(codeDir, '.agent-office/attention-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const worker = (id, status, extra = {}) => ({
  id, name: id, kind: 'agent', provider: 'codex', deskId: `desk-${id.charCodeAt(0) % 4 + 1}`, color: '#4f86f7',
  status, acked: false, createdBy: 'Test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], ...extra,
});
const floor = (id, name, palette, workers = []) => ({ id, name, palette, workers });
const floors = [
  floor('app', 'Agent Office', 0, [worker('Ada', 'needs_input', { activity: 'Which login flow should I use?' }), worker('Byte', 'needs_input')]),
  floor('web', 'Portfolio', 1, [worker('Coco', 'needs_input', { activity: 'Permission needed to continue' })]),
];
const info = f => ({ id: f.id, name: f.name, palette: f.palette, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, ...summarizeWorkers(f.workers) });
const view = id => {
  const f = floors.find(f => f.id === id);
  return {
    floor: id, project: { name: f.name, dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex' }, workers: f.workers,
    issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
    queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
    meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
    jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
  };
};
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const sent = [];
const send = (ws, msg) => ws.send(JSON.stringify(msg));
const publish = () => { for (const ws of wss.clients) send(ws, { t: 'floors', floors: floors.map(info) }); };
function update(floorId, id, patch) {
  const f = floors.find(f => f.id === floorId);
  let w = f.workers.find(w => w.id === id);
  if (w) Object.assign(w, patch);
  else f.workers.push(w = worker(id, patch.status, patch));
  for (const ws of wss.clients) if (ws.floor === floorId) send(ws, { t: 'worker.update', worker: w });
  publish();
}
wss.on('connection', (ws, req) => {
  ws.floor = new URL(req.url, url).searchParams.get('floor') || 'app';
  send(ws, {
    t: 'welcome', you: 'test', peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null },
    me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 }, ...view(ws.floor),
  });
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    sent.push({ floor: ws.floor, ...msg });
    if (msg.t === 'floor.go') {
      ws.floor = msg.floor;
      send(ws, { t: 'floor.enter', peers: [], ...view(ws.floor) });
    } else if (msg.t === 'worker.attach') {
      const w = floors.find(f => f.id === ws.floor).workers.find(w => w.id === msg.workerId);
      assert.ok(w, 'only attach to workers on the floor that has arrived');
      if (w.status !== 'needs_input') update(ws.floor, w.id, { acked: true });
      send(ws, { t: 'term.snapshot', workerId: w.id, cols: 80, rows: 24, data: 'Fixture terminal\r\n' });
    } else if (msg.t === 'worker.resume') {
      update(ws.floor, msg.workerId, { status: 'starting', acked: true, exitCode: undefined });
    }
  });
});

let browser;
let page;
try {
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{"me":{"admin":false}}' }));
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, hud: { workers: true, spend: true } }));
  });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  await page.goto(url);
  const badge = async count => page.waitForFunction(n => document.querySelector('#attention-count')?.textContent === String(n), count);
  const row = name => page.locator('.attention-worker').filter({ has: page.locator('.attention-name', { hasText: name }) });
  await badge(3);
  assert.equal(await page.locator('.attention-worker').count(), 3);
  assert.equal(await page.locator('.attention-floor-button').count(), 2);
  assert.match(await page.locator('#attention-summary').innerText(), /3 need input/);
  assert.equal(await page.locator('.workers + #attention').count(), 1, 'widget sits directly below Workers');
  assert.equal(await page.locator('#attention + #phone').count(), 1, 'the phone panel follows the widget');
  await page.locator('#workers-panel').getByRole('button', { name: 'Hide', exact: true }).click();
  assert.equal(await page.locator('#workers-panel').isVisible(), false, 'the personal HUD hide control still works');
  assert.equal(await page.locator('#attention').isVisible(), true, 'building attention stays available with Workers hidden');
  await page.locator('#dock .dock-panel').filter({ hasText: 'Workers' }).click();
  assert.equal(await page.locator('#workers-panel').isVisible(), true);

  await row('Byte').focus();
  update('app', 'Ada', { status: 'done', task: { name: 'Login flow', summary: 'Login changes are ready to review' } });
  await page.waitForFunction(() => document.querySelector('#attention-summary').textContent === '2 need input · 1 done');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.attentionKey), 'worker:app:Byte');
  await badge(3);
  await row('Ada').click();
  await page.getByRole('dialog', { name: 'Ada terminal', exact: true }).waitFor();
  await badge(2);
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();

  update('app', 'Ada', { status: 'done', acked: false });
  update('app', 'Byte', { status: 'done', acked: false });
  update('web', 'Delta', { status: 'exited', exitCode: 2 });
  await badge(4);
  assert.equal(await page.locator('.attention-reason.done').count(), 2);
  assert.equal(await page.locator('.attention-reason.error').count(), 1);
  assert.equal(await page.locator('.attention-reason.needs_input').count(), 1);
  await page.locator('#attention').screenshot({ path: path.join(screenshotDir, 'needs-you.png') });
  await page.screenshot({ path: path.join(screenshotDir, 'office.png') });

  await row('Coco').click();
  await page.getByRole('dialog', { name: 'Coco terminal', exact: true }).waitFor();
  await badge(4);
  assert.ok(sent.some(m => m.t === 'floor.go' && m.floor === 'web'));
  assert.ok(sent.some(m => m.t === 'worker.attach' && m.workerId === 'Coco' && m.floor === 'web'));
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  update('web', 'Coco', { status: 'working', acked: true });
  await badge(3);
  await row('Delta').click();
  await page.getByRole('dialog', { name: 'Delta terminal', exact: true }).waitFor();
  await badge(2);
  assert.ok(sent.some(m => m.t === 'worker.resume' && m.workerId === 'Delta' && m.floor === 'web'));
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();

  floors[0].workers = [];
  publish();
  await badge(0);
  assert.equal(await page.locator('#attention-summary').innerText(), 'All caught up.');
  assert.equal(await page.locator('.attention-worker').count(), 0);
  await page.reload();
  await badge(0);
  await page.waitForFunction(() => window.__office?.store.floor === 'web');

  // Many floors and long labels stay inside the bounded, scrollable panel.
  for (let i = 2; i < 16; i++) floors.push(floor(`floor-${i}`, `Project ${i} with a very long repository name`, i, [worker(`Worker-${i}`, 'done')]));
  publish();
  await badge(14);
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.locator('#attention').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#attention-floors').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await page.locator('#attention-floors').evaluate(el => el.scrollHeight > el.clientHeight), true);
  await page.screenshot({ path: path.join(screenshotDir, 'many-floors.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: badge counts 3/3/4, unread clearing, persistent questions, error retry, cross-floor terminal navigation, focus, removal, reconnect, and scrolling.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screenshotDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.httpServer.close(resolve));
}
