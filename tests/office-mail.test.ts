import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { UsageError, parseArgs as queueArgs, buildRequest as queueRequest } from '../bin/office-queue.js';
import { parseArgs as plansArgs, buildRequest as plansRequest } from '../bin/office-plans.js';
import { formatInbox, formatItem, mailLine } from '../bin/office-inbox.js';
import { buildRequest, formatStatus, main, parseArgs } from '../bin/office-mail.js';
import { buildRequest as askRequest, main as askMain, parseArgs as askArgs } from '../bin/office-ask.js';

const ENV = { AGENT_OFFICE_HOOK_URL: 'http://127.0.0.1:4455', AGENT_OFFICE_WORKER_ID: 'w1', AGENT_OFFICE_HOOK_TOKEN: 'tok' };
const OFFICE = { url: 'http://127.0.0.1:4455', worker: 'w1', token: 'tok' };

async function run(fn: typeof main, argv: string[], opts: { stdin?: string; status?: number; body?: unknown } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 200 });
  };
  const code = await fn(argv, { env: ENV, stdin: Readable.from(opts.stdin === undefined ? [] : [opts.stdin]), fetch, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  return { code, sent, out: out.join('\n'), err: err.join('\n') };
}

test('office-mail: status, reply and send, with their mistakes explained', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'help' });
  assert.deepEqual(parseArgs(['status']), { cmd: 'status' });
  assert.deepEqual(parseArgs(['reply', '2026-a b.md']), { cmd: 'reply', item: '2026-a b.md' });
  assert.deepEqual(parseArgs(['reply', 'x.md', '--text', 'Hi']), { cmd: 'reply', item: 'x.md', text: 'Hi' });
  assert.deepEqual(parseArgs(['send', '--subject', ' Heads up ']), { cmd: 'send', subject: 'Heads up' });
  const bad: [string[], RegExp][] = [
    [['frob'], /Unknown command/],
    [['status', 'x'], /takes no arguments/],
    [['reply'], /reply takes the tray item/],
    [['send'], /--subject/],
    [['send', 'words', '--subject', 's'], /Unexpected argument: words/],
    [['reply', 'x.md', '--subject', 's'], /Unknown option for reply: --subject/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(' '));
  assert.deepEqual(buildRequest({ cmd: 'status' }, OFFICE), { method: 'GET', url: 'http://127.0.0.1:4455/office/mail?worker=w1', headers: { authorization: 'Bearer tok' } });
  assert.deepEqual(JSON.parse(buildRequest({ cmd: 'reply', item: 'a.md' }, OFFICE, ' Done!\r\n').body!), { action: 'reply', item: 'a.md', text: 'Done!' });
  assert.deepEqual(JSON.parse(buildRequest({ cmd: 'send', subject: 'S' }, OFFICE, 'Body').body!), { action: 'send', subject: 'S', text: 'Body' });
  assert.throws(() => buildRequest({ cmd: 'send', subject: 'S' }, OFFICE, '  '), /needs its text/);
});

test('office-mail: her status nags when the mailbox is not set up, and says what works when it is', () => {
  assert.match(formatStatus({ configured: false }), /isn't set up yet[^]*press I for the In-tray, then 📧 Set up email/);
  const ok = formatStatus({ configured: true, address: 'r@x.com', owners: ['me@x.com'], autoTriage: true, briefing: '08:00', awayAlerts: true });
  assert.match(ok, /^📧 Your mailbox: r@x\.com\nWho may email you work \(and the only people you can write to\): me@x\.com\n✅ Working\.\nAlso: you are woken when new mail comes in; a morning briefing goes out at 08:00; the owner is emailed/);
  assert.match(formatStatus({ configured: true, address: 'r@x.com', problem: 'The mailbox refused the sign-in' }), /⚠️ It isn't working right now: The mailbox refused the sign-in/);
});

test('office-mail: a reply goes out from stdin and says to whom; a refusal is passed on', async () => {
  const r = await run(main, ['reply', 'a.md'], { stdin: 'Queued it for you.\n', body: { ok: true, to: 'me@x.com' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Sent to me@x.com.');
  assert.deepEqual(JSON.parse(String(r.sent[0].init.body)), { action: 'reply', item: 'a.md', text: 'Queued it for you.' });
  const refused = await run(main, ['reply', 'b.md'], { stdin: 'x', status: 400, body: { error: "b.md isn't from an allowed sender: she only writes to the people here" } });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /said no \(400\): b\.md isn't from an allowed sender/);
  const status = await run(main, ['status'], { body: { configured: false } });
  assert.match(status.out, /isn't set up yet/);
});

test('office-ask: hands a request to the Issues or PR agent', async () => {
  assert.deepEqual(askArgs(['issues']), { cmd: 'ask', to: 'issues' });
  assert.deepEqual(askArgs(['PR', '--text', 'Review #4']), { cmd: 'ask', to: 'pulls', text: 'Review #4' });
  assert.throws(() => askArgs(['queue']), /Ask the issues or the pulls agent/);
  assert.throws(() => askArgs(['issues', 'extra']), /Unexpected argument/);
  assert.deepEqual(JSON.parse(askRequest({ cmd: 'ask', to: 'issues' }, OFFICE, ' File a bug: x ').body!), { to: 'issues', text: 'File a bug: x' });
  assert.throws(() => askRequest({ cmd: 'ask', to: 'pulls' }, OFFICE, ''), /needs its text/);
  const r = await run(askMain, ['issues'], { stdin: 'File it', body: { ok: true, agent: 'Issues agent', hired: true } });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Asked the Issues agent (it came in for it).');
  assert.equal(r.sent[0].url, 'http://127.0.0.1:4455/office/ask?worker=w1');
  const busy = await run(askMain, ['pulls'], { stdin: 'Review', status: 409, body: { error: 'The PR agent is waiting on an answer in its terminal' } });
  assert.equal(busy.code, 1);
  assert.match(busy.err, /\(409\): The PR agent is waiting/);
});

test('--mail links a queued task or a To Do Next item to the email it came from', () => {
  assert.deepEqual(queueArgs(['add', '--title', 'T', '--mail', 'a.md']), { cmd: 'add', title: 'T', mail: 'a.md' });
  assert.deepEqual(JSON.parse(queueRequest({ cmd: 'add', title: 'T', mail: 'a.md' }, OFFICE, 'do it').body!), { title: 'T', prompt: 'do it', mail: 'a.md' });
  assert.throws(() => queueArgs(['add', '--title', 'T', '--mail', ' ']), /--mail takes the in-tray item/);
  assert.deepEqual(plansArgs(['add', '--mail', 'b.md']), { cmd: 'add', mail: 'b.md' });
  assert.deepEqual(JSON.parse(plansRequest({ cmd: 'add', mail: 'b.md' }, OFFICE, 'Call mum').body!), { action: 'add', text: 'Call mum', mail: 'b.md' });
});

test('office-inbox shows which items came by email, from whom, and how her mailbox stands', () => {
  assert.equal(mailLine({ configured: false }), "📧 Email isn't set up yet: remind the people here (an admin sets it up with I → 📧 Set up email).");
  assert.equal(mailLine({ configured: true, address: 'r@x.com' }), '📧 Email: r@x.com');
  const list = formatInbox({
    dir: '/t',
    mail: { configured: true, address: 'r@x.com' },
    items: [{ name: 'a.md', kind: 'note', title: 'Renew', mail: { from: 'me@x.com', name: 'Me', subject: 'Renew', trusted: true } }, { name: 'b.md', kind: 'note', title: 'Spam', mail: { from: 's@y.com', subject: 'Spam', trusted: false } }],
  });
  assert.equal(list, ['2 items in the tray (/t)', '📧 Email: r@x.com', 'a.md', '    📧 Renew · file a.md · email from Me <me@x.com>, ✅ allowed sender', 'b.md', '    📧 Spam · file b.md · email from s@y.com, ⚠️ not an allowed sender'].join('\n'));
  assert.match(formatInbox({ dir: '/t', items: [], mail: { configured: false } }), /^The in-tray is empty \(\/t\)\.\n📧 Email isn't set up yet/);
  const item = formatItem({ item: { name: 'a.md', kind: 'note', title: 'Renew' }, body: 'text', path: '/t/a.md', mail: { from: 'me@x.com', name: 'Me', subject: 'Renew', trusted: true } });
  assert.match(item, /^📧 Renew · at \/t\/a\.md\nAn email from Me <me@x\.com>: ✅ an allowed sender, so reply with office-mail reply a\.md, and pass --mail a\.md when you queue or file it\.\n\ntext$/);
});
