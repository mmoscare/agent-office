import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../bin/office-queue.js';
import { buildRequest, formatInbox, formatItem, main, parseArgs } from '../bin/office-inbox.js';

const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'w1', token: 'tok' };

test('parses list, read and archive, with names that have spaces in them', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['list']), { cmd: 'list' });
  assert.deepEqual(parseArgs(['ls']), { cmd: 'list' });
  assert.deepEqual(parseArgs(['read', 'Voice Memo 3.m4a']), { cmd: 'read', name: 'Voice Memo 3.m4a' });
  assert.deepEqual(parseArgs(['cat', 'Voice', 'Memo', '3.m4a']), { cmd: 'read', name: 'Voice Memo 3.m4a' });
  assert.deepEqual(parseArgs(['archive', 'note.md']), { cmd: 'archive', name: 'note.md' });
  assert.deepEqual(parseArgs(['done', 'note.md']), { cmd: 'archive', name: 'note.md' });
  const bad: [string[], RegExp][] = [
    [['frob'], /Unknown command/],
    [['list', 'x'], /takes no arguments/],
    [['read'], /read takes the item's name/],
    [['archive', '--all'], /archive takes the item's name/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

test('builds the /office/inbox requests', () => {
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(buildRequest({ cmd: 'list' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/inbox?worker=w1', headers: auth });
  assert.deepEqual(buildRequest({ cmd: 'read', name: 'a b.md' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/inbox?worker=w1&read=a+b.md', headers: auth });
  const put = buildRequest({ cmd: 'archive', name: 'a b.md' }, OFFICE);
  assert.equal(put.method, 'POST');
  assert.equal(put.url, 'http://127.0.0.1:4455/office/inbox?worker=w1');
  assert.deepEqual(JSON.parse(put.body!), { action: 'archive', name: 'a b.md' });
});

test('lists the tray and shows an item readably', () => {
  assert.equal(formatInbox({ dir: '/x/inbox', items: [] }), 'The in-tray is empty (/x/inbox).');
  const text = formatInbox({
    dir: '/x/inbox',
    items: [
      { name: '20260928-091233-call-the-dentist.md', kind: 'note', title: 'Call the dentist', from: 'Ada', preview: 'Tuesday or Thursday' },
      { name: 'memo.m4a', kind: 'file', title: 'memo.m4a' },
    ],
  });
  assert.equal(text, [
    '2 items in the tray (/x/inbox)',
    '20260928-091233-call-the-dentist.md',
    '    📝 Call the dentist · file 20260928-091233-call-the-dentist.md · from Ada · Tuesday or Thursday',
    'memo.m4a',
    '    📎 memo.m4a',
  ].join('\n'));
  assert.equal(formatItem({ item: { name: 'a.md', kind: 'note', title: 'Call the dentist', from: 'Ada' }, body: 'Tuesday', path: '/x/inbox/a.md' }), '📝 Call the dentist · from Ada · at /x/inbox/a.md\n\nTuesday');
  assert.match(formatItem({ item: { name: 'a.md', kind: 'note', title: 'T' }, body: 'x', path: '/p', truncated: true }), /the note goes on/);
  assert.equal(formatItem({ item: { name: 'memo.m4a', kind: 'file', title: 'memo.m4a' }, path: '/x/inbox/memo.m4a' }), '📎 memo.m4a · at /x/inbox/memo.m4a\nA file, not a note: open it with your own tools by that path.');
});

/** Runs main() against a fake fetch; returns what it printed and what it sent. */
async function run(argv: string[], opts: { env?: Record<string, string>; status?: number; body?: unknown } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 200 });
  };
  const code = await main(argv, { env: opts.env ?? ENV, fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

test('reads and archives through the office, and says so; refusals are clear', async () => {
  const read = await run(['read', 'a.md'], { body: { item: { name: 'a.md', kind: 'note', title: 'T' }, body: 'hello', path: '/x/a.md' } });
  assert.equal(read.code, 0);
  assert.equal(read.out, '📝 T · at /x/a.md\n\nhello');
  assert.equal(read.sent[0].url, 'http://127.0.0.1:4455/office/inbox?worker=w1&read=a.md');

  const put = await run(['archive', 'a.md'], { body: { ok: true, path: '/x/archive/a.md' } });
  assert.equal(put.code, 0);
  assert.equal(put.out, 'Put a.md away (/x/archive/a.md).');

  const gone = await run(['archive', 'b.md'], { status: 404, body: { error: 'That is not in the tray (any more).' } });
  assert.equal(gone.code, 1);
  assert.match(gone.err, /^office-inbox: The office said no \(404\): That is not in the tray/);

  const noEnv = await run(['list'], { env: {} });
  assert.equal(noEnv.code, 1);
  assert.equal(noEnv.sent.length, 0);
  assert.match(noEnv.err, /^office-inbox: AGENT_OFFICE_HOOK_URL/);
});
