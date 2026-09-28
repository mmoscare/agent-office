import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ASSUMPTIONS, claudeMonthly, codexCost, estimate, weekPace, type LedgerFacts } from '../src/shared/ledger.js';
import { Ledger } from '../src/server/usage.js';
import { ledgerFacts } from '../src/server/ledger-facts.js';
import type { AgentProvider, Usage, UsageState, WorkerInfo } from '../src/shared/protocol.js';

const zero: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0 };
const officeUsage: UsageState = { total: zero, today: zero, day: '2026-09-28', pauseHiring: false };
const worker = (provider: AgentProvider | undefined, usage?: Usage): WorkerInfo => ({
  id: 'worker', name: 'Test', kind: 'agent', provider, usage, deskId: 'desk-1', color: '#fff',
  status: 'working', acked: false, createdBy: 'Test', createdAt: 1, cols: 80, rows: 24, viewers: [],
});
const floor = (defaultProvider: AgentProvider, workers: WorkerInfo[]) => ({
  project: { defaultProvider }, workers: { list: () => workers },
});

test('live ledger aggregates every floor, using each floor default and explicit worker providers', () => {
  const floors = [
    floor('codex', [worker(undefined, { ...zero, input: 100, output: 20, reasoning: 5 })]),
    floor('opencode', [worker(undefined, { ...zero, cost: 2 }), worker('codex', { ...zero, input: 200, cacheRead: 50 })]),
    floor('claude', [worker('claude', { ...zero, cost: 10 }), { ...worker('opencode'), kind: 'shell' as const }]),
  ];
  const result = ledgerFacts(officeUsage, floors);
  assert.deepEqual(result.codex, { input: 300, cacheRead: 50, cacheWrite: 0, output: 25, sessions: 2, unknown: 0 });
  assert.deepEqual(result.opencode, { cost: 2, sessions: 1, unknown: 0 });
  assert.deepEqual(ledgerFacts(officeUsage, [...floors].reverse()), result);
  // A later snapshot reflects workers removed from a floor; no stale browser cache.
  assert.equal(ledgerFacts(officeUsage, floors.slice(0, 1)).codex.sessions, 1);
});

test('OpenCode awaiting reports, unknown prices and partial reports remain unavailable until usable', () => {
  const workers = [worker(undefined), worker('opencode', { ...zero, costKnown: false }), worker('opencode', { ...zero, cost: 2, incomplete: true })];
  const floors = [floor('opencode', workers)];
  const waiting = ledgerFacts(officeUsage, floors);
  assert.equal(waiting.opencode.unknown, 3);
  assert.equal(estimate(DEFAULT_ASSUMPTIONS, waiting).lines.find(l => l.item === 'OpenCode workers')!.usage, null);
  for (const w of workers) w.usage = { ...zero, cost: 1, costKnown: true };
  const ready = ledgerFacts(officeUsage, floors);
  assert.deepEqual(ready.opencode, { cost: 3, sessions: 3, unknown: 0 });
  assert.equal(estimate(DEFAULT_ASSUMPTIONS, ready).unknown.recurring, 0);
});

test('a waiting Codex session prevents a partial known total from being presented as complete', () => {
  const result = ledgerFacts(officeUsage, [floor('codex', [worker(undefined), worker(undefined, { ...zero, input: 100 })])]);
  assert.equal(result.codex.unknown, 1);
  assert.equal(estimate(DEFAULT_ASSUMPTIONS, result).lines.find(l => l.item === 'Codex workers')!.usage, null);
});

const facts = (over: Partial<LedgerFacts> = {}): LedgerFacts => ({
  claude: { today: 0, total: 0, calls: 0 },
  codex: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sessions: 0 },
  opencode: { cost: 0, sessions: 0 },
  ...over,
});

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test('Claude spend runs out to a month from the last 30 days, or from today without them', () => {
  near(claudeMonthly({ today: 1, month: { cost: 30, days: 10 }, total: 30, calls: 100 }), 3 * (730 / 24));
  near(claudeMonthly({ today: 2, total: 2, calls: 10 }), 2 * (730 / 24));
});

test('Codex tokens are priced at the chosen API rate', () => {
  // 1M fresh input at $2, 1M cached at $0.20, 1M output at $12.
  near(codexCost({ input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 }, 'terra'), 14.2);
});

test('the recurring basis bills the plans; the usage basis bills the tokens', () => {
  const a = { ...DEFAULT_ASSUMPTIONS, claudePlan: 'max20' as const, chatgptPlan: 'plus' as const, hosting: 'own' as const, watts: 100, kwh: 0.2, hoursPerDay: 12 };
  const e = estimate(a, facts({ claude: { today: 0, month: { cost: 300, days: 30 }, total: 300, calls: 5000 } }));
  const claude = e.lines.find((l) => l.item.startsWith('Claude Code'))!;
  near(claude.recurring!, 200);
  near(claude.usage!, 300 * (730 / 24) / 30);
  const codex = e.lines.find((l) => l.item === 'Codex workers')!;
  near(codex.recurring!, 20);
  // No Codex session at a desk: its usage is unavailable, not $0.
  assert.equal(codex.usage, null);
  assert.equal(e.unknown.usage, 1);
  const power = e.lines.find((l) => l.item.startsWith('Electricity'))!;
  near(power.recurring!, 0.1 * 730 * 0.2);
  near(power.usage!, 0.1 * 12 * (730 / 24) * 0.2);
  near(e.recurring, e.lines.reduce((s, l) => s + (l.recurring ?? 0), 0));
  // Haiku task cards come out of the plan on the recurring basis.
  assert.equal(e.lines.find((l) => l.item.startsWith('Task cards'))!.recurring, 0);
});

test('unknown costs stay unavailable instead of being guessed', () => {
  const none = estimate({ ...DEFAULT_ASSUMPTIONS, chatgptPlan: 'none' }, facts());
  const codex = none.lines.find((l) => l.item === 'Codex workers')!;
  assert.equal(codex.usage, null);
  assert.equal(codex.recurring, null);
  assert.equal(none.unknown.recurring, 1);
  const oc = estimate(DEFAULT_ASSUMPTIONS, facts({ opencode: { cost: 1, sessions: 1, unknown: 1 } }));
  const line = oc.lines.find((l) => l.item === 'OpenCode workers')!;
  assert.equal(line.usage, null);
  assert.equal(line.recurring, null);
  const priced = estimate(DEFAULT_ASSUMPTIONS, facts({ codex: { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0, sessions: 1 } }));
  near(priced.lines.find((l) => l.item === 'Codex workers')!.usage!, 2 * (730 / 24));
  assert.deepEqual(priced.unknown, { usage: 0, recurring: 0 });
});

test('an AWS office bills its disk and address even when paused', () => {
  const paused = estimate({ ...DEFAULT_ASSUMPTIONS, hosting: 'aws-paused', diskGb: 50 }, facts());
  near(paused.lines.find((l) => l.item === 'EC2 instance')!.recurring!, 0);
  near(paused.lines.find((l) => l.item.startsWith('EBS'))!.recurring!, 4);
  near(paused.lines.find((l) => l.item.startsWith('Elastic IP'))!.recurring!, 3.65);
  const up = estimate({ ...DEFAULT_ASSUMPTIONS, hosting: 'aws', hoursPerDay: 24 }, facts());
  const ec2 = up.lines.find((l) => l.item === 'EC2 instance')!;
  near(ec2.usage!, ec2.recurring!);
});

test('the week pace runs the percent used out to the reset', () => {
  const now = 0;
  const week = 7 * 24 * 3600_000;
  assert.equal(weekPace(30, now + week / 2, now), 60);
  assert.equal(weekPace(5, now + week, now), null);
});

test('the office ledger reports the last 30 days of spend', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const day = (ago: number) => {
    const d = new Date();
    d.setDate(d.getDate() - ago);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const u = (cost: number) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost, calls: 1 });
  writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ total: u(111), days: { [day(40)]: u(100), [day(4)]: u(5), [day(0)]: u(6) } }));
  const ledger = new Ledger(dir, { pauseHiring: false }, () => {}, () => {});
  t.after(() => ledger.flush());
  assert.deepEqual(ledger.state().month, { cost: 11, days: 5 });
});
