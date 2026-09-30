// npm run build && node tests/limit-budget-ui.mjs [screenshot-dir]
// The daily budget in the ⏳ Claude limits panel, against a local WebSocket fixture: today's share of
// each weekly limit, the tick on the meter, and the warning (a toast and a desktop notification)
// that goes up once a budget day. No agents or real office are started.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';

const codeDir = path.resolve(import.meta.dirname, '..');
const screenshotDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(codeDir, '.agent-office/limit-budget-check');
await mkdir(screenshotDir, { recursive: true });
const server = await preview({ configFile: false, root: codeDir, build: { outDir: 'dist/public' }, preview: { host: '127.0.0.1', port: 0, open: false, proxy: {} } });
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const wss = new WebSocketServer({ server: server.httpServer, path: '/ws' });

const HOUR = 3_600_000;
// Day 2 of the week, 8.6 hours in: today's budget is up to 2/7 (29%) of each weekly limit.
const resetsAt = Date.now() + 7 * 24 * HOUR - (24 + 8.6) * HOUR;
let limits = {
  plan: 'max',
  at: Date.now(),
  windows: [
    { label: '5h session', pct: 72, resetsAt: Date.now() + 2 * HOUR },
    { label: 'Week', pct: 50, resetsAt },
    { label: 'Fable week', pct: 20, resetsAt },
  ],
};
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
const send = (ws, msg) => ws.send(JSON.stringify(msg));
wss.on('connection', (ws) => {
  send(ws, {
    t: 'welcome', you: 'test', peers: [], floors: [{ id: 'app', name: 'Agent Office', palette: 0, dir: '/test/app', addedAt: 1, addedBy: 'Test', people: 0, workers: 0 }],
    projectsDir: '/test', ice: [], chat: [], invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    usage: { total: zero, today: zero, day: '', pauseHiring: false }, limits,
    machine: { cpu: 0, cores: 4, memUsed: 0, memTotal: 1, history: [], workers: 0 },
    theme: { pick: 'auto', active: null }, me: { admin: false }, notify: {}, sky: { lat: 43, lon: -79, utcOffset: -240, weather: 'clear', intensity: 0 },
    floor: 'app', project: { name: 'Agent Office', dir: '/test/app', agentCmd: 'claude', defaultProvider: 'claude', agentProviders: ['claude'] }, workers: [],
    issues: { items: [], fetchedAt: 1, loading: false }, pulls: { items: [], fetchedAt: 1, loading: false },
    queue: { tasks: [], maxWorkers: 0 }, decor: [], services: { items: [], port: 1 }, dog: null,
    meeting: { current: null, past: [] }, cabinet: { player: null, scores: [] },
    jukebox: { on: false, track: 'rainy-window', startedAt: 0, elapsed: 0 }, whiteboard: { elements: [], people: [] },
  });
});
const publish = () => { for (const ws of wss.clients) send(ws, { t: 'limits', state: limits }); };

let browser;
let page;
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // One context, so a second tab shares this one's storage and Web Locks.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.route('**/api/**', (route) => {
    const target = new URL(route.request().url());
    const data = target.pathname === '/api/balances' ? { providers: [], at: 0 } : { me: { admin: false } };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  const init = () => {
    localStorage.setItem('agent-office.profile', JSON.stringify({ name: 'Test', color: '#ff8a5b', look: { skin: 0, hair: 0, style: 0 } }));
    localStorage.setItem('agent-office.settings', JSON.stringify({ view: 'third', muted: true, musicMuted: true, hud: { limits: true } }));
    // Desktop notifications, allowed and recorded, as if the office were in another tab.
    window.__notes = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(title, opts) { window.__notes.push({ title, ...opts }); }
      close() {}
    };
    Document.prototype.hasFocus = () => false;
  };
  await page.addInitScript(init);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = page.locator('#limits');
  const warningsIn = (p) => p.locator('.toast', { hasText: "Today's Claude budget is used up" });
  const warnings = warningsIn(page);
  const notesIn = (p) => p.evaluate(() => window.__notes.filter((n) => n.tag === 'limit-budget'));

  await page.goto(url);
  await panel.locator('.budget-day').first().waitFor();
  // One budget line under each weekly meter, none under the 5-hour session.
  assert.equal(await panel.locator('.budget-day').count(), 2);
  assert.equal(await panel.locator('.meter .mark').count(), 2);
  const [week, fable] = await panel.locator('.budget-day').allInnerTexts();
  assert.match(week, /Today\s*21% over\s*back /);
  assert.match(fable, /Today\s*9% left\s*\+14% in /);
  assert.equal(await panel.locator('.budget-day b.over').count(), 1);
  // 50% in 32.6 hours: the rest lasts about as long again.
  assert.match(await panel.locator('.budget-pace').innerText(), /At this pace, runs out \w{3} \d+:\d\d\s?[AP]M \(est\.\)/);
  const mark = await panel.locator('.meter .mark').first().getAttribute('style');
  assert.match(mark, /left:\s*28\.57/);
  assert.match(await panel.locator('.budget-day').first().getAttribute('title'), /equal share of the week, 14\.3% a day[\s\S]*Day 2 of 7/);

  // The week is past today's share: warned in the office and on the desktop, about that one only.
  await warnings.waitFor();
  assert.match(await warnings.innerText(), /You're about to run out: the week \(all models\) is at 50%, past today's budget of 29%; at this pace it runs out .+ \(est\.\), before it starts over/);
  assert.doesNotMatch(await warnings.innerText(), /Fable/);
  let notes = await page.evaluate(() => window.__notes.filter((n) => n.tag === 'limit-budget'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "⏳ Today's Claude budget is used up");
  await panel.screenshot({ path: path.join(screenshotDir, 'limits-budget.png') });
  await warnings.screenshot({ path: path.join(screenshotDir, 'limits-budget-warning.png') });

  // Once a budget day: coming back to the office doesn't warn again.
  await page.reload();
  await panel.locator('.budget-day').first().waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await warnings.count(), 0);
  assert.equal(await page.evaluate(() => window.__notes.filter((n) => n.tag === 'limit-budget').length), 0);

  // A second tab of the office in the same browser, which the week's warning also counts for.
  const page2 = await context.newPage();
  await page2.addInitScript(init);
  page2.on('pageerror', (e) => errors.push(e.message));
  await page2.goto(url);
  await page2.locator('#limits .budget-day').first().waitFor();
  await page2.waitForTimeout(1500);
  assert.equal(await warningsIn(page2).count(), 0);

  // The Fable week then goes past today's share too. That one is new, and both tabs get the update
  // at once: exactly one of them warns.
  limits = { ...limits, at: Date.now(), windows: limits.windows.map((w) => (w.label === 'Fable week' ? { ...w, pct: 31 } : w)) };
  publish();
  const tabs = [page, page2];
  // Polled on a timer, not on animation frames, which a tab in the background may not get.
  const warned = () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes("Today's Claude budget is used up"));
  const updated = () => document.querySelectorAll('#limits .budget-day')[1]?.textContent.includes('2% over');
  await Promise.any(tabs.map((p) => p.waitForFunction(warned, null, { polling: 250, timeout: 60_000 })));
  await Promise.all(tabs.map((p) => p.waitForFunction(updated, null, { polling: 250, timeout: 60_000 })));
  await page.waitForTimeout(2000);
  const shown = await Promise.all(tabs.map((p) => warningsIn(p).count()));
  assert.deepEqual([...shown].sort(), [0, 1], `warnings per tab: ${shown}`);
  const winner = tabs[shown.indexOf(1)];
  assert.match(await warningsIn(winner).innerText(), /the Fable week is at 31%, past today's budget of 29%/);
  assert.doesNotMatch(await warningsIn(winner).innerText(), /the week \(all models\)/);
  notes = [...(await notesIn(page)), ...(await notesIn(page2))];
  assert.equal(notes.length, 1);

  assert.deepEqual(errors, []);
  console.log(`limit budget UI ok; screenshots in ${screenshotDir}`);
} catch (e) {
  if (page) await page.screenshot({ path: path.join(screenshotDir, 'failure.png') }).catch(() => {});
  throw e;
} finally {
  await browser?.close();
  wss.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
