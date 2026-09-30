// npm run build && node tests/notes-ui.mjs [screenshot-dir]
// The 🗒️ Notes pad on the To Do board's other side, in the built client, against a local WebSocket
// fixture that keeps the pad the way the office does (with the built shared/notes.js) and answers
// picture uploads. No agents or real office are started.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { applyNote, checkNoteAction, EMPTY_NOTES } from '../dist/server/shared/notes.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = path.resolve(process.argv[2] ?? path.join(codeDir, '.agent-office/notes-check'));
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
// One pad for the whole building, like the office's notes.json for the shared password.
let kept = EMPTY_NOTES;
const changes = [];
wss.on('connection', (ws) => {
  send(ws, {
    t: 'welcome', you: 'test', peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null },
    me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 }, ...view('app'),
  });
  send(ws, { t: 'todos', items: [] });
  send(ws, { t: 'notes', state: kept });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'note') return;
    const change = checkNoteAction(msg.change);
    assert.ok(change, `a well-formed change: ${JSON.stringify(msg.change).slice(0, 200)}`);
    changes.push(change);
    const at = Date.now();
    const next = applyNote(kept, change, at);
    if (next === kept) return send(ws, { t: 'notes', state: kept, mine: true });
    kept = next;
    for (const c of wss.clients) send(c, { t: 'notes.change', change, at, ...(c === ws ? { mine: true } : {}) });
  });
});

// A small red square (a real PNG, so the browser draws it), and what the fixture keeps of uploaded pictures.
function png(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([239, 71, 111]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(16);
const pictures = new Map();

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/api/notes/image' && req.method() === 'POST') {
      const { dataURL } = JSON.parse(req.postData() ?? '{}');
      const bytes = Buffer.from(String(dataURL).split(',')[1] ?? '', 'base64');
      const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`;
      pictures.set(id, bytes);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id }) });
    }
    if (u.pathname === '/api/notes/image') {
      const bytes = pictures.get(u.searchParams.get('id'));
      return bytes ? route.fulfill({ contentType: 'image/png', body: bytes }) : route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(u.pathname === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } }) });
  });
  await context.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store);

  // The To Do board, and 🗒️ Notes turns it right over into the notepad.
  await page.locator('#dock button[aria-label="To Do"]').click();
  const todo = page.getByRole('dialog', { name: 'To Do board', exact: true });
  await todo.waitFor();
  await todo.getByRole('button', { name: '🗒️ Notes', exact: true }).click();
  const pad = page.getByRole('dialog', { name: 'Notes', exact: true });
  await pad.locator('.notes-pad').waitFor();
  await page.waitForFunction(() => document.querySelector('.modal.board')?.getAnimations().length === 0);
  assert.equal(await pad.evaluate((el) => el.classList.contains('notes-mode')), true);
  assert.equal(await pad.locator('header').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 217, 90)', 'a yellow notepad');
  const folderLabels = () => pad.locator('.notes-folder .notes-folder-label').allInnerTexts();
  assert.deepEqual(await folderLabels(), ['Notes', 'Links to watch', 'Recently deleted']);

  // A new note: the title first, Enter carries on in the text; it saves as you stop typing.
  await pad.getByRole('button', { name: 'New note', exact: true }).first().click();
  const title = pad.getByRole('textbox', { name: 'Title', exact: true });
  const body = pad.getByRole('textbox', { name: 'Note', exact: true });
  assert.equal(await title.evaluate((el) => el === document.activeElement), true, 'the title has the cursor');
  await title.pressSequentially('Groceries');
  await title.press('Enter');
  assert.equal(await body.evaluate((el) => el === document.activeElement), true);
  await body.pressSequentially('milk, eggs\nrecipe https://example.com/pancakes');
  await pad.locator('.notes-status', { hasText: 'Saved' }).waitFor();
  const rows = () => pad.locator('.notes-list .notes-row .notes-row-title').allInnerTexts();
  assert.deepEqual(await rows(), ['Groceries']);
  assert.match(await pad.locator('.notes-row .notes-row-preview').first().innerText(), /^milk, eggs recipe/);
  // The link in it is a link you can click.
  assert.equal(await pad.locator('.notes-links a.notes-chip').getAttribute('href'), 'https://example.com/pancakes');
  assert.deepEqual(changes.map((c) => c.action).slice(0, 1), ['add']);
  assert.equal(kept.notes[0].text, 'Groceries\nmilk, eggs\nrecipe https://example.com/pancakes');

  // Pictures: picked with 🖼️ (or pasted, or dropped), shown under the text.
  await pad.locator('input.notes-file').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PNG });
  await pad.locator('.notes-image img').waitFor();
  await page.waitForFunction(() => document.querySelector('.notes-image img')?.naturalWidth === 16);
  assert.equal(kept.notes[0].images.length, 1);
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.querySelector('textarea.notes-body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  // The same picture twice is one picture.
  await page.waitForTimeout(500);
  assert.equal(await pad.locator('.notes-image').count(), 1);
  await pad.screenshot({ path: path.join(screenshotDir, 'note.png') });

  // 🔗 Links to watch: the link from the note is there already; paste another; tick it off as watched.
  await pad.locator('.notes-folder[data-folder="links"]').click();
  const links = () => pad.locator('.notes-link .notes-link-title').allInnerTexts();
  assert.deepEqual(await links(), ['🔗 example.com/pancakes']);
  assert.match(await pad.locator('.notes-link .notes-link-where').innerText(), /in 🗒️ Groceries/);
  const add = pad.getByRole('textbox', { name: 'Add a link to watch', exact: true });
  await add.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await add.press('Enter');
  assert.equal(await add.inputValue(), '');
  assert.deepEqual(await links(), ['▶️ youtube.com/watch?v=dQw4w9WgXcQ', '🔗 example.com/pancakes']);
  await add.fill('Talk on caching https://talks.example.org/caching');
  await add.press('Enter');
  assert.deepEqual(await links(), ['🔗 Talk on caching', '▶️ youtube.com/watch?v=dQw4w9WgXcQ', '🔗 example.com/pancakes']);
  assert.equal(await pad.locator('.notes-link a').first().getAttribute('target'), '_blank');
  // Pasting one that's there already doesn't add it twice.
  await add.fill('https://example.com/pancakes');
  await add.press('Enter');
  assert.equal(await pad.locator('.notes-link').count(), 3);
  assert.equal(await pad.locator('.notes-folder[data-folder="links"] .notes-folder-count').innerText(), '3');
  await page.waitForFunction(() => document.querySelector('#dock button[aria-label="Notes"] .svc-count')?.textContent === '3');
  await pad.getByRole('button', { name: 'Mark watched: Talk on caching', exact: true }).click();
  assert.deepEqual(await links(), ['▶️ youtube.com/watch?v=dQw4w9WgXcQ', '🔗 example.com/pancakes']);
  await pad.getByRole('button', { name: /^Watched 1$/ }).click();
  assert.deepEqual(await links(), ['🔗 Talk on caching']);
  await pad.getByRole('button', { name: /^To watch 2$/ }).click();
  assert.equal(await pad.locator('.notes-folder[data-folder="links"] .notes-folder-count').innerText(), '2');
  // A link's own note opens on the right, to say what it is.
  await pad.locator('.notes-link', { hasText: 'youtube.com' }).locator('.notes-link-sub').click();
  assert.equal(await title.inputValue(), '');
  assert.equal(await body.inputValue(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await title.fill('Never gonna');
  await pad.locator('.notes-status', { hasText: 'Saved' }).waitFor();
  assert.deepEqual(await links(), ['▶️ Never gonna', '🔗 example.com/pancakes']);
  await pad.screenshot({ path: path.join(screenshotDir, 'links.png') });

  // Your own folder: made from the side, and a note moved into it.
  await pad.getByRole('button', { name: '＋ New folder', exact: true }).click();
  const folderName = pad.getByRole('textbox', { name: 'New folder name', exact: true });
  await folderName.fill('Recipes');
  await folderName.press('Enter');
  assert.deepEqual(await folderLabels(), ['Notes', 'Links to watch', 'Recipes', 'Recently deleted']);
  assert.equal(await pad.locator('.notes-list-title h3').innerText(), '📁 Recipes');
  await pad.locator('.notes-folder[data-folder="notes"]').click();
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  await pad.getByRole('combobox', { name: 'Folder', exact: true }).selectOption({ label: '📁 Recipes' });
  assert.deepEqual(await rows(), []);
  await pad.locator('.notes-folder', { hasText: 'Recipes' }).click();
  assert.deepEqual(await rows(), ['Groceries']);

  // Search looks through every folder.
  await pad.getByRole('searchbox', { name: 'Search notes' }).fill('EGGS');
  assert.equal(await pad.locator('.notes-list-title h3').innerText(), '🔍 1 found');
  assert.match(await pad.locator('.notes-row .notes-row-folder').innerText(), /Recipes/);
  await pad.getByRole('searchbox', { name: 'Search notes' }).fill('');

  // Deleting goes to Recently deleted, and back.
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  await pad.getByRole('button', { name: 'Delete it (to Recently deleted)', exact: true }).click();
  assert.deepEqual(await rows(), []);
  await pad.locator('.notes-folder[data-folder="trash"]').click();
  assert.deepEqual(await rows(), ['Groceries']);
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  assert.equal(await body.evaluate((el) => el.readOnly), true, 'read-only until it’s put back');
  await pad.getByRole('button', { name: 'Put it back where it was', exact: true }).click();
  assert.equal(await pad.locator('.notes-list-title h3').innerText(), '📁 Recipes');
  assert.deepEqual(await rows(), ['Groceries']);

  // A new note left empty doesn't stay.
  const before = kept.notes.length;
  await pad.getByRole('button', { name: 'New note', exact: true }).first().click();
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  await page.waitForFunction((n) => window.__office.store.notes.notes.length === n, before);
  assert.equal(kept.notes.length, before);

  // While the office is out of reach, what's typed stays put, and goes once it's back.
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  await page.evaluate(() => (window.__office.net.up = false));
  const sent = changes.length;
  await body.press('End');
  await body.pressSequentially(' bacon');
  await pad.locator('.notes-status', { hasText: 'out of reach' }).waitFor();
  assert.equal(changes.length, sent, 'nothing sent while away');
  assert.match(await body.inputValue(), /bacon$/);
  await page.evaluate(() => (window.__office.net.up = true));
  await page.waitForFunction(() => window.__office.store.notes.notes.some((n) => n.text.endsWith('bacon')), null, { timeout: 8000 });
  await pad.locator('.notes-status', { hasText: 'Saved' }).waitFor();

  // Back over to the To Do board, and back again: the pad is as it was left.
  await pad.getByRole('button', { name: '🔥 To Do', exact: true }).click();
  await todo.locator('.todo-board').waitFor();
  assert.equal(await todo.evaluate((el) => el.classList.contains('notes-mode')), false);
  await todo.getByRole('button', { name: 'Close', exact: true }).click();

  // Its own button on the top bar opens straight onto it, and a reload keeps it all.
  await page.reload();
  await page.waitForFunction(() => window.__office?.store);
  await page.locator('#dock button[aria-label="Notes"]').click();
  await pad.locator('.notes-pad').waitFor();
  assert.equal(await pad.locator('.notes-list-title h3').innerText(), '📁 Recipes', 'the folder you were in');
  assert.equal(await title.inputValue(), 'Groceries', 'the note you had open');
  assert.equal(await pad.locator('.notes-image').count(), 1);

  // A second window sees changes straight away.
  const other = await context.newPage();
  await other.goto(url);
  await other.waitForFunction(() => window.__office?.store);
  await other.evaluate(() => window.__office.store.notes.notes.length);
  await page.waitForTimeout(300);
  await body.press('End');
  await body.pressSequentially(' + syrup');
  await pad.locator('.notes-status', { hasText: 'Saved' }).waitFor();
  await other.waitForFunction(() => window.__office.store.notes.notes.some((n) => n.text.endsWith('+ syrup')));
  await other.close();

  // A folder renamed in place: double-click it, type, Enter.
  await pad.locator('.notes-folder', { hasText: 'Recipes' }).dblclick();
  const rename = pad.getByRole('textbox', { name: 'Rename Recipes', exact: true });
  assert.equal(await rename.evaluate((el) => el === document.activeElement), true);
  await rename.fill('Cooking');
  await rename.press('Enter');
  assert.deepEqual(await folderLabels(), ['Notes', 'Links to watch', 'Cooking', 'Recently deleted']);
  assert.equal(await pad.locator('.notes-list-title h3').innerText(), '📁 Cooking');

  // Narrow: one pane at a time, with a way back.
  await page.setViewportSize({ width: 520, height: 900 });
  await page.waitForTimeout(200);
  const shown = () => pad.evaluate((el) => [...el.querySelectorAll('.notes-pad > aside, .notes-pad > section')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.className));
  await pad.locator('.notes-row', { hasText: 'Groceries' }).click();
  assert.deepEqual(await shown(), ['notes-editor']);
  const widths = await pad.evaluate((el) => [el.querySelector('.notes-pad').clientWidth, el.querySelector('.notes-editor').clientWidth]);
  assert.equal(widths[1], widths[0], 'the one pane fills the width');
  await pad.screenshot({ path: path.join(screenshotDir, 'narrow-note.png') });
  await pad.getByRole('button', { name: '‹ Notes', exact: true }).click();
  assert.deepEqual(await shown(), ['notes-listpane']);
  await pad.getByRole('button', { name: '‹ Folders', exact: true }).click();
  assert.deepEqual(await shown(), ['notes-side']);
  await pad.screenshot({ path: path.join(screenshotDir, 'narrow-folders.png') });

  assert.deepEqual(errors, []);
  console.log(`notes-ui: ok (${changes.length} changes; screenshots in ${screenshotDir})`);
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
