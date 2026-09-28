// Browser smoke test of the actual overhead card/bubble textures; no provider or office is started.
// Run: node tests/worker-status-ui.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const server = await createServer({
  configFile: false, root, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'status-fixture', configureServer(server) {
    server.middlewares.use('/status-smoke', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body style="background:#eee8df;font:18px sans-serif;margin:32px"><h1>Stopped chat status</h1></body></html>');
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${server.resolvedUrls.local[0]}status-smoke`);
  const labels = await page.evaluate(async () => {
    const { Worker } = await import('/src/client/world/character.ts');
    const original = CanvasRenderingContext2D.prototype.fillText;
    const drawn = [];
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      drawn.push(text);
      return original.call(this, text, ...args);
    };
    const results = [];
    for (const [name, status] of [['Claude Code', 'paused'], ['Codex', 'interrupted'], ['Grok / OpenCode', 'interrupted']]) {
      const worker = new Worker(name, '#8ecae6');
      worker.setTask({ name: 'Fix the login', summary: 'Chat stopped; send a message to continue.' });
      drawn.length = 0;
      worker.setStatus(status, false);
      results.push([...drawn]);
      const row = document.createElement('section');
      row.style.cssText = 'display:inline-block;vertical-align:top;width:32%;';
      const title = document.createElement('h2'); title.textContent = name; row.append(title);
      const canvas = worker.bubble.material.map.image;
      canvas.style.width = '95%'; row.append(canvas);
      document.body.append(row);
      worker.setTask(undefined);
      drawn.length = 0;
      worker.setStatus(status, false);
      // setTask already drew the no-task bubble. Its key records the displayed text.
      results.push([worker.bubbleKey]);
      const bubble = worker.bubble.material.map.image;
      bubble.style.cssText = 'display:block;width:85%;margin-top:20px'; row.append(bubble);
      worker.setStatus('working', false);
      results.push([...drawn]);
    }
    CanvasRenderingContext2D.prototype.fillText = original;
    return results;
  });
  assert.ok(labels[0].includes('⏸ PAUSED'));
  assert.ok(labels[1].includes('⏸ paused'));
  for (const offset of [3, 6]) {
    assert.ok(labels[offset].includes('⏹ INTERRUPTED'));
    assert.ok(labels[offset + 1].includes('⏹ interrupted'));
  }
  for (const offset of [2, 5, 8]) assert.ok(labels[offset].includes('⌨️ working'));
  assert.deepEqual(errors, []);
  await mkdir(path.join(root, '.agent-office'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.agent-office/worker-status-smoke.png') });
  console.log('PASS: overhead cards and taskless bubbles show stopped states and clear on resume; no browser errors.');
} finally {
  await browser?.close();
  await server.close();
}
