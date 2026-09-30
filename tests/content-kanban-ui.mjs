// npm run build && node tests/content-kanban-ui.mjs
// The 🎬 Content Kanban in the built client: on the Autonomous-Dev-Projects floor it stands on the
// whiteboard's wheels, and its window takes a dump of ideas with a checklist of what each is being
// made into. Against a local WebSocket fixture that keeps the board the way the office does (with the
// built shared/content-kanban.js). No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { applyContent, checkContentAction, hasContentKanban } from '../dist/server/shared/content-kanban.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = path.join(codeDir, '.agent-office/content-kanban-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const CONTENT = 'autonomous-dev-projects';
const floors = [
  { id: 'app', name: 'Agent Office', palette: 0 },
  { id: CONTENT, name: 'Autonomous-Dev-Projects', palette: 6 },
];
const info = (f) => ({ ...f, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, workers: 0, busy: 0, waiting: 0, attention: [] });
// The floor's board, kept like the office keeps it.
let board = [];
const changes = [];
const view = (id) => ({
  floor: id, project: { name: floors.find((f) => f.id === id).name, dir: `/test/${id}`, agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers: [],
  issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
  queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
  meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
  jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
  content: hasContentKanban(id) ? board : null,
});
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const send = (ws, msg) => ws.send(JSON.stringify(msg));
const floorOf = new Map();
wss.on('connection', (ws, req) => {
  const floor = new URL(req.url, url).searchParams.get('floor') || 'app';
  floorOf.set(ws, floor);
  send(ws, {
    t: 'welcome', you: `test-${floorOf.size}`, peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null },
    me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 }, ...view(floor),
  });
  ws.on('close', () => floorOf.delete(ws));
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'content') return;
    assert.equal(floorOf.get(ws), CONTENT, 'changes only come from the Content Kanban floor');
    const change = checkContentAction(msg.change);
    assert.ok(change, `a well-formed change: ${JSON.stringify(msg.change)}`);
    changes.push(change);
    const next = applyContent(board, change, Date.now(), 'Tester');
    if (next !== board) {
      board = [...next];
      for (const c of wss.clients) if (floorOf.get(c) === CONTENT) send(c, { t: 'content', floor: CONTENT, items: board, mine: c === ws });
    } else send(ws, { t: 'content', floor: CONTENT, items: board, mine: true });
  });
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route('**/api/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(new URL(route.request().url()).pathname === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } }) }));
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const stand = () => page.evaluate(() => window.__office.contentKanban().on);
  const saveStand = async (name) => {
    const data = await page.evaluate(() => window.__office.contentKanban().canvas.toDataURL('image/png'));
    await writeFile(path.join(screenshotDir, name), Buffer.from(data.split(',')[1], 'base64'));
  };
  const menuHas = async (label) => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const n = await page.locator('.menu-item').filter({ hasText: label }).count();
    await page.keyboard.press('Escape');
    return n > 0;
  };
  /** Stands in front of the whiteboard's stand, looking at it. */
  const faceStand = async () => {
    await page.evaluate(() => {
      const p = window.__office.player;
      p.setView('first');
      p.pos.set(5.4, 0, -2.4);
      p.camYaw = 0;
      p.lookPitch = 0;
    });
  };

  /** Arrives on floor `id`: a page connects to the floor it last remembers. */
  const goFloor = async (p, id) => {
    await p.evaluate((floor) => localStorage.setItem('agent-office.floor', floor), id);
    await p.reload();
    await p.waitForFunction((floor) => window.__office?.store.floor === floor, id);
  };

  // Any other floor keeps the plain whiteboard, and no Content Kanban in the menu.
  await page.goto(url);
  await goFloor(page, 'app');
  await page.waitForFunction(() => window.__office?.contentKanban);
  assert.equal(await stand(), false);
  assert.equal(await menuHas('Content Kanban'), false);
  await faceStand();
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('Whiteboard'));

  // On the Autonomous-Dev-Projects floor, the stand is the Content Kanban: press E at it.
  await goFloor(page, CONTENT);
  await page.waitForFunction(() => window.__office?.contentKanban().on);
  await faceStand();
  await page.waitForFunction(() => document.querySelector('#hint')?.textContent?.includes('Content Kanban'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, 'stand-empty-3d.png') });
  await page.keyboard.press('e');
  const win = page.getByRole('dialog', { name: 'Content Kanban', exact: true });
  const dump = win.getByRole('textbox', { name: 'Content ideas, one per line' });
  await dump.waitFor();
  assert.equal(await dump.evaluate((el) => el === document.activeElement), true, 'the dump box has the cursor');
  const column = (stage) => win.locator(`.ck-col[data-stage="${stage}"]`);
  const titles = (stage) => column(stage).locator('.ck-card .ck-title').allInnerTexts();
  const card = (stage, text) => column(stage).locator('.ck-card', { hasText: text });
  /** A card's checklist: each box's icon and format. */
  const checklist = (stage, text) => card(stage, text).locator('.ck-checklist li label').evaluateAll((labels) => labels.map((l) => [...l.querySelectorAll('span')].map((s) => s.textContent).join(' ')));
  assert.deepEqual(await win.locator('.ck-col h3 .ck-col-title').allInnerTexts(), ['💡 Ideas', '✍️ Scripting', '🎥 Creating', '✂️ Editing', '📅 Scheduled', '🚀 Published']);

  // A dump of three ideas (bullets and numbers come off), made into a YouTube video and a Short.
  await dump.fill('- Why AI agents need an office\n2. Building a 3D office in three.js\n\nClaude vs Codex on the same bug');
  await win.getByRole('button', { name: /Add 3 ideas/ }).waitFor();
  const toggle = (name) => win.locator('.ck-dump .ck-format', { hasText: name });
  await toggle('YouTube video').click();
  await toggle('YouTube Short').click();
  assert.match(await win.locator('.ck-dump-note').innerText(), /Checklist: ▶️ YouTube video · ⚡ YouTube Short/);
  await win.getByRole('button', { name: /Add 3 ideas/ }).click();
  assert.deepEqual(await titles('idea'), ['Why AI agents need an office', 'Building a 3D office in three.js', 'Claude vs Codex on the same bug']);
  assert.deepEqual(await checklist('idea', 'Why AI agents'), ['▶️ YouTube video', '⚡ YouTube Short']);
  assert.equal(await dump.inputValue(), '');
  assert.equal(await toggle('YouTube video').getAttribute('aria-pressed'), 'false', 'the toggles start fresh for the next idea');
  // One more on its own, as an article and an X thread, with Ctrl+Enter.
  await dump.fill('The office manual, as a blog post');
  await toggle('Article').click();
  await toggle('X thread').click();
  await dump.press('Control+Enter');
  assert.deepEqual((await titles('idea'))[0], 'The office manual, as a blog post');
  assert.deepEqual(await checklist('idea', 'office manual'), ['🧵 X thread', '📰 Article']);

  // Out of reach of the office (reconnecting): nothing changes or is sent, the dump stays in its box
  // with its toggles to try again, and a ticked box springs back.
  const sent = changes.length;
  await page.evaluate(() => (window.__office.net.up = false));
  await dump.fill('An idea while offline');
  await toggle('Podcast').click();
  await dump.press('Control+Enter');
  await page.locator('.toast', { hasText: 'Not connected' }).first().waitFor();
  assert.equal(await dump.inputValue(), 'An idea while offline');
  assert.equal(await toggle('Podcast').getAttribute('aria-pressed'), 'true');
  await card('idea', 'Why AI agents').getByRole('checkbox', { name: 'YouTube video made' }).click();
  assert.equal(await card('idea', 'Why AI agents').getByRole('checkbox', { name: 'YouTube video made' }).isChecked(), false);
  await card('idea', 'Claude vs Codex').getByRole('button', { name: 'Remove' }).click();
  assert.equal(await win.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  assert.equal(await titles('idea').then((t) => t.length), 4);
  assert.equal(changes.length, sent);
  await page.evaluate(() => (window.__office.net.up = true));
  await dump.fill('');
  await toggle('Podcast').click();

  // Ticking the Short: the card says 1/2 made.
  await card('idea', 'Why AI agents').getByRole('checkbox', { name: 'YouTube Short made' }).check();
  await page.waitForFunction(() => [...document.querySelectorAll('.ck-card')].some((c) => c.textContent.includes('Why AI agents') && c.querySelector('.ck-progress')?.textContent === '1/2 made'));
  assert.match(await win.locator('.ck-summary').innerText(), /💡 4 ideas.*✅ 1\/8 pieces made/s);

  // On along the pipeline with its button, and back.
  await card('idea', 'Why AI agents').getByRole('button', { name: 'On to Scripting' }).click();
  assert.deepEqual(await titles('script'), ['Why AI agents need an office']);
  await card('script', 'Why AI agents').getByRole('button', { name: 'On to Creating' }).click();
  await card('create', 'Why AI agents').getByRole('button', { name: 'Back to Scripting' }).click();
  assert.deepEqual(await titles('script'), ['Why AI agents need an office']);

  // Editing: a sharper title, notes, an X thread on top, and a day to go out. The Short stays ticked.
  await card('script', 'Why AI agents').getByRole('button', { name: /^Edit/ }).click();
  const editor = column('script').locator('.ck-card.editing');
  await editor.getByRole('textbox', { name: 'Title' }).fill('Why every AI agent needs an office');
  await editor.getByRole('textbox', { name: 'Notes' }).fill('Hook: 40 agents, one repo.\nShow the elevator.');
  await editor.locator('.ck-format', { hasText: 'X thread' }).click();
  await editor.getByLabel('Goes out on').fill('2030-01-15');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual(await checklist('script', 'every AI agent'), ['▶️ YouTube video', '⚡ YouTube Short', '🧵 X thread']);
  assert.equal(await card('script', 'every AI agent').getByRole('checkbox', { name: 'YouTube Short made' }).isChecked(), true);
  assert.match(await card('script', 'every AI agent').locator('.ck-notes').innerText(), /Hook: 40 agents, one repo\.\nShow the elevator\./);
  assert.match(await card('script', 'every AI agent').locator('.ck-due').innerText(), /📅 .*Jan.*15/);

  // Everything made: it offers to publish.
  await card('script', 'every AI agent').getByRole('checkbox', { name: 'YouTube video made' }).check();
  await card('script', 'every AI agent').getByRole('checkbox', { name: 'X thread made' }).check();
  await card('script', 'every AI agent').getByRole('button', { name: /All made/ }).click();
  assert.deepEqual(await titles('published'), ['Why every AI agent needs an office']);

  // Dragged from Ideas into Editing.
  await card('idea', 'three.js').dragTo(column('edit'));
  await page.waitForFunction(() => document.querySelectorAll('.ck-col[data-stage="edit"] .ck-card').length === 1);
  assert.deepEqual(await titles('edit'), ['Building a 3D office in three.js']);

  // ✕, and Undo puts it back where it was.
  await card('idea', 'Claude vs Codex').getByRole('button', { name: 'Remove' }).click();
  assert.deepEqual(await titles('idea'), ['The office manual, as a blog post']);
  await win.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.deepEqual(await titles('idea'), ['The office manual, as a blog post', 'Claude vs Codex on the same bug']);

  // Only the cards being made into an X thread.
  await win.locator('.ck-filter .ck-chip', { hasText: '🧵' }).click();
  assert.deepEqual(await titles('idea'), ['The office manual, as a blog post']);
  assert.deepEqual(await titles('edit'), []);
  await win.locator('.ck-filter .ck-chip', { hasText: 'All' }).click();
  assert.deepEqual(await titles('edit'), ['Building a 3D office in three.js']);
  await win.screenshot({ path: path.join(screenshotDir, 'board.png') });

  // Double-click the board around the cards: each card shows its own subtasks and pictures (its notes
  // are on it already), and again puts them away (ui/todo-details.ts, as on the To Do boards).
  assert.equal(await win.locator('.todo-details').count(), 0, 'as it always was, to start with');
  await win.locator('.ck-body').dblclick({ position: { x: 4, y: 4 } });
  await win.locator('.todo-details').first().waitFor();
  assert.equal(await win.locator('.todo-details').count(), await win.locator('.ck-card').count());
  assert.equal(await win.locator('.todo-details textarea.todo-notes').count(), 0, 'notes stay where they were');
  const detailed = win.locator('.ck-card', { hasText: 'Claude vs Codex' });
  await detailed.locator('input.todo-sub-add').fill('Record both runs');
  await detailed.locator('input.todo-sub-add').press('Enter');
  await detailed.locator('.todo-sub', { hasText: 'Record both runs' }).waitFor();
  assert.ok(changes.some((c) => c.action === 'details' && c.subtasks?.[0]?.text === 'Record both runs'));
  await win.screenshot({ path: path.join(screenshotDir, 'board-details.png') });
  await win.locator('.ck-body').dblclick({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() => !document.querySelector('.ck-modal .todo-details'));

  // Someone else on the floor sees it all, and their changes reach this window live.
  const other = await context.newPage();
  other.setDefaultTimeout(30000);
  other.setDefaultNavigationTimeout(120000);
  await other.goto(url);
  await other.waitForFunction(() => window.__office?.contentKanban().on);
  await other.getByRole('button', { name: 'Menu', exact: true }).click();
  await other.locator('.menu-item').filter({ hasText: 'Content Kanban' }).click();
  const theirs = other.getByRole('dialog', { name: 'Content Kanban', exact: true });
  await theirs.locator('.ck-card').first().waitFor();
  await theirs.locator('.ck-card', { hasText: 'Claude vs Codex' }).getByRole('button', { name: 'On to Scripting' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ck-col[data-stage="script"] .ck-title')].some((t) => t.textContent === 'Claude vs Codex on the same bug'));
  await other.close();

  // The stand draws the board.
  await win.getByRole('button', { name: 'Close', exact: true }).click();
  await saveStand('stand.png');
  await faceStand();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(screenshotDir, 'stand-3d.png') });

  // It's all still there after a reload, and gone again on another floor.
  await page.reload();
  await page.waitForFunction(() => window.__office?.contentKanban().on);
  assert.equal(await menuHas('Content Kanban'), true);
  await goFloor(page, 'app');
  assert.equal(await stand(), false);

  // Narrower: three stages a row, then one.
  await goFloor(page, CONTENT);
  await page.waitForFunction(() => window.__office?.contentKanban().on);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('.menu-item').filter({ hasText: 'Content Kanban' }).click();
  await win.locator('.ck-card').first().waitFor();
  const tracks = () => win.locator('.ck-cols').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(await tracks(), 6);
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.equal(await tracks(), 3);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await tracks(), 1);

  assert.deepEqual(errors, []);
  console.log(`content-kanban-ui: ok (${changes.length} changes; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
