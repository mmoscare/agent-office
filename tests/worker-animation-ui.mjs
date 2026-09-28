// node tests/worker-animation-ui.mjs
// Exercise the real character in a browser, without connecting to an office or provider.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const server = await createServer({
  configFile: false, root, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'worker-animation-fixture', configureServer(server) {
    server.middlewares.use('/worker-fixture', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Worker animation regression</title>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.AGENT_OFFICE_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/worker-fixture`);
  const results = await page.evaluate(async () => {
    const { Worker } = await import('/src/client/world/character.ts');
    const { STATUS_LABEL } = await import('/src/client/ui/dom.ts');
    const w = new Worker('Kilo regression', '#9bc53d');
    let time = 0;
    const frames = count => {
      for (let i = 0; i < count; i++) w.update(1 / 60, time += 1 / 60);
    };
    const range = values => Math.max(...values) - Math.min(...values);
    const sample = () => {
      const left = [], right = [];
      for (let i = 0; i < 60; i++) {
        frames(1);
        left.push(w.armL.rotation.x);
        right.push(w.armR.rotation.x);
      }
      return Math.max(range(left), range(right));
    };
    const stopped = [];
    for (const status of ['paused', 'interrupted', 'idle', 'starting', 'done', 'offline', 'exited']) {
      // The action hint deliberately remains stale. Status must override it immediately.
      w.setStatus('working', false);
      w.setAction('edit');
      frames(120);
      const typing = sample();
      w.setStatus(status, false);
      frames(60);
      stopped.push({ status, typing, movement: sample(), arm: w.armL.rotation.x,
        label: STATUS_LABEL[status], bubble: w.bubbleKey });
    }
    w.setStatus('working', false);
    frames(90);
    const resumed = sample();
    w.setStatus('needs_input', true);
    frames(210);
    const waiting = w.acts.get('waiting') ?? 0;
    w.setStatus('done', true);
    frames(60);
    const completed = w.acts.get('up') ?? 0;
    w.setStatus('paused', false);
    frames(60);
    const stoppedAfterBounce = sample();
    return { stopped, resumed, waiting, completed, stoppedAfterBounce };
  });
  for (const row of results.stopped) {
    assert.ok(row.typing > 0.1, `${row.status}: setup was visibly typing`);
    assert.ok(row.movement < 1e-8, `${row.status}: arms must stop moving within one second`);
    assert.ok(Math.abs(row.arm + 0.3) < 1e-8, `${row.status}: arms return to rest`);
    if (row.status === 'paused' || row.status === 'interrupted') {
      assert.equal(row.label, row.status);
      assert.ok(row.bubble.includes(row.status), 'status bubble identifies the stopped turn');
    }
  }
  assert.ok(results.resumed > 0.1, 'resuming work resumes typing');
  assert.ok(results.waiting > 0.9, 'a live question retains the waiting pose');
  assert.ok(results.completed > 0.9, 'normal completion retains the done bounce');
  assert.ok(results.stoppedAfterBounce < 1e-8, 'pausing also clears a previous bounce');
  assert.deepEqual(errors, []);
  console.log('PASS: real character rests in all seven inactive states, resumes typing, labels stopped turns, and preserves waiting and completion poses.');
} finally {
  await browser?.close();
  await server.close();
}
