import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { UsageError } from '../bin/office-queue.js';
import { buildRequest, formatPrs, formatStatus, formatWorkers, main, parseArgs } from '../bin/office-vp.js';

const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'vp1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'vp1', token: 'tok' };

test('parses the commands', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['status']), { cmd: 'status', json: false });
  assert.deepEqual(parseArgs(['sweep', '--dry-run']), { cmd: 'sweep', json: false, dryRun: true });
  assert.deepEqual(parseArgs(['verify', '#12', '--repo', 'o/r']), { cmd: 'verify', json: false, repo: 'o/r', pr: 12 });
  assert.deepEqual(parseArgs(['merge', '12', '--wait=2']), { cmd: 'merge', json: false, waitMin: 2, pr: 12 });
  assert.deepEqual(parseArgs(['wake', 'Pixel', '--say', 'carry on']), { cmd: 'wake', json: false, say: 'carry on', worker: 'Pixel' });
  assert.deepEqual(parseArgs(['duty', 'on', '--every', '15m']), { cmd: 'duty', json: false, everyMin: 15, on: true });
  const bad: [string[], RegExp][] = [
    [['frob'], /Unknown command/],
    [['merge'], /a PR number/],
    [['merge', 'x'], /a PR number/],
    [['duty', 'maybe'], /on or off/],
    [['duty', 'on', '--every', 'soon'], /--every takes minutes/],
    [['status', 'x'], /takes no arguments/],
    [['sweep', '--force'], /Unknown option/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

test('builds the /office/vp requests', () => {
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(buildRequest(parseArgs(['status']), OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/vp?worker=vp1&view=status', headers: auth });
  const merge = buildRequest(parseArgs(['merge', '7']), OFFICE);
  assert.equal(merge.method, 'POST');
  assert.deepEqual(JSON.parse(merge.body!), { action: 'merge', pr: 7 });
  assert.deepEqual(JSON.parse(buildRequest(parseArgs(['nudge', 'Pixel']), OFFICE, ' commit and push\r\n').body!), { action: 'nudge', worker: 'Pixel', text: 'commit and push' });
  assert.throws(() => buildRequest(parseArgs(['nudge', 'Pixel']), OFFICE, '  '), /Give the message on stdin/);
  assert.deepEqual(JSON.parse(buildRequest(parseArgs(['duty', 'off']), OFFICE).body!), { action: 'duty', on: false });
});

test('a sweep is started, followed while it runs, and its result printed by group', async () => {
  const calls: string[] = [];
  let polls = 0;
  const fetch = (async (url: string, init: { method: string; body?: string }) => {
    calls.push(`${init.method} ${url}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init.method === 'POST') return json({ ok: true, job: 'j1' });
    polls++;
    if (polls < 2) return json({ id: 'j1', log: ['00:00:01 🔎 Verifying test/x#1'] });
    return json({
      id: 'j1',
      finishedAt: 5,
      log: ['00:00:01 🔎 Verifying test/x#1', '00:01:00 ✅ Merged test/x#1'],
      result: { prs: [{ repo: 'test/x', number: 1, title: 'Add it', url: 'https://github.com/test/x/pull/1', group: 'merged', why: 'merged abc into personal' }, { repo: 'test/x', number: 2, title: 'Other', url: 'u2', group: 'working', why: 'Pixel at Desk 3 (office/pixel-2) is working' }], fixes: [], escalations: [], pulled: ['test/x: the floor\'s checkout is up to date with personal'], errors: [] },
    });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['sweep'], { env: ENV, fetch, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {}, stdin: Readable.from([]) });
  assert.equal(code, 0);
  assert.match(calls[0], /^POST http:\/\/127\.0\.0\.1:4455\/office\/vp\?worker=vp1$/);
  assert.match(calls[1], /view=job&id=j1/);
  assert.deepEqual(err, ['00:00:01 🔎 Verifying test/x#1', '00:01:00 ✅ Merged test/x#1'], 'each log line once');
  assert.match(out.join('\n'), /🎉 Merged \(1\)\n {2}#1 Add it \[test\/x\] — merged abc into personal/);
  assert.match(out.join('\n'), /👷 Being worked on \(1\)/);
});

test('a refusal is said plainly and never retried another way', async () => {
  const fetch = (async () => new Response(JSON.stringify({ error: 'Only the VP can use office-vp' }), { status: 403 })) as unknown as typeof fetch;
  const err: string[] = [];
  const code = await main(['merge', '3'], { env: ENV, fetch, out: () => {}, err: (s) => err.push(s), stdin: Readable.from([]) });
  assert.equal(code, 1);
  assert.match(err[0], /office-vp: The office said no \(403\): Only the VP can use office-vp/);
});

test('formats the status, the PR groups and the workers', () => {
  const s = formatStatus({ duty: { on: true, by: 'Michael', at: Date.now() - 60_000, everyMs: 600_000 }, waitingRestart: 2, prs: [], stuck: [{ worker: 'Pixel at Desk 3 (office/pixel-2587)', detail: 'stopped by a restart with its task unfinished', action: 'wake' }] });
  assert.match(s, /On duty since .* \(turned on by Michael\), sweeping every 10 min/);
  assert.match(s, /🔁 2 merges waiting for a restart/);
  assert.match(s, /Pixel at Desk 3 \(office\/pixel-2587\): stopped by a restart .* → wake/);
  assert.equal(formatPrs([]), 'No open pull requests (as of the last sweep).');
  const w = formatWorkers({ workers: [{ seat: 'Pixel at Desk 3 (office/pixel-2587)', status: 'needs_input', for: '12 min', stuck: { detail: 'a permission prompt has been open for 12 min', action: 'escalate' }, tail: 'Do you want to proceed?\n❯ 1. Yes' }] });
  assert.match(w, /escalate to the owner \(never approve it\)/);
  assert.match(w, /│ ❯ 1\. Yes/);
});
