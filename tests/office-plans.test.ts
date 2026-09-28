import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { UsageError } from '../bin/office-queue.js';
import { buildRequest, formatPlans, main, parseArgs } from '../bin/office-plans.js';

const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'w1', token: 'tok' };

test('parses list, add, set and remove', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['--help']), { cmd: 'help' });
  assert.deepEqual(parseArgs(['list']), { cmd: 'list' });
  assert.deepEqual(parseArgs(['add']), { cmd: 'add' });
  assert.deepEqual(parseArgs(['add', '--text', 'Buy milk']), { cmd: 'add', text: 'Buy milk' });
  assert.deepEqual(parseArgs(['add', '--text=Buy milk']), { cmd: 'add', text: 'Buy milk' });
  assert.deepEqual(parseArgs(['set', 'abc', 'in-progress']), { cmd: 'set', id: 'abc', status: 'progress' });
  assert.deepEqual(parseArgs(['move', 'abc', 'done']), { cmd: 'set', id: 'abc', status: 'finished' });
  assert.deepEqual(parseArgs(['set', 'abc', 'To-Do']), { cmd: 'set', id: 'abc', status: 'todo' });
  assert.deepEqual(parseArgs(['remove', 'abc']), { cmd: 'remove', id: 'abc' });
  const bad: [string[], RegExp][] = [
    [['frob'], /Unknown command/],
    [['list', 'x'], /takes no arguments/],
    [['set', 'abc'], /set takes an item id and a column/],
    [['set', 'abc', 'later'], /one of todo, progress, finished/],
    [['remove'], /remove takes one item id/],
    [['add', 'text'], /Unexpected argument/],
    [['add', '--text'], /--text needs a value/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

test('builds the /office/plans requests', () => {
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(buildRequest({ cmd: 'list' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/plans?worker=w1', headers: auth });
  const add = buildRequest({ cmd: 'add' }, OFFICE, '  Buy milk\r\nand eggs \n');
  assert.equal(add.method, 'POST');
  assert.equal(add.url, 'http://127.0.0.1:4455/office/plans?worker=w1');
  assert.deepEqual(add.headers, { ...auth, 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(add.body!), { action: 'add', text: 'Buy milk\nand eggs' });
  assert.deepEqual(JSON.parse(buildRequest({ cmd: 'add', text: 'from the flag' }, OFFICE, 'from stdin').body!), { action: 'add', text: 'from the flag' });
  assert.deepEqual(JSON.parse(buildRequest({ cmd: 'set', id: 'a', status: 'finished' }, OFFICE).body!), { action: 'edit', id: 'a', status: 'finished' });
  assert.deepEqual(JSON.parse(buildRequest({ cmd: 'remove', id: 'a' }, OFFICE).body!), { action: 'remove', id: 'a' });
  assert.throws(() => buildRequest({ cmd: 'add' }, OFFICE, ' \n'), /needs its text/);
});

test('lists the board column by column', () => {
  assert.equal(formatPlans({ items: [] }), 'The To Do Next board is empty.');
  const text = formatPlans({
    items: [
      { id: 'b', status: 'finished', text: 'Renew insurance' },
      { id: 'a', status: 'todo', text: '\nBuy milk\nand eggs' },
      { id: 'c', status: 'progress', text: 'Fix the gate', worker: { id: 'w', name: 'Byte' }, task: 't1' },
    ],
  });
  assert.equal(text, ['3 items · 1 to do, 1 in progress, 1 finished', 'a  todo      Buy milk', 'c  progress  Fix the gate · worker Byte · task t1', 'b  finished  Renew insurance'].join('\n'));
});

/** Runs main() against a fake fetch; returns what it printed and what it sent. */
async function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; status?: number; body?: unknown } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 200 });
  };
  const code = await main(argv, {
    env: opts.env ?? ENV,
    stdin: Readable.from(opts.stdin === undefined ? [] : [opts.stdin]),
    fetch,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

test('add sends the text from stdin and prints the new item id; refusals and a missing office are clear', async () => {
  const r = await run(['add'], { stdin: 'Buy milk\n', body: { ok: true, item: { id: 'p1', text: 'Buy milk', status: 'todo' } } });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'p1');
  assert.match(r.err, /Added it to To Do \(p1\)/);
  assert.equal(r.sent[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(r.sent[0].init.body)), { action: 'add', text: 'Buy milk' });

  const listed = await run(['list'], { body: { revision: 3, items: [{ id: 'p1', status: 'todo', text: 'Buy milk' }] } });
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^1 item · 1 to do, 0 in progress, 0 finished\np1  todo\s+Buy milk$/);

  const moved = await run(['set', 'p1', 'progress'], { body: { ok: true } });
  assert.equal(moved.out, 'Moved p1 to progress.');
  assert.deepEqual(JSON.parse(String(moved.sent[0].init.body)), { action: 'edit', id: 'p1', status: 'progress' });

  const noEnv = await run(['list'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  assert.match(noEnv.err, /^office-plans: AGENT_OFFICE_HOOK_URL, AGENT_OFFICE_WORKER_ID, AGENT_OFFICE_HOOK_TOKEN aren't set/);

  const refused = await run(['set', 'p1', 'todo'], { status: 404, body: { error: 'That plan no longer exists.' } });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^office-plans: The office said no \(404\): That plan no longer exists\./);

  const noText = await run(['add'], { stdin: '' });
  assert.equal(noText.code, 2);
  assert.equal(noText.sent.length, 0);
  assert.match(noText.err, /needs its text[^]*Usage:/);
});
