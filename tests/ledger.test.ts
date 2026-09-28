import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ASSUMPTIONS, claudeMonthly, codexCost, estimate, weekPace, type LedgerFacts } from '../src/shared/ledger.js';
import { Ledger } from '../src/server/usage.js';

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
  near(claude.recurring, 200);
  near(claude.usage, 300 * (730 / 24) / 30);
  const codex = e.lines.find((l) => l.item === 'Codex workers')!;
  near(codex.recurring, 20);
  near(codex.usage, 0);
  const power = e.lines.find((l) => l.item.startsWith('Electricity'))!;
  near(power.recurring, 0.1 * 730 * 0.2);
  near(power.usage, 0.1 * 12 * (730 / 24) * 0.2);
  near(e.recurring, e.lines.reduce((s, l) => s + l.recurring, 0));
  // Haiku task cards come out of the plan on the recurring basis.
  assert.equal(e.lines.find((l) => l.item.startsWith('Task cards'))!.recurring, 0);
});

test('an AWS office bills its disk and address even when paused', () => {
  const paused = estimate({ ...DEFAULT_ASSUMPTIONS, hosting: 'aws-paused', diskGb: 50 }, facts());
  near(paused.lines.find((l) => l.item === 'EC2 instance')!.recurring, 0);
  near(paused.lines.find((l) => l.item.startsWith('EBS'))!.recurring, 4);
  near(paused.lines.find((l) => l.item.startsWith('Elastic IP'))!.recurring, 3.65);
  const up = estimate({ ...DEFAULT_ASSUMPTIONS, hosting: 'aws', hoursPerDay: 24 }, facts());
  const ec2 = up.lines.find((l) => l.item === 'EC2 instance')!;
  near(ec2.usage, ec2.recurring);
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
