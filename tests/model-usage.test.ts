import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelUsageLedger } from '../src/server/model-usage.js';
import { modelUsageTotals } from '../src/shared/model-usage.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (changes: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id: 'worker-a', kind: 'agent', provider: 'codex', deskId: 'desk-1', name: 'Pixel', color: '#ffffff',
  status: 'done', acked: true, createdBy: 'Owner', createdAt: 123, cols: 80, rows: 24, viewers: [], sessionId: 'session-a',
  usage: { input: 700, output: 100, reasoning: 100, cacheRead: 100, cacheWrite: 0, totalTokens: 1000, calls: 0, callsKnown: false, cost: 0, costKnown: false },
  ...changes,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-usage-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('agent-office-usage-'));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('cumulative snapshots replace earlier reports, survive restart, and deduplicate resumed sessions', t => {
  const dir = fixture(t);
  const ledger = new ModelUsageLedger(dir);
  ledger.record('Portfolio', worker());
  ledger.record('Portfolio', worker());
  ledger.record('Portfolio', worker({ usage: { ...worker().usage!, input: 1700, totalTokens: 2000 } }));
  ledger.flush();
  const restored = new ModelUsageLedger(dir);
  assert.equal(modelUsageTotals(restored.list()).tokens, 2000);
  restored.record('Dashboard', worker({ id: 'worker-b', usage: { ...worker().usage!, input: 2700, totalTokens: 3000 } }));
  assert.equal(restored.list().length, 1);
  assert.equal(modelUsageTotals(restored.list()).tokens, 3000);
  restored.record('Dashboard', worker({ id: 'worker-b', sessionId: 'session-b' }));
  assert.equal(restored.list().length, 2);
  restored.flush();
});

test('Claude worker lifetime totals are not counted again after a session clear', t => {
  const ledger = new ModelUsageLedger(fixture(t));
  const w = worker({ provider: 'claude' });
  ledger.record('Portfolio', w);
  ledger.record('Portfolio', { ...w, sessionId: 'new-session', usage: { ...w.usage!, input: 1700, totalTokens: 2000 } });
  assert.equal(ledger.list().length, 1);
  assert.equal(modelUsageTotals(ledger.list()).tokens, 2000);
  ledger.flush();
});

test('unknown Codex costs stay unknown while known OpenCode estimates contribute to totals', t => {
  const ledger = new ModelUsageLedger(fixture(t));
  ledger.record('Portfolio', worker());
  ledger.record('Portfolio', worker({ provider: 'opencode', model: 'xai/example', usage: { ...worker().usage!, cost: 1.25, costKnown: true, incomplete: true } }));
  assert.deepEqual(modelUsageTotals(ledger.list()), { tokens: 2000, cost: 1.25, unknown: 1, partial: 1 });
  ledger.flush();
});

test('invalid usage is ignored and existing history is preserved if its file is unreadable', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'model-usage.json');
  writeFileSync(file, '{broken history');
  const ledger = new ModelUsageLedger(dir);
  ledger.record('Portfolio', worker({ usage: { ...worker().usage!, input: -1 } }));
  assert.equal(ledger.list().length, 0);
  ledger.record('Portfolio', worker());
  ledger.flush();
  assert.match(ledger.saveError!, /preserved/);
  assert.equal(readFileSync(file, 'utf8'), '{broken history');
});
