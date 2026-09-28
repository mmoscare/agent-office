// npm run build && node tests/pull-work-ui.mjs
// A built-client smoke test with a local WebSocket fixture. No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { summarizeWorkers } from '../dist/server/shared/attention.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = path.join(codeDir, '.agent-office/pull-work-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const worker = (id, status, extra = {}) => ({
  id, name: id, kind: 'agent', provider: 'codex', deskId: `desk-${id.charCodeAt(0) % 4 + 1}`, color: '#4f86f7',
  status, acked: false, createdBy: 'Test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], ...extra,
});
const floor = (id, name, palette, workers = []) => ({ id, name, palette, workers });
const pull = { number: 12, url: 'https://github.com/example/project/pull/12', headRefName: 'office/original', baseRefName: 'personal', title: 'Make the PR activity visible', state: 'OPEN', isDraft: false, author: 'tester', labels: [], reviewDecision: 'CHANGES_REQUESTED', checks: 'pass', additions: 12, deletions: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), body: 'Test PR', closes: [] };
const floors = [floor('app', 'Agent Office', 0, [worker('Original', 'done', { deskId: 'desk-1', pr: pull })])];
let conflicts = false;
const info = f => ({ id: f.id, name: f.name, palette: f.palette, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, ...summarizeWorkers(f.workers) });
const view = id => {
  const f = floors.find(f => f.id === id);
  return {
    floor: id, project: { name: f.name, dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers: f.workers,
    issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [pull], fetchedAt: 1, loading: false },
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
    if (msg.t === 'worker.spawn') update('app', 'Fixer', { deskId: msg.deskId, status: 'starting', pullWork: { ...msg.pullWork, assignedAt: Date.now() } });
    if (msg.t === 'worker.prompt') update('app', msg.workerId, { status: 'working', pullWork: { ...msg.pullWork, assignedAt: Date.now() } });

  });
});

let browser;
let page;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route('**/api/**', route => {
    const target = new URL(route.request().url());
    let data = { me: { admin: false } };
    if (target.pathname === '/api/balances') data = { providers: [], at: 0 };
    if (target.pathname === '/api/gh/pull/diff') return route.fulfill({ body: '' });
    if (target.pathname === '/api/gh/pull') data = { ...pull, mergeable: conflicts ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: conflicts ? 'DIRTY' : 'CLEAN', comments: [], reviews: [], reviewComments: [], checks: [], commits: 1, repo: { methods: ['squash'] }, viewer: 'tester' };
    if (target.pathname === '/api/workspace/repositories') data = { repositories: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const openBoard = async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('.menu-item').filter({ hasText: 'Pull requests' }).click();
  };
  const board = page.getByRole('dialog', { name: 'Pull requests board', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Pull request #12', exact: true });
  await page.goto(url);
  await openBoard();
  await board.getByText(pull.title, { exact: true }).click();
  assert.equal(await dialog.locator('.pr-work').count(), 0);
  await dialog.getByRole('button', { name: /Fix comments & merge/ }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await dialog.locator('.pr-work').count(), 0, 'cancel must not create an assignment');
  await dialog.getByRole('button', { name: /Fix comments & merge/ }).click();
  await page.getByRole('button', { name: 'Hire & start', exact: true }).click();
  await dialog.locator('.pr-work').filter({ hasText: 'Starting' }).waitFor();
  assert.equal(sent.find(m => m.t === 'worker.spawn').pullWork.action, 'comments');
  assert.equal(sent.find(m => m.t === 'worker.spawn').pullWork.url, pull.url);
  update('app', 'Fixer', { status: 'working' });
  await dialog.locator('.pr-work.active').filter({ hasText: 'Working' }).waitFor();
  assert.match(await board.locator('.pr-work').innerText(), /Working.*Fixer.*Fix comments/);
  await page.screenshot({ path: path.join(screenshotDir, 'working.png') });
  update('app', 'Fixer', { status: 'needs_input' });
  await dialog.locator('.pr-work.waiting').filter({ hasText: 'Needs input' }).waitFor();
  update('app', 'Fixer', { status: 'done', waitingSince: Date.now() + 1 });
  await dialog.locator('.pr-work.finished').filter({ hasText: 'Turn finished' }).waitFor();
  conflicts = true;
  await dialog.locator('button[title="Reload from GitHub"]').click();
  await dialog.locator('footer').getByRole('button', { name: /Fix conflicts & merge/ }).click();
  await page.locator('.ask-to button').filter({ hasText: 'Fixer' }).click();
  await page.locator('form.ask button[type=submit]').click();
  await dialog.locator('.pr-work').filter({ hasText: 'Fix conflicts & merge' }).waitFor();
  assert.equal(sent.findLast(m => m.t === 'worker.prompt').pullWork.action, 'conflicts');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.match(await board.locator('.pr-work').innerText(), /Working.*Fixer.*Fix conflicts/);
  await page.screenshot({ path: path.join(screenshotDir, 'board.png') });
  await page.reload();
  await openBoard();
  await board.locator('.pr-work.active').waitFor();
  await page.setViewportSize({ width: 480, height: 850 });
  await board.getByText(pull.title, { exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => { const el = document.querySelector('.gh-window .pr-work-dot'); return el && getComputedStyle(el).animationName === 'none'; });
  assert.equal(await dialog.locator('.pr-work').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: path.join(screenshotDir, 'narrow.png') });
  // Keyboard activation of the badge must navigate, not bubble to/reopen the PR card.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await board.locator('.pr-work').focus();
  await board.locator('.pr-work').press('Enter');
  assert.equal(await dialog.count(), 0);
  // Integration of the redesigned board and persistent desk attribution: even one
  // repository with PRs keeps its identity, and finished cards retain the submitter.
  await openBoard();
  const archived = { ...pull, number: 13, url: 'https://github.com/example/project/pull/13',
    title: 'Finished by Widget', headRefName: 'office/widget-0200', state: 'MERGED',
    repo: 'example/project', repoDir: 'app' };
  const archivedClosed = { ...archived, number: 14, url: 'https://github.com/example/project/pull/14', state: 'CLOSED', title: 'Closed by Widget' };
  const manual = { ...archived, number: 15, url: 'https://github.com/example/project/pull/15', headRefName: 'fix/by-hand', title: 'Manual PR' };
  const state = { items: [archived, archivedClosed, manual], fetchedAt: Date.now(), loading: false };
  const tally = board.locator('[data-focus="tally-prb-done"]');
  await tally.focus();
  for (const ws of wss.clients) send(ws, { t: 'gh.pulls', state });
  await board.getByText(archived.title, { exact: true }).waitFor();
  assert.equal(await tally.evaluate(el => document.activeElement === el), true, 'tally focus survives redraw');
  assert.match(await board.locator('.prb-repo').innerText(), /app/i);
  assert.equal(await board.locator('.pr-submitter').count(), 2, 'merged/closed office PRs keep attribution; manual branches do not invent it');
  assert.match(await board.locator('.pr-submitter').first().innerText(), /Widget/);
  assert.match(await board.locator('.prb-ref').first().innerText(), /project#13/);
  assert.equal(await board.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: cancel, new worker, existing worker, comments/conflicts metadata, live card/window states, reconnect, narrow layout, reduced motion, and keyboard desk navigation.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screenshotDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.httpServer.close(resolve));
}
