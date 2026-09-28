import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Balances, monthStart, parseEnv } from '../src/server/balances.js';

const NOW = Date.UTC(2026, 8, 17, 15, 30);

/** A fake provider: routes by URL prefix, and records every request. */
function fakeFetch(routes: Record<string, (url: URL, headers: Record<string, string>) => [number, unknown]>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    const headers = init?.headers ?? {};
    calls.push({ url: input, headers });
    const hit = Object.keys(routes).find((prefix) => input.startsWith(prefix));
    const [status, body] = hit ? routes[hit](url, headers) : [404, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

function fixture(t: { after(fn: () => void): void }, env = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-balances-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  if (env) writeFileSync(envFile, env);
  return { dir, envFile };
}

test('parses .env lines with export, quotes, comments and CRLF', () => {
  assert.deepEqual(parseEnv('export A=1\r\nB="two words"\n# C=3\nD=\'x#y\'\nE=val # note\nF=\nbad line\n'), { A: '1', B: 'two words', D: 'x#y', E: 'val' });
});

test('month start is midnight UTC on the 1st', () => {
  assert.equal(new Date(monthStart(NOW)).toISOString(), '2026-09-01T00:00:00.000Z');
});

test('reads xAI credit left from the inverted ledger, finding the team from the API key', async (t) => {
  const { dir, envFile } = fixture(t, 'XAI_MANAGEMENT_KEY=mgmt-1\nXAI_API_KEY=xai-plain\n');
  const f = fakeFetch({
    'https://api.x.ai/v1/api-key': (_u, h) => (h.authorization === 'Bearer xai-plain' ? [200, { team_id: 'team-9' }] : [401, {}]),
    'https://management-api.x.ai/v1/billing/teams/team-9/prepaid/balance': (_u, h) => (h.authorization === 'Bearer mgmt-1' ? [200, { changes: [], total: { val: '-2345' } }] : [401, {}]),
  });
  const b = new Balances(dir, { fetch: f.fn, env: {}, envFile, now: () => NOW });
  const xai = (await b.state()).providers.find((p) => p.provider === 'xai')!;
  assert.equal(xai.status, 'ok');
  assert.equal(xai.source, 'file');
  assert.equal(xai.remainingUsd, 23.45);
});

test('a missing xAI total is an error, never $0.00', async (t) => {
  const { dir } = fixture(t);
  const f = fakeFetch({ 'https://management-api.x.ai/': () => [200, { changes: [] }] });
  const b = new Balances(dir, { fetch: f.fn, env: { XAI_MANAGEMENT_KEY: 'm', XAI_TEAM_ID: 't' }, envFile: path.join(dir, 'none'), now: () => NOW });
  const xai = (await b.state()).providers.find((p) => p.provider === 'xai')!;
  assert.equal(xai.status, 'error');
  assert.equal(xai.remainingUsd, undefined);
});

test('sums OpenAI and Anthropic month-to-date costs across pages, in dollars and cents', async (t) => {
  const { dir } = fixture(t);
  const f = fakeFetch({
    'https://api.openai.com/v1/organization/costs': (u) => {
      assert.equal(u.searchParams.get('start_time'), String(Date.UTC(2026, 8, 1) / 1000));
      return u.searchParams.get('page')
        ? [200, { data: [{ results: [{ amount: { value: 0.5, currency: 'usd' } }] }], has_more: false }]
        : [200, { data: [{ results: [{ amount: { value: 1.25 } }, { amount: { value: 2 } }] }], has_more: true, next_page: 'p2' }];
    },
    'https://api.anthropic.com/v1/organizations/cost_report': (u, h) => {
      assert.equal(u.searchParams.get('starting_at'), '2026-09-01T00:00:00Z');
      assert.equal(h['anthropic-version'], '2023-06-01');
      return [200, { data: [{ results: [{ amount: '1050.5', currency: 'USD' }] }, { results: [{ amount: '49.5' }] }], has_more: false }];
    },
  });
  const b = new Balances(dir, { fetch: f.fn, env: { OPENAI_ADMIN_KEY: 'sk-admin-x', ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-y' }, envFile: path.join(dir, 'none'), now: () => NOW });
  const s = await b.state();
  const openai = s.providers.find((p) => p.provider === 'openai')!;
  const anthropic = s.providers.find((p) => p.provider === 'anthropic')!;
  assert.equal(openai.spentMonthUsd, 3.75);
  assert.equal(openai.source, 'env');
  assert.equal(anthropic.spentMonthUsd, 11);
});

test('ordinary API keys are never sent to billing endpoints: the panel asks for an admin key', async (t) => {
  const { dir, envFile } = fixture(t, 'OPENAI_API_KEY=sk-proj-abc\nANTHROPIC_API_KEY=sk-ant-api03-abc\n');
  const f = fakeFetch({});
  const env: Record<string, string | undefined> = {};
  const b = new Balances(dir, { fetch: f.fn, env, envFile, now: () => NOW });
  const s = await b.state();
  assert.equal(s.providers.find((p) => p.provider === 'openai')!.status, 'needs-admin');
  assert.equal(s.providers.find((p) => p.provider === 'anthropic')!.status, 'needs-admin');
  assert.equal(s.providers.find((p) => p.provider === 'xai')!.status, 'signed-out');
  assert.equal(f.calls.length, 0);
  // The .env is read privately: workers inheriting the environment never see it.
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('an admin key under the ordinary name still counts', async (t) => {
  const { dir, envFile } = fixture(t, 'ANTHROPIC_API_KEY=sk-ant-admin01-z\n');
  const f = fakeFetch({ 'https://api.anthropic.com/': () => [200, { data: [], has_more: false }] });
  const b = new Balances(dir, { fetch: f.fn, env: {}, envFile, now: () => NOW });
  const a = (await b.state()).providers.find((p) => p.provider === 'anthropic')!;
  assert.equal(a.status, 'ok');
  assert.equal(a.spentMonthUsd, 0);
});

test('a rejected key says so without echoing it', async (t) => {
  const { dir } = fixture(t);
  const f = fakeFetch({ 'https://api.openai.com/': () => [401, { error: { message: 'bad key sk-admin-secret' } }] });
  const b = new Balances(dir, { fetch: f.fn, env: { OPENAI_ADMIN_KEY: 'sk-admin-secret' }, envFile: path.join(dir, 'none'), now: () => NOW });
  const o = (await b.state()).providers.find((p) => p.provider === 'openai')!;
  assert.equal(o.status, 'error');
  assert.doesNotMatch(o.error!, /secret/);
});

test('login checks the key first, saves only a good one, and logout forgets it', async (t) => {
  const { dir } = fixture(t);
  const f = fakeFetch({ 'https://api.openai.com/': (_u, h) => (h.authorization === 'Bearer sk-admin-good' ? [200, { data: [{ results: [{ amount: { value: 7 } }] }] }] : [401, {}]) });
  const b = new Balances(dir, { fetch: f.fn, env: {}, envFile: path.join(dir, 'none'), now: () => NOW });
  const file = path.join(dir, 'balances.json');
  assert.match((await b.login('openai', 'sk-proj-nope'))!, /Admin key/);
  assert.match((await b.login('openai', 'sk-admin-bad'))!, /turned down/);
  assert.equal(existsSync(file), false);
  assert.equal(await b.login('openai', ' sk-admin-good '), undefined);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { openai: { key: 'sk-admin-good' } });
  const o = (await b.state()).providers.find((p) => p.provider === 'openai')!;
  assert.equal(o.source, 'saved');
  assert.equal(o.spentMonthUsd, 7);
  // A fresh office picks the saved key up again.
  const again = new Balances(dir, { fetch: f.fn, env: {}, envFile: path.join(dir, 'none'), now: () => NOW });
  assert.equal((await again.state()).providers.find((p) => p.provider === 'openai')!.status, 'ok');
  b.logout('openai');
  assert.equal((await b.state()).providers.find((p) => p.provider === 'openai')!.status, 'signed-out');
});

test('answers are cached; a refresh reads again only once the last read is 30s old', async (t) => {
  const { dir } = fixture(t);
  let now = NOW;
  const f = fakeFetch({ 'https://api.openai.com/': () => [200, { data: [] }] });
  const b = new Balances(dir, { fetch: f.fn, env: { OPENAI_ADMIN_KEY: 'sk-admin-x' }, envFile: path.join(dir, 'none'), now: () => now });
  await b.state();
  await b.state();
  await b.state(true);
  assert.equal(f.calls.length, 1);
  now += 31_000;
  await b.state(true);
  assert.equal(f.calls.length, 2);
  now += 60_000;
  await b.state();
  assert.equal(f.calls.length, 2);
  now += 5 * 60_000;
  await b.state();
  assert.equal(f.calls.length, 3);
});
