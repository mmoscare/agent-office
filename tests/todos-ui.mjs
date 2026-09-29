// npm run build && node tests/todos-ui.mjs
// The 🔥 To Do board in the built client, against a local WebSocket fixture that keeps the list the
// way the office does (with the built shared/todos.js). No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { applyTodo, checkTodoAction } from '../dist/server/shared/todos.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = path.join(codeDir, '.agent-office/todos-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const issue = { number: 7, title: 'A GitHub issue on this floor', state: 'OPEN', labels: [], assignees: [], author: 'tester', comments: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: 'https://github.com/example/project/issues/7', body: '' };
const floors = [
  { id: 'app', name: 'Agent Office', palette: 0 },
  { id: 'other', name: 'Other Project', palette: 1 },
];
const info = (f) => ({ ...f, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, workers: 0, busy: 0, waiting: 0, attention: [] });
const view = (id) => ({
  floor: id, project: { name: floors.find((f) => f.id === id).name, dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers: [],
  issues: { items: id === 'app' ? [issue] : [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
  queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
  meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
  jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
});
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const send = (ws, msg) => ws.send(JSON.stringify(msg));
// One list for the whole building, like the office's todos.json for the shared password.
let todos = [];
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
  send(ws, { t: 'todos', items: todos });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'todo') return;
    const change = checkTodoAction(msg.change);
    assert.ok(change, `a well-formed change: ${JSON.stringify(msg.change)}`);
    changes.push(change);
    todos = [...applyTodo(todos, change)];
    for (const c of wss.clients) send(c, { t: 'todos', items: todos });
  });
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).pathname === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } }) }));
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  // Up on the top bar on every floor; it opens straight onto the To Do board, ready to type.
  const topBar = page.locator('#dock button[aria-label="To Do"]');
  await topBar.click();
  const board = page.getByRole('dialog', { name: 'To Do board', exact: true });
  const input = board.getByRole('textbox', { name: 'New to-do' });
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'the add box has the cursor');
  assert.equal(await board.getByRole('button', { name: /Refresh/ }).isVisible(), false, 'GitHub’s Refresh is put away on the To Do side');
  const column = (name) => board.locator(`.todo-col[data-column="${name}"]`);
  const cards = (name) => column(name).locator('.todo-card .todo-text').allInnerTexts();

  // Enter adds to To Do, one after another; Shift+Enter starts one now.
  await input.fill('Write the report');
  await input.press('Enter');
  await input.fill('Call the bank');
  await input.press('Enter');
  await input.fill('Fix the login bug');
  await input.press('Shift+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.todo-card').length === 3);
  assert.deepEqual(await cards('todo'), ['Write the report', 'Call the bank']);
  assert.deepEqual(await cards('active'), ['Fix the login bug']);
  assert.equal(await input.inputValue(), '');
  // Active is red, and what's in it shows on the top bar.
  assert.equal(await column('active').locator('h3').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(239, 71, 111)');
  await page.waitForFunction(() => document.querySelector('#dock button[aria-label="To Do"]')?.textContent?.includes('Fix the login bug'));

  // 🔥 Start moves a to-do to the top of Active; ✓ Complete folds it into Completed.
  await column('todo').locator('.todo-card', { hasText: 'Write the report' }).getByRole('button', { name: 'Start it now: move it to Active' }).click();
  assert.deepEqual(await cards('active'), ['Write the report', 'Fix the login bug']);
  await column('active').locator('.todo-card', { hasText: 'Fix the login bug' }).getByRole('button', { name: 'Complete it' }).click();
  assert.deepEqual(await cards('active'), ['Write the report']);
  await column('done').getByRole('button', { name: /1 completed/ }).click();
  assert.deepEqual(await cards('done'), ['Fix the login bug']);
  await board.screenshot({ path: path.join(screenshotDir, 'board.png') });
  await page.locator('#dock').screenshot({ path: path.join(screenshotDir, 'dock.png') });

  // Dragged from Active back onto To Do, above the card it's dropped on.
  const drag = column('active').locator('.todo-card', { hasText: 'Write the report' });
  const target = column('todo').locator('.todo-card', { hasText: 'Call the bank' });
  await drag.dragTo(target, { targetPosition: { x: 20, y: 4 } });
  await page.waitForFunction(() => document.querySelectorAll('.todo-col[data-column="active"] .todo-card').length === 0);
  assert.deepEqual(await cards('todo'), ['Write the report', 'Call the bank']);

  // The keyboard: → moves a focused card a column over, Alt+↓ reorders it.
  await column('todo').locator('.todo-card', { hasText: 'Write the report' }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual(await cards('todo'), ['Call the bank', 'Write the report']);
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await cards('active'), ['Write the report']);

  // Edit in place, then ✕ with Undo.
  await column('todo').locator('.todo-card', { hasText: 'Call the bank' }).dblclick();
  const edit = board.getByRole('textbox', { name: 'Edit to-do' });
  await edit.fill('Call the bank about the card');
  await edit.press('Enter');
  assert.deepEqual(await cards('todo'), ['Call the bank about the card']);
  await column('todo').locator('.todo-card').getByRole('button', { name: 'Remove' }).click();
  assert.deepEqual(await cards('todo'), []);
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await cards('todo'), ['Call the bank about the card']);

  // 📌 Issues turns the board over to GitHub's, and back.
  await board.getByRole('button', { name: '📌 Issues', exact: true }).click();
  const issues = page.getByRole('dialog', { name: 'Issues board', exact: true });
  await issues.getByText(issue.title, { exact: true }).waitFor();
  assert.equal(await issues.getByRole('button', { name: /Refresh/ }).isVisible(), true);
  await issues.screenshot({ path: path.join(screenshotDir, 'issues.png') });
  await issues.getByRole('button', { name: '🔥 To Do', exact: true }).click();
  await board.locator('.todo-card').first().waitFor();
  await board.getByRole('button', { name: 'Close', exact: true }).click();

  // The Issues menu item opens on the issues; the To Do board is still the one you left, on another floor too.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.menu-item').filter({ hasText: /^📌\s*Issues/ }).click();
  await issues.getByText(issue.title, { exact: true }).waitFor();
  await issues.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`${url}/?floor=other`);
  await page.locator('#dock button[aria-label="To Do"]').click();
  await board.locator('.todo-card').first().waitFor();
  assert.deepEqual(await cards('active'), ['Write the report']);
  assert.deepEqual(await cards('todo'), ['Call the bank about the card']);
  assert.deepEqual(await cards('done'), ['Fix the login bug'], 'Completed stays unfolded once shown');

  // Narrow: the columns stack.
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await board.locator('.todo-cols').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
  await board.screenshot({ path: path.join(screenshotDir, 'narrow.png') });

  assert.deepEqual(errors, []);
  console.log(`todos-ui: ok (${changes.length} changes; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
