import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ImapClient, ImapError, imapDate, imapQuote, readResponse } from '../src/server/mail/imap.js';
import { SmtpError, dotStuff, sendMail, verifySmtp } from '../src/server/mail/smtp.js';
import { parseMail } from '../src/server/mail/mime.js';
import { fakeImap, fakeSmtp, localCert, rawMail } from './fake-mail-servers.mjs';

let cert: { key: string; cert: string };
before(async () => {
  cert = await localCert();
});

const imapOpts = (port: number, extra: Record<string, unknown> = {}) => ({ host: 'localhost', port, user: 'receptionist@example.com', pass: 'app-password', ca: cert.cert, timeoutMs: 10_000, ...extra });

test('IMAP: reads responses by length, literals and all, and says how much more it needs', () => {
  const whole = Buffer.from('* 1 FETCH (UID 5 BODY[] {12}\r\nline1\r\nline2 FLAGS ())\r\nA001 OK done\r\n');
  const first = readResponse(whole);
  assert.ok('response' in first);
  if (!('response' in first)) return;
  assert.equal(first.response.tag, '*');
  assert.deepEqual(first.response.literals.map((l) => l.toString()), ['line1\r\nline2']);
  assert.match(first.response.text, /^1 FETCH \(UID 5 BODY\[\] \{12\}\r\n FLAGS \(\)\)$/);
  const second = readResponse(whole.subarray(first.consumed));
  assert.ok('response' in second && second.response.tag === 'A001' && second.response.text === 'OK done');
  const cut = readResponse(Buffer.from('* 1 FETCH (BODY[] {100}\r\nonly a bit'));
  assert.deepEqual(cut, { need: '* 1 FETCH (BODY[] {100}\r\n'.length + 100 + 2 });
  assert.deepEqual(readResponse(Buffer.from('* OK no end yet')), { need: 16 });
  assert.equal(imapQuote('pa"ss\\word'), '"pa\\"ss\\\\word"');
  assert.equal(imapQuote('pässword'), undefined);
  assert.equal(imapDate(Date.UTC(2026, 8, 27, 12)), '27-Sep-2026');
});

test('IMAP: signs in, selects, searches, fetches a big message in pieces, marks it read, signs out', async (t) => {
  const big = rawMail({ subject: 'Big one', body: `${'All work and no play. '.repeat(4000)}\r\n.\r\nA line with just a dot above` });
  const box = await fakeImap({ cert, pass: 'p@ss "quoted" \\ back', messages: [{ uid: 3, raw: rawMail({ subject: 'Old', body: 'old' }), seen: true }, { uid: 9, raw: big }] });
  t.after(() => box.close());
  const c = await ImapClient.open(imapOpts(box.port, { pass: 'p@ss "quoted" \\ back' }));
  const sel = await c.select();
  assert.deepEqual(sel, { uidValidity: 7, uidNext: 10, exists: 2 });
  assert.deepEqual(await c.search('UID 4:*'), [9]);
  assert.deepEqual(await c.search('UNSEEN SINCE 27-Sep-2026'), [9]);
  assert.deepEqual([...(await c.sizes([3, 9])).entries()], [[3, box.messages[0].raw.length], [9, box.messages[1].raw.length]]);
  const raw = await c.fetch(9);
  assert.ok(raw);
  assert.equal(raw!.length, box.messages[1].raw.length);
  assert.deepEqual(raw, box.messages[1].raw);
  assert.equal(parseMail(raw!).subject, 'Big one');
  const head = await c.fetch(9, true);
  assert.match(head!.toString(), /^From: [^]*Subject: Big one[^]*\r\n\r\n$/);
  assert.equal(box.messages[1].seen, false, 'fetching peeks: it stays unread');
  await c.markSeen([9]);
  assert.equal(box.messages[1].seen, true);
  await c.logout();
  assert.ok(box.log.some((l) => l === 'LOGIN "receptionist@example.com" "p@ss \\"quoted\\" \\\\ back"'), 'the password is quoted and escaped');
});

test('IMAP: a password that can\'t be quoted signs in with AUTHENTICATE PLAIN', async (t) => {
  const box = await fakeImap({ cert, pass: 'pässwörd' });
  t.after(() => box.close());
  const c = await ImapClient.open(imapOpts(box.port, { pass: 'pässwörd' }));
  await c.logout();
  assert.ok(box.log.includes('AUTH receptionist@example.com pässwörd'));
  assert.equal(box.logins, 1);
});

test('IMAP: a refused sign-in says so plainly and is marked as a sign-in problem', async (t) => {
  const box = await fakeImap({ cert, refuseLogin: true });
  t.after(() => box.close());
  await assert.rejects(ImapClient.open(imapOpts(box.port)), (e: unknown) => e instanceof ImapError && e.auth && /refused the sign-in \(Invalid credentials \(Failure\)\): check the address/.test(e.message));
});

test('IMAP: an untrusted certificate, a closed port and an unknown host are explained', async (t) => {
  const box = await fakeImap({ cert });
  t.after(() => box.close());
  await assert.rejects(ImapClient.open(imapOpts(box.port, { ca: undefined })), /certificate didn't check out/);
  await assert.rejects(ImapClient.open(imapOpts(1)), /refused the connection|didn't answer/);
  await assert.rejects(ImapClient.open(imapOpts(993, { host: 'no-such-host.invalid' })), /Couldn't find the mail server no-such-host\.invalid/);
});

for (const security of ['tls', 'starttls'] as const) {
  test(`SMTP (${security}): signs in and sends, dot-stuffed, to every recipient`, async (t) => {
    const post = await fakeSmtp({ cert, security });
    t.after(() => post.close());
    const opts = { host: 'localhost', port: post.port, security, user: 'receptionist@example.com', pass: 'app-password', ca: cert.cert, timeoutMs: 10_000 };
    await verifySmtp(opts);
    const message = 'Subject: hi\r\n\r\nfirst\r\n.second starts with a dot\r\n..two dots\r\n';
    await sendMail(opts, 'receptionist@example.com', ['owner@example.com', 'second@example.com'], message);
    assert.equal(post.sent.length, 1);
    assert.deepEqual(post.sent[0].to, ['owner@example.com', 'second@example.com']);
    assert.equal(post.sent[0].from, 'receptionist@example.com');
    assert.equal(post.sent[0].data, message);
    assert.ok(post.log.some((l: string) => l.startsWith('AUTH PLAIN ')));
    if (security === 'starttls') assert.ok(post.log.includes('STARTTLS'));
  });
}

test('SMTP: falls back to AUTH LOGIN, and explains a refused sign-in and a refused recipient', async (t) => {
  const post = await fakeSmtp({ cert, mechanisms: 'LOGIN', rejectRcpt: ['nobody@example.com'] });
  t.after(() => post.close());
  const opts = { host: 'localhost', port: post.port, security: 'tls' as const, user: 'receptionist@example.com', pass: 'app-password', ca: cert.cert, timeoutMs: 10_000 };
  await sendMail(opts, 'receptionist@example.com', ['owner@example.com'], 'Subject: x\r\n\r\ny\r\n');
  assert.ok(post.log.includes('AUTH LOGIN'));
  await assert.rejects(verifySmtp({ ...opts, pass: 'wrong' }), (e: unknown) => e instanceof SmtpError && e.auth && /refused the sign-in \(535/.test(e.message) && !/wrong/.test(e.message));
  await assert.rejects(sendMail(opts, 'receptionist@example.com', ['nobody@example.com'], 'x\r\n'), (e: unknown) => e instanceof SmtpError && e.code === 550 && /said 550 5\.1\.1 No such user to RCPT TO/.test(e.message));
  await assert.rejects(sendMail(opts, 'receptionist@example.com', [], 'x'), /Nobody to send it to/);
});

test('SMTP: STARTTLS on a server that doesn\'t offer it is refused rather than sending the password in the clear', async (t) => {
  const post = await fakeSmtp({ cert, security: 'tls' });
  t.after(() => post.close());
  // The server speaks TLS straight away; a plain STARTTLS client can't even read its greeting, and says what to try.
  await assert.rejects(verifySmtp({ host: 'localhost', port: post.port, security: 'starttls', user: 'u', pass: 'p', ca: cert.cert, timeoutMs: 3000 }), /didn't say hello on port \d+: if that port expects TLS straight away \(like 465\), choose TLS/);
  assert.equal(dotStuff('.a\n.b\r\nc'), '..a\r\n..b\r\nc');
});
