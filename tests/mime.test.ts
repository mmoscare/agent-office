import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMail, decodeWords, encodeHeader, encodeQP, decodeQP, htmlToText, parseAddressList, parseMail, parseParams, senderVerdict, splitMultipart, stripQuoted } from '../src/server/mail/mime.js';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'));

test('a plain message: who, what, when, and its text', () => {
  const m = parseMail(crlf([
    'Return-Path: <owner@example.com>',
    'Delivered-To: receptionist+household@example.com',
    'From: "Moscarelli, Michael" <Owner@Example.com>',
    'To: Receptionist <receptionist+household@example.com>, other@example.com',
    'Subject: Renew the',
    '  car insurance',
    'Date: Mon, 28 Sep 2026 09:12:33 -0400 (EDT)',
    'Message-ID: <abc123@mail.example.com>',
    'In-Reply-To: <prev@office>',
    'References: <first@office>',
    ' <prev@office>',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Before the 15th, please.  ',
    'Thanks!',
    '',
  ]));
  assert.deepEqual(m.from, { name: 'Moscarelli, Michael', address: 'Owner@Example.com' });
  assert.deepEqual(m.to.map((a) => a.address), ['receptionist+household@example.com', 'other@example.com']);
  assert.deepEqual(m.deliveredTo, ['receptionist+household@example.com']);
  assert.equal(m.subject, 'Renew the car insurance');
  assert.equal(m.date, Date.parse('Mon, 28 Sep 2026 09:12:33 -0400'));
  assert.equal(m.messageId, '<abc123@mail.example.com>');
  assert.deepEqual(m.inReplyTo, ['<prev@office>']);
  assert.deepEqual(m.references, ['<first@office>', '<prev@office>']);
  assert.equal(m.text, 'Before the 15th, please.\nThanks!');
  assert.equal(m.attachments.length, 0);
  assert.equal(m.automatic, false);
  assert.equal(m.auth, undefined);
});

test('encoded words: base64 and Q, charsets, and a character split across two words', () => {
  assert.equal(decodeWords('=?UTF-8?B?Q2Fmw6k=?= au lait'), 'Café au lait');
  assert.equal(decodeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?='), 'Café crème');
  assert.equal(decodeWords('=?utf-8?q?Hello?= =?utf-8?q?_World?='), 'Hello World');
  // "é" is C3 A9: the first word ends mid-character, the second finishes it.
  assert.equal(decodeWords('=?UTF-8?B?Q2Fmww==?= =?UTF-8?B?qQ==?='), 'Café');
  assert.equal(decodeWords('plain text'), 'plain text');
  assert.equal(decodeWords('=?bogus-charset?B?SGk=?='), 'Hi');
  const m = parseMail(crlf(['From: =?UTF-8?B?Sm9zw6k=?= <jose@example.com>', 'Subject: =?UTF-8?Q?R=C3=A9sum=C3=A9_=F0=9F=93=8E?=', '', 'x']));
  assert.deepEqual(m.from, { name: 'José', address: 'jose@example.com' });
  assert.equal(m.subject, 'Résumé 📎');
});

test('multipart: the plain part of an alternative, attachments with RFC 2231 names, forwarded messages', () => {
  const pdf = Buffer.from('%PDF-1.4 fake pdf bytes \x00\x01\x02', 'latin1');
  const raw = crlf([
    'From: owner@example.com',
    'Subject: Policy',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    'This is a multi-part message in MIME format.',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'The policy is attached =E2=80=94 renew it before the 15th. This line is long enough that=',
    ' it was soft-wrapped.',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The <b>policy</b> is attached</p>',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=UTF-8''Police%20d%E2%80%99assurance.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--outer',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PNGDATA').toString('base64'),
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: someone@else.com',
    'Subject: the original',
    '',
    'original body',
    '--outer--',
    'epilogue, ignored',
  ]);
  const m = parseMail(raw);
  assert.equal(m.text, 'The policy is attached — renew it before the 15th. This line is long enough that it was soft-wrapped.');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.inline]), [
    ['Police d’assurance.pdf', 'application/pdf', false],
    ['logo.png', 'image/png', true],
    ['forwarded message.eml', 'message/rfc822', true],
  ]);
  assert.deepEqual(m.attachments[0].bytes, pdf);
  assert.match(m.attachments[2].bytes.toString(), /Subject: the original/);
});

test('HTML-only mail becomes readable text, links written out', () => {
  const m = parseMail(crlf([
    'From: owner@example.com',
    'Content-Type: text/html; charset=windows-1252',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;there,</p><p>Book the <a href=3D"https://example.com/flights">flights</a> for Caf=E9 day.<br>Thanks</p><ul><li>one</li><li>two</li></ul></body></html>',
  ]));
  assert.equal(m.text, 'Hi there,\n\nBook the flights (https://example.com/flights) for Café day.\nThanks\n\n• one\n• two');
  assert.equal(htmlToText('<div>a &amp; b &#8212; &#x2014; &unknown;</div>'), 'a & b — — &unknown;');
  // Gmail's HTML: a div per line, an empty one for a blank line.
  assert.equal(htmlToText('<div dir="ltr">Line one<div>Line two</div><div><br></div><div>After a gap</div></div>'), 'Line one\nLine two\n\nAfter a gap');
});

test('addresses: quoted names with commas, comments, groups and bare addresses', () => {
  assert.deepEqual(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com (Bob Smith), <carol@z.com>'), [
    { name: 'Doe, Jane', address: 'jane@x.com' },
    { name: 'Bob Smith', address: 'bob@y.com' },
    { address: 'carol@z.com' },
  ]);
  assert.deepEqual(parseAddressList('Team: a@x.com, b@y.com;'), [{ address: 'a@x.com' }, { address: 'b@y.com' }]);
  assert.deepEqual(parseAddressList('undisclosed-recipients:;'), []);
  assert.deepEqual(parseAddressList('"He said \\"hi\\"" <q@x.com>'), [{ name: 'He said "hi"', address: 'q@x.com' }]);
  assert.deepEqual(parseAddressList('not an address'), []);
});

test('parameters: quoted values, continuations and encoded names', () => {
  assert.deepEqual(parseParams('text/plain; charset="UTF-8"; format=flowed'), { value: 'text/plain', params: { charset: 'UTF-8', format: 'flowed' } });
  assert.deepEqual(parseParams('attachment; filename*0="very long "; filename*1="name.txt"').params, { filename: 'very long name.txt' });
  assert.deepEqual(parseParams('attachment; filename="=?UTF-8?B?w6kudHh0?="').params, { filename: 'é.txt' });
  assert.deepEqual(parseParams('multipart/mixed; boundary="a;b"').params, { boundary: 'a;b' });
});

test('machine mail is spotted: auto-replies, lists, bounces', () => {
  const auto = (extra: string[]) => parseMail(crlf(['From: someone@x.com', ...extra, '', 'x'])).automatic;
  assert.equal(auto([]), false);
  assert.equal(auto(['Auto-Submitted: auto-replied']), true);
  assert.equal(auto(['Auto-Submitted: no']), false);
  assert.equal(auto(['Precedence: bulk']), true);
  assert.equal(auto(['List-Id: <news.example.com>']), true);
  assert.equal(auto(['List-Unsubscribe: <mailto:u@x.com>']), true);
  assert.equal(auto(['X-Autoreply: yes']), true);
  assert.equal(auto(['Return-Path: <>']), true);
  assert.equal(parseMail(crlf(['From: MAILER-DAEMON@x.com', '', 'bounce'])).automatic, true);
  assert.equal(parseMail(crlf(['From: a@x.com', 'Content-Type: multipart/report; boundary=b', '', '--b--'])).automatic, true);
});

test('the receiving server checks: pass, fail or unknown, from the topmost header only', () => {
  const m = parseMail(crlf([
    'Authentication-Results: mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=owner@example.com; dmarc=pass (p=NONE) header.from=example.com',
    'Authentication-Results: forged.example; dkim=fail; spf=fail; dmarc=fail',
    'From: owner@example.com',
    '',
    'x',
  ]));
  assert.deepEqual(m.auth, { dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  assert.equal(senderVerdict(m.auth), 'pass');
  assert.equal(senderVerdict({ spf: 'softfail', dkim: 'none', dmarc: 'fail' }), 'fail');
  assert.equal(senderVerdict({ spf: 'fail' }), 'fail');
  assert.equal(senderVerdict({ spf: 'neutral', dkim: 'none' }), 'unknown');
  assert.equal(senderVerdict({ spf: 'fail', dkim: 'pass' }), 'pass');
  assert.equal(senderVerdict(undefined), 'unknown');
});

test('replies lose what they quote: Gmail, Outlook, ">" lines and phone signatures', () => {
  assert.equal(stripQuoted('Yes, use SQLite.\n\nOn Mon, Sep 28, 2026 at 9:12 AM Receptionist <\nreceptionist@example.com> wrote:\n> Byte asks: Postgres or SQLite?\n'), 'Yes, use SQLite.');
  assert.equal(stripQuoted('Go ahead\r\n\r\nFrom: Receptionist <r@x.com>\r\nSent: Monday\r\nTo: me\r\nSubject: Re: x\r\n\r\nold'), 'Go ahead');
  assert.equal(stripQuoted('Sounds good\n> quoted\n> more\nThanks\n\nSent from my iPhone'), 'Sounds good\nThanks');
  assert.equal(stripQuoted('Ship it\n-- \nMichael\nCEO'), 'Ship it');
  assert.equal(stripQuoted('Only on Tuesday or when it rains'), 'Only on Tuesday or when it rains');
  assert.equal(stripQuoted('-----Original Message-----\nold stuff'), '');
});

test('quoted-printable round trips, with long lines, "=", trailing spaces and emoji', () => {
  const text = `${'x'.repeat(200)}\nA = B and C=D   \n\tTabbed\nÉmoji 📬 and — dashes\n.leading dot\n\nend`;
  const qp = encodeQP(text);
  for (const line of qp.split('\r\n')) assert.ok(line.length <= 76, `line too long: ${line.length}`);
  assert.equal(decodeQP(Buffer.from(qp, 'latin1')).toString('utf8'), text.replace(/\n/g, '\r\n'));
});

test('composed mail parses back: encoded subject and name, threading, headers, body', () => {
  const raw = composeMail({
    from: { name: 'Réceptionniste', address: 'receptionist@example.com' },
    to: [{ name: 'Moscarelli, Michael', address: 'owner@example.com' }],
    subject: 'Re: Renew the car insurance ✅ — with a subject long enough to need more than one encoded word in it',
    text: 'Queued it.\n.And a line starting with a dot.',
    messageId: '<r1@office>',
    inReplyTo: '<abc@mail>',
    references: ['<first@mail>', '<abc@mail>'],
    date: new Date('2026-09-28T13:12:33Z'),
    headers: [['Auto-Submitted', 'auto-replied'], ['X-Agent-Office', 'receptionist']],
  });
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 998);
  assert.doesNotMatch(raw, /[^\r]\n/, 'every line ends in CRLF');
  const m = parseMail(Buffer.from(raw));
  assert.deepEqual(m.from, { name: 'Réceptionniste', address: 'receptionist@example.com' });
  assert.deepEqual(m.to, [{ name: 'Moscarelli, Michael', address: 'owner@example.com' }]);
  assert.equal(m.subject, 'Re: Renew the car insurance ✅ — with a subject long enough to need more than one encoded word in it');
  assert.equal(m.messageId, '<r1@office>');
  assert.deepEqual(m.inReplyTo, ['<abc@mail>']);
  assert.deepEqual(m.references, ['<first@mail>', '<abc@mail>']);
  assert.equal(m.text, 'Queued it.\n.And a line starting with a dot.');
  assert.equal(m.automatic, true, 'the office marks its own mail as automatic, so it never answers itself');
  assert.equal(encodeHeader('plain'), 'plain');
  for (const word of encodeHeader('é'.repeat(80)).split('\r\n ')) assert.ok(word.length <= 75);
});

test('multipart odds and ends: no closing boundary, boundary-like text inside a part', () => {
  const body = Buffer.from('--b\r\nContent-Type: text/plain\r\n\r\nfirst --b not a boundary\r\n--bx not ours\r\n--b\r\n\r\nsecond, cut off');
  const parts = splitMultipart(body, 'b').map((p) => p.toString());
  assert.deepEqual(parts, ['Content-Type: text/plain\r\n\r\nfirst --b not a boundary\r\n--bx not ours', '\r\nsecond, cut off']);
  const m = parseMail(crlf(['From: a@x.com', 'Content-Type: multipart/mixed; boundary=b', '', '--b', 'Content-Type: text/plain', '', 'hello', '--b', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename=notes.txt', '', 'attached notes']));
  assert.equal(m.text, 'hello');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.bytes.toString()]), [['notes.txt', 'attached notes']]);
});
