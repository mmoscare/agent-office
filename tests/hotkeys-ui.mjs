// npm run build && node tests/hotkeys-ui.mjs [screenshot-dir]
// The built client against a WebSocket fixture (no server, no agents). J goes to the boss's office and
// T's circle ends there; O stays the desk key (a worker's PR, a board agent's terminal, an issue note);
// U still summons the staffer.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { summarizeWorkers } from '../dist/server/shared/attention.js';

const codeDir = path.resolve(import.meta.dirname, '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (shots) await mkdir(shots, { recursive: true });
const OFFICE = { x: 11.2, y: 3, z: 9.4, facing: -Math.PI / 2 };
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });
const worker = (id, status, extra = {}) => ({
  id, name: id, kind: 'agent', provider: 'codex', deskId: 'desk-1', color: '#4f86f7',
  status, acked: false, createdBy: 'Test', createdAt: 1, cols: 80, rows: 24, viewers: [], viewerIds: [], ...extra,
});
const now = new Date().toISOString();
const pull = { number: 12, url: 'https://github.com/example/project/pull/12', headRefName: 'office/original', baseRefName: 'personal', title: 'A PR opened from a desk', state: 'OPEN', isDraft: false, author: 'tester', labels: [], reviewDecision: '', checks: 'pass', additions: 12, deletions: 2, createdAt: now, updatedAt: now, body: 'Test PR', closes: [] };
const issue = { number: 7, title: 'A note to read with O', state: 'OPEN', url: 'https://github.com/example/project/issues/7', author: 'tester', labels: [], assignees: [], createdAt: now, updatedAt: now, body: 'Read me', comments: 0 };
const workers = [
  // Done with a PR, and nobody has looked: T's circle stops behind it.
  worker('Original', 'done', { deskId: 'desk-1', pr: { number: 12, url: pull.url }, worktree: { path: '/test/wt', branch: 'office/original', base: 'personal' }, waitingSince: Date.now() - 60000 }),
  // The PR board agent, seen to already: not waiting.
  worker('Prague', 'done', { deskId: 'station-pulls', acked: true }),
];
const floors = [{ id: 'app', name: 'Agent Office', palette: 0, workers }];
const info = f => ({ id: f.id, name: f.name, palette: f.palette, dir: `/test/${f.id}`, addedAt: 1, addedBy: 'Test', people: 0, ...summarizeWorkers(f.workers) });
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const sent = [];
wss.on('connection', ws => {
  ws.send(JSON.stringify({
    t: 'welcome', you: 'test', peers: [], floors: floors.map(info), projectsDir: '/test', ice: [], chat: [],
    invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits: { windows: [], at: 0 },
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null }, me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 },
    floor: 'app', project: { name: 'Agent Office', dir: '/test/app', agentCmd: 'codex', defaultProvider: 'codex', agentProviders: ['codex'] }, workers,
    issues: { items: [issue], fetchedAt: 1, loading: false }, pulls: { items: [pull], fetchedAt: 1, loading: false },
    queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
    meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
    jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
  }));
  ws.on('message', data => sent.push(JSON.parse(String(data))));
});

let browser;
let page;
const done = [];
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(60000);
  await page.route('**/api/**', route => {
    const target = new URL(route.request().url());
    let data = { me: { admin: false } };
    if (target.pathname === '/api/balances') data = { providers: [], at: 0 };
    if (target.pathname === '/api/gh/pull/diff') return route.fulfill({ body: '' });
    if (target.pathname === '/api/gh/pull') data = { ...pull, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', comments: [], reviews: [], reviewComments: [], checks: [], commits: 1, repo: { methods: ['squash'] }, viewer: 'tester' };
    if (target.pathname === '/api/gh/issue') data = { ...issue, comments: [], viewer: 'tester' };
    if (target.pathname === '/api/workspace/repositories') data = { repositories: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true }));
    // The wall shows the floor's GitHub issues (it shows your To Do unless flipped).
    localStorage.setItem('agent-office.issuesWall', 'issues');
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__office?.store.floor === 'app' && window.__office.store.workers.size === 2);
  await page.addStyleTag({ content: '.calendar-nag, .mail-nag { display: none !important; }' });

  const pos = () => page.evaluate(() => { const p = window.__office.player; return { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2), facing: +p.facing.toFixed(3) }; });
  const placeAt = (x, z, facing = 0) => page.evaluate(([x, z, facing]) => {
    const p = window.__office.player;
    p.pos.set(x, 0, z);
    p.vy = 0;
    p.facing = facing;
    p.camYaw = facing - Math.PI;
  }, [x, z, facing]);
  const inOffice = () => page.waitForFunction(o => {
    const p = window.__office.player.pos;
    return Math.hypot(p.x - o.x, p.z - o.z) < 0.3 && Math.abs(p.y - o.y) < 0.3;
  }, OFFICE, { polling: 100 });
  const hint = () => page.locator('#hint').innerText().catch(() => '');
  const hintHas = text => page.waitForFunction(t => { const el = document.getElementById('hint'); return !!el && !el.classList.contains('hidden') && el.innerText.includes(t); }, text, { polling: 200 });
  const toasts = () => page.locator('.toast').allTextContents().catch(() => []);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, name) }); };

  // 1. J from the middle of the floor: the boss's office, facing west over the glass.
  await placeAt(0, 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyJ');
  await inOffice();
  const atOffice = await pos();
  assert.ok(Math.abs(atOffice.facing - OFFICE.facing) < 0.01, `J faces west: ${JSON.stringify(atOffice)}`);
  assert.ok((await toasts()).some(t => t.includes("Boss's office")), `J toasts: ${JSON.stringify(await toasts())}`);
  await shot('j-office.png');
  done.push(`J → office ${JSON.stringify(atOffice)}`);

  // 2. O with nothing in reach doesn't go anywhere (it isn't the office key any more).
  await placeAt(0, 2);
  await page.waitForTimeout(800);
  const before = await pos();
  await page.keyboard.press('KeyO');
  await page.waitForTimeout(1500);
  const after = await pos();
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.2 && after.y < 1, `O with nothing in reach stays put: ${JSON.stringify({ before, after })}`);
  done.push('O with nothing in reach: stays put');

  // 3. T: behind the waiting worker; its hint offers O for its PR, and O opens it.
  await page.keyboard.press('KeyT');
  await page.waitForFunction(() => { const p = window.__office.player.pos; const d = window.__office.office.desks.get('desk-1').def; return Math.hypot(p.x - d.x, p.z - d.z) < 3.5 && p.y < 1; }, null, { polling: 100 });
  await hintHas('Original');
  const deskHint = await hint();
  assert.match(deskHint, /O\s*PR #12/, `desk hint offers O for the PR: ${deskHint}`);
  await shot('t-desk-hint.png');
  const behindDesk = await pos();
  await page.keyboard.press('KeyO');
  const prDialog = page.getByRole('dialog', { name: 'Pull request #12', exact: true });
  await prDialog.waitFor();
  if (shots) await prDialog.screenshot({ path: path.join(shots, 'o-desk-pr.png') });
  // J inside the PR window is its own (next file), not a trip to the office.
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(1500);
  const inWindow = await pos();
  assert.ok(Math.hypot(inWindow.x - behindDesk.x, inWindow.z - behindDesk.z) < 0.2, `J in the PR window stays put: ${JSON.stringify({ behindDesk, inWindow })}`);
  await prDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await prDialog.waitFor({ state: 'detached' });
  done.push(`T → behind Original (hint: ${deskHint.replace(/\s+/g, ' ')}); O → Pull request #12; J in the PR window stays put`);

  // 4. T again: after the last waiting worker, back in the boss's office.
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyT');
  await inOffice();
  assert.ok((await toasts()).some(t => t.includes('Back in the office')), `T ends in the office: ${JSON.stringify(await toasts())}`);
  done.push(`T again → office ${JSON.stringify(await pos())}`);

  // 5. O at the PR board agent's kiosk opens its terminal.
  const kiosk = await page.evaluate(() => { const d = window.__office.office.desks.get('station-pulls').def; return { x: d.x, z: d.z }; });
  await placeAt(kiosk.x, kiosk.z + 1.6, Math.PI);
  await hintHas('Terminal');
  const kioskHint = await hint();
  await shot('o-kiosk-hint.png');
  await page.keyboard.press('KeyO');
  const term = page.getByRole('dialog', { name: 'Prague terminal', exact: true });
  await term.waitFor();
  await term.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await term.waitFor({ state: 'detached' });
  done.push(`O at the PR agent's kiosk → Prague terminal (hint: ${kioskHint.replace(/\s+/g, ' ')})`);

  // 6. U still summons the staffer.
  await placeAt(2, 3);
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyU');
  await page.waitForFunction(() => window.__office.staffer.phase === 'to');
  done.push('U → staffer on his way');

  // 7. O at a note on the issues board reads it: the mouse over the note (third person).
  const board = await page.evaluate(() => {
    const m = window.__office.office.boardMeshes.issues;
    const c = m.getWorldPosition(m.position.clone());
    return { x: c.x, y: c.y, z: c.z };
  });
  await placeAt(board.x, board.z + 1.8, Math.PI);
  await page.evaluate(b => {
    const o = window.__office;
    o.player.updateCamera = () => {};
    o.camera.position.set(b.x, b.y + 0.2, b.z + 3.2);
    o.camera.lookAt(b.x, b.y, b.z);
    o.camera.updateMatrixWorld();
  }, board);
  await hintHas('Issues board');
  const point = await page.evaluate(b => {
    const o = window.__office;
    const p = o.office.boardMeshes.issues.getWorldPosition(o.camera.position.clone());
    p.project(o.camera);
    const r = o.renderer.domElement.getBoundingClientRect();
    return { x: r.x + (p.x + 1) * r.width / 2, y: r.y + (1 - p.y) * r.height / 2 };
  }, board);
  await page.mouse.move(point.x - 5, point.y - 5);
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await hintHas('Read it');
  const noteHint = await hint();
  await shot('o-note-hint.png');
  await page.keyboard.press('KeyO');
  const issueDialog = page.getByRole('dialog', { name: 'Issue #7', exact: true });
  await issueDialog.waitFor();
  if (shots) await issueDialog.screenshot({ path: path.join(shots, 'o-note-issue.png') });
  done.push(`O at a note → Issue #7 (hint: ${noteHint.replace(/\s+/g, ' ')})`);

  assert.deepEqual(errors, []);
  console.log('PASS:\n- ' + done.join('\n- '));
} catch (error) {
  console.error('Got as far as:\n- ' + done.join('\n- '));
  if (page) {
    console.error('Hint:', await page.locator('#hint').innerText().catch(() => ''), 'Toasts:', await page.locator('.toast').allTextContents().catch(() => []));
    if (shots) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  if (browser) await browser.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.httpServer.close(resolve));
}
