// npm run build && node tests/todos-ui.mjs
// The 🔥 To Do board in the built client, on the wall and in its window, against a local WebSocket
// fixture that keeps the list the way the office does (with the built shared/todos.js). No agents or
// real office are started.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
  const wall = () => page.evaluate(() => { const w = window.__office.issuesWall(); return { mode: w.mode, map: w.map }; });
  const saveWall = async (name) => {
    const data = await page.evaluate(() => window.__office.issuesWall().canvas.toDataURL('image/png'));
    await writeFile(path.join(screenshotDir, name), Buffer.from(data.split(',')[1], 'base64'));
  };
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.issuesWall);

  // The issues board on the wall shows your To Do by default.
  assert.deepEqual(await wall(), { mode: 'todo', map: 'todo' });

  // Up on the top bar on every floor; it opens straight onto the To Do board, ready to type.
  await page.locator('#dock button[aria-label="To Do"]').click();
  const board = page.getByRole('dialog', { name: 'To Do board', exact: true });
  const input = board.getByRole('textbox', { name: 'New to-do' });
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'the add box has the cursor');
  assert.equal(await board.getByRole('button', { name: /Refresh/ }).isVisible(), false, 'GitHub’s Refresh is put away on the To Do side');
  const column = (name) => board.locator(`.todo-col[data-column="${name}"]`);
  const cards = (name) => column(name).locator('.todo-card .todo-text').allInnerTexts();
  // In one go: a redraw can swap the element out between finding it and reading it.
  const headColor = (name) => page.evaluate((n) => getComputedStyle(document.querySelector(`.todo-col[data-column="${n}"] h3`)).backgroundColor, name);
  const card = (name, text) => column(name).locator('.todo-card', { hasText: text });
  assert.deepEqual(await board.locator('.todo-col h3 .todo-title').allInnerTexts(), ['🔥 Active', '⚡ Urgent', '🌱 Not urgent', '✅ Completed']);

  // Enter adds to the picked column (Urgent to start with), on top; a pick button adds there; Shift+Enter starts one now.
  await input.fill('Write the report');
  await input.press('Enter');
  await input.fill('Pay the invoice');
  await input.press('Enter');
  await input.fill('Call the bank');
  await board.getByRole('button', { name: '🌱 Not urgent', exact: true }).click();
  await input.fill('Tidy the garage');
  await input.press('Enter');
  await input.fill('Fix the login bug');
  await input.press('Shift+Enter');
  assert.deepEqual(await cards('urgent'), ['Pay the invoice', 'Write the report']);
  assert.deepEqual(await cards('todo'), ['Tidy the garage', 'Call the bank'], 'the pick is remembered for Enter');
  assert.deepEqual(await cards('active'), ['Fix the login bug']);
  assert.equal(await input.inputValue(), '');
  // A column's own add box.
  const quick = column('active').getByRole('textbox', { name: 'Add to Active' });
  await quick.fill('Answer the email');
  await quick.press('Enter');
  assert.deepEqual(await cards('active'), ['Answer the email', 'Fix the login bug']);
  assert.equal(await quick.evaluate((el) => el === document.activeElement && el.value === ''), true, 'ready for the next one');

  // Active is red, Urgent orange; the summary and the top bar say what's on.
  assert.equal(await headColor('active'), 'rgb(239, 71, 111)');
  assert.equal(await headColor('urgent'), 'rgb(255, 159, 28)');
  assert.match(await board.locator('.todo-summary').innerText(), /🔥 2 active.*⚡ 2 urgent.*🌱 2 not urgent.*✅ 0 done today/s);
  await page.waitForFunction(() => document.querySelector('#dock button[aria-label="To Do"]')?.textContent?.includes('Answer the email'));

  // 🔥 Start, ✓ Complete (Completed folds away and lights up), Reopen puts it back where it was.
  await card('urgent', 'Write the report').getByRole('button', { name: 'Start it now: move it to Active' }).click();
  assert.deepEqual(await cards('active'), ['Write the report', 'Answer the email', 'Fix the login bug']);
  await card('active', 'Fix the login bug').getByRole('button', { name: 'Complete it' }).click();
  assert.equal(await column('done').locator('.todo-fold.todo-flash').count(), 1);
  await column('done').getByRole('button', { name: /1 completed/ }).click();
  assert.deepEqual(await cards('done'), ['Fix the login bug']);
  await card('done', 'Fix the login bug').getByRole('button', { name: 'Put it back on Active' }).click();
  assert.deepEqual(await cards('active'), ['Fix the login bug', 'Write the report', 'Answer the email']);
  await card('active', 'Fix the login bug').getByRole('button', { name: 'Complete it' }).click();
  await card('todo', 'Call the bank').getByRole('button', { name: 'Make it urgent' }).click();
  assert.deepEqual(await cards('urgent'), ['Call the bank', 'Pay the invoice']);
  await board.screenshot({ path: path.join(screenshotDir, 'board.png') });

  // Dragged from Active onto Not urgent, above the card it's dropped on.
  await card('active', 'Answer the email').dragTo(card('todo', 'Tidy the garage'), { targetPosition: { x: 20, y: 4 } });
  await page.waitForFunction(() => document.querySelectorAll('.todo-col[data-column="active"] .todo-card').length === 1);
  assert.deepEqual(await cards('todo'), ['Answer the email', 'Tidy the garage']);

  // The keyboard: a number sends a focused card to that column, Alt+↓ reorders, Space completes.
  await card('todo', 'Answer the email').focus();
  await page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual(await cards('todo'), ['Tidy the garage', 'Answer the email']);
  await page.keyboard.press('2');
  assert.deepEqual(await cards('urgent'), ['Answer the email', 'Call the bank', 'Pay the invoice']);
  await page.keyboard.press('Space');
  assert.deepEqual(await cards('done'), ['Answer the email', 'Fix the login bug']);

  // Edit in place, then ✕ with Undo.
  await card('todo', 'Tidy the garage').dblclick();
  const edit = board.getByRole('textbox', { name: 'Edit to-do' });
  await edit.fill('Tidy the garage and shed');
  await edit.press('Enter');
  assert.deepEqual(await cards('todo'), ['Tidy the garage and shed']);
  await card('todo', 'Tidy the garage and shed').getByRole('button', { name: 'Remove' }).click();
  assert.deepEqual(await cards('todo'), []);
  await board.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await cards('todo'), ['Tidy the garage and shed']);

  // 📌 Issues turns the window over to GitHub's, and back.
  await board.getByRole('button', { name: '📌 Issues', exact: true }).click();
  const issues = page.getByRole('dialog', { name: 'Issues board', exact: true });
  await issues.getByText(issue.title, { exact: true }).waitFor();
  assert.equal(await issues.getByRole('button', { name: /Refresh/ }).isVisible(), true);
  await issues.getByRole('button', { name: '🔥 To Do', exact: true }).click();
  await board.locator('.todo-card').first().waitFor();
  await board.getByRole('button', { name: 'Close', exact: true }).click();

  // The wall draws the board; its switch flips it to the issues (remembered), and back.
  await saveWall('wall-todo.png');
  await page.evaluate(() => window.__office.flipIssuesWall());
  assert.deepEqual(await wall(), { mode: 'issues', map: 'issues' });
  await page.reload();
  await page.waitForFunction(() => window.__office?.issuesWall);
  assert.deepEqual(await wall(), { mode: 'issues', map: 'issues' });
  await page.evaluate(() => window.__office.flipIssuesWall());
  assert.deepEqual(await wall(), { mode: 'todo', map: 'todo' });

  // In the room: the board and its switch over its right-hand end; point at the switch and press E.
  await page.evaluate(() => {
    const p = window.__office.player;
    p.setView('first');
    p.pos.set(-11.7, 0, -5.5);
    p.camYaw = 0;
    p.lookPitch = 0.18;
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(screenshotDir, 'wall-3d.png') });
  await page.evaluate(() => {
    const p = window.__office.player;
    p.pos.set(-9.55, 0, -8.5);
    p.lookPitch = 0.55;
  });
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('GitHub issues'));
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__office.issuesWall().mode === 'issues');
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('Back to your To Do'));
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__office.issuesWall().mode === 'todo');
  await page.evaluate(() => window.__office.player.setView('third'));

  // The Issues menu item opens on the issues; the To Do board is still the one you left, on another floor too.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.menu-item').filter({ hasText: /^📌\s*Issues/ }).click();
  await issues.getByText(issue.title, { exact: true }).waitFor();
  await issues.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`${url}/?floor=other`);
  await page.locator('#dock button[aria-label="To Do"]').click();
  await board.locator('.todo-card').first().waitFor();
  assert.deepEqual(await cards('active'), ['Write the report']);
  assert.deepEqual(await cards('urgent'), ['Call the bank', 'Pay the invoice']);
  assert.deepEqual(await cards('todo'), ['Tidy the garage and shed']);
  assert.deepEqual(await cards('done'), ['Answer the email', 'Fix the login bug'], 'Completed stays unfolded once shown');

  // Narrower: two columns a row, then one.
  const tracks = () => board.locator('.todo-cols').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  await page.setViewportSize({ width: 900, height: 900 });
  assert.equal(await tracks(), 2);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await tracks(), 1);
  await board.screenshot({ path: path.join(screenshotDir, 'narrow.png') });

  assert.deepEqual(errors, []);
  console.log(`todos-ui: ok (${changes.length} changes; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
