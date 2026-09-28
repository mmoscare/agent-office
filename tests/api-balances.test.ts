import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiBalances, anthropicDailySpend, lookback, openaiDailySpend, summarize, xaiPrepaidBalance, type FetchLike } from '../src/server/api-balances.js';
import { estimatedBalance } from '../src/shared/api-balances.js';

const DAY = 86_400_000;
/** 2026-09-27T15:00Z */
const NOW = Date.UTC(2026, 8, 27, 15);
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-office-balances-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake network: one handler per URL prefix, recording every request. */
function network(routes: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const route = Object.keys(routes).find((k) => `${u.origin}${u.pathname}`.startsWith(k));
    if (!route) return new Response('nope', { status: 404 });
    return routes[route](u, init);
  };
  return { fetchFn, calls };
}

test('Anthropic cost report: cents strings summed per day, paginated, walked a month at a time', async () => {
  const net = network({
    'https://api.anthropic.com/v1/organizations/cost_report': (u) => {
      assert.equal(u.searchParams.get('bucket_width'), '1d');
      const from = Date.parse(u.searchParams.get('starting_at')!);
      if (u.searchParams.get('page') === 'p2') return json({ data: [{ starting_at: new Date(from + DAY).toISOString(), results: [{ currency: 'USD', amount: '250' }] }], has_more: false });
      return json({ data: [{ starting_at: new Date(from).toISOString(), results: [{ currency: 'USD', amount: '123.4' }, { currency: 'USD', amount: '100' }] }], has_more: true, next_page: 'p2' });
    },
  });
  const days = await anthropicDailySpend('sk-ant-admin-test', day(2026, 8, 1), net.fetchFn, NOW);
  assert.equal(net.calls.length, 4, 'two 31-day windows, two pages each');
  assert.equal(net.calls[0].init?.headers && (net.calls[0].init.headers as Record<string, string>)['x-api-key'], 'sk-ant-admin-test');
  assert.deepEqual(days.slice(0, 2), [{ day: day(2026, 8, 1), usd: 2.234 }, { day: day(2026, 8, 2), usd: 2.5 }]);
});

test('OpenAI costs: USD floats summed per day with pagination', async () => {
  const net = network({
    'https://api.openai.com/v1/organization/costs': (u, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-admin-test');
      const start = Number(u.searchParams.get('start_time'));
      assert.equal(start, day(2026, 9, 1) / 1000);
      if (u.searchParams.get('page') === 'next') return json({ data: [{ start_time: start + 86_400, results: [{ amount: { value: 0.5, currency: 'usd' } }] }], has_more: false });
      return json({ data: [{ start_time: start, results: [{ amount: { value: 1.25, currency: 'usd' } }, { amount: { value: 0.75, currency: 'usd' } }] }], has_more: true, next_page: 'next' });
    },
  });
  const days = await openaiDailySpend('sk-admin-test', day(2026, 9, 1), net.fetchFn);
  assert.deepEqual(days, [{ day: day(2026, 9, 1), usd: 2 }, { day: day(2026, 9, 2), usd: 0.5 }]);
});

test('xAI prepaid balance: the inverted cents ledger becomes remaining dollars', async () => {
  const net = network({ 'https://management-api.x.ai/v1/billing/teams/team_1/prepaid/balance': () => json({ changes: [], total: { val: '-1234' } }) });
  assert.equal(await xaiPrepaidBalance('xai-mgmt', 'team_1', net.fetchFn), 12.34);
});

test('rejected keys and outages become short reasons, not crashes', async () => {
  const bad = network({ 'https://management-api.x.ai/': () => json({ error: 'invalid token' }, 401) });
  await assert.rejects(xaiPrepaidBalance('x', 't', bad.fetchFn), /xAI: key rejected \(invalid token\)/);
  const down: FetchLike = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(openaiDailySpend('x', NOW, down), /OpenAI: could not connect/);
});

test('summarize: this month, and spend since the console balance without the part already counted', () => {
  const days = [
    { day: day(2026, 8, 30), usd: 4 },
    { day: day(2026, 9, 1), usd: 1 },
    { day: day(2026, 9, 26), usd: 3 },
    { day: day(2026, 9, 27), usd: 2.5 },
  ];
  assert.deepEqual(summarize(days, undefined, NOW), { spentMonth: 6.5 });
  // Typed at 10:00 on the 26th when $1 of that day was already reported.
  const credits = { amount: 20, at: day(2026, 9, 26) + 10 * 3_600_000, baseline: 1 };
  const s = summarize(days, credits, NOW);
  assert.deepEqual(s, { spentMonth: 6.5, spentSinceCredits: 4.5 });
  assert.equal(estimatedBalance({ provider: 'anthropic', configured: true, credits, ...s }), 15.5);
  assert.equal(lookback(credits, NOW), day(2026, 9, 1), 'the month start is earlier than the typed day');
  assert.equal(lookback({ ...credits, at: day(2026, 8, 20) }, NOW), day(2026, 8, 20));
});

test('the office keeps keys out of the browser, prefers the environment, caches reads and saves 0600', async (t) => {
  const dir = fixture(t);
  let now = NOW;
  let openaiReads = 0;
  const net = network({
    'https://api.openai.com/v1/organization/costs': (u) => {
      openaiReads++;
      const start = Number(u.searchParams.get('start_time')) * 1000;
      const earlier = start < day(2026, 9, 27) ? [{ start_time: day(2026, 9, 26) / 1000, results: [{ amount: { value: 1, currency: 'usd' } }] }] : [];
      return json({ data: [...earlier, { start_time: day(2026, 9, 27) / 1000, results: [{ amount: { value: 0.4, currency: 'usd' } }] }], has_more: false });
    },
    'https://management-api.x.ai/v1/billing/teams/team_9/prepaid/balance': () => json({ total: { val: '-500' } }),
  });
  const env = { AGENT_OFFICE_XAI_MANAGEMENT_KEY: 'env-xai', AGENT_OFFICE_XAI_TEAM_ID: 'team_9' };
  const office = new ApiBalances(dir, env, net.fetchFn, () => now);

  let state = await office.read(false, true);
  assert.equal(state.editable, true);
  assert.deepEqual(state.providers.map((p) => [p.provider, p.configured, p.source ?? null]), [['anthropic', false, null], ['openai', false, null], ['xai', true, 'env']]);
  assert.equal(state.providers[2].reportedBalance, 5);
  assert.equal(JSON.stringify(state).includes('env-xai'), false, 'keys never leave the server');

  await assert.rejects(office.update({ provider: 'xai', key: 'other' }), /AGENT_OFFICE_XAI_MANAGEMENT_KEY/);
  await assert.rejects(office.update({ provider: 'xai', credits: 5 }), /reports its own balance/);
  await assert.rejects(office.update({ provider: 'openai', key: 'has space' }), /does not look like/);

  state = await office.update({ provider: 'openai', key: 'sk-admin-file' });
  const openai = state.providers[1];
  assert.equal(openai.source, 'file');
  assert.equal(openai.spentMonth, 1.4);
  assert.equal(openai.credits, undefined);
  const saved = JSON.parse(readFileSync(path.join(dir, 'api-balances.json'), 'utf8'));
  assert.equal(saved.providers.openai.key, 'sk-admin-file');
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'api-balances.json')).mode & 0o777, 0o600);

  // Typing the console balance records what today had already cost, so the estimate starts at the typed figure.
  state = await office.update({ provider: 'openai', credits: 20 });
  assert.equal(state.providers[1].credits?.baseline, 0.4);
  assert.equal(estimatedBalance(state.providers[1]), 20);

  // Within five minutes nothing is asked again; a click asks again after a minute.
  const before = openaiReads;
  await office.read();
  assert.equal(openaiReads, before);
  now += 30_000;
  await office.read(true);
  assert.equal(openaiReads, before);
  now += 31_000;
  await office.read(true);
  assert.equal(openaiReads, before + 1);

  // A restart reads the file back; an unreadable provider keeps its last numbers with the reason.
  const again = new ApiBalances(dir, env, async (url, init) => (String(url).includes('openai') ? json({ error: { message: 'nope' } }, 403) : net.fetchFn(url, init)), () => now + 10 * 60_000);
  state = await again.read();
  assert.equal(state.providers[1].configured, true);
  assert.match(state.providers[1].error ?? '', /OpenAI: key not allowed to read billing \(nope\)/);
  assert.equal(state.providers[1].credits?.amount, 20);

  state = await again.update({ provider: 'openai', key: null, credits: null });
  assert.equal(state.providers[1].configured, false);
  assert.equal(state.providers[1].error, undefined);
});
