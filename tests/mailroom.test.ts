import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALERT_AFTER_MS, Mailroom, POLL_MS, findFloor, plainAddress, routeMail, triagePrompt, type MailFloor, type MailOffice, type MailTransport } from '../src/server/mailroom.js';
import { Inbox } from '../src/server/inbox.js';
import { Plans } from '../src/server/plans.js';
import { ImapError } from '../src/server/mail/imap.js';
import { parseMail } from '../src/server/mail/mime.js';
import { mailNeedsYou, type MailState } from '../src/shared/mail.js';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol.js';
import { rawMail } from './fake-mail-servers.mjs';

const OWNER = 'owner@example.com';
const HER = 'receptionist@example.com';
const SETTINGS = {
  address: HER,
  imap: { host: 'imap.example.com', port: 993 },
  smtp: { host: 'smtp.example.com', port: 465 },
  pass: 'app-password-1234',
  owners: `${OWNER}, spouse@example.com`,
  briefing: '08:00',
};

function worker(id: string, status: WorkerInfo['status'], extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, deskId: 'desk-1', kind: 'agent', provider: 'claude', name: id, color: '#fff', status, acked: false, createdBy: 'x', createdAt: 0, cols: 80, rows: 24, viewers: [], viewerIds: [], ...extra } as WorkerInfo;
}

function setup(t: any, opts: { present?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-mailroom-'));
  const inboxes: Inbox[] = [];
  const stations: { floor: string; deskId: string; by: string; text: string }[] = [];
  const prompts: { id: string; text: string; by?: string }[] = [];
  const resumes: { id: string; text?: string }[] = [];
  const toasts: { floor?: string; text: string; level?: string }[] = [];
  let taskN = 0;
  const floorOf = (id: string, name: string) => {
    const data = path.join(dir, id);
    mkdirSync(data);
    const inbox = new Inbox(data, { update() {}, door: () => false });
    inboxes.push(inbox);
    const tasks: QueueTask[] = [];
    const workers: WorkerInfo[] = [];
    const floor = {
      id,
      name,
      inbox,
      plans: new Plans(data),
      tasks,
      workerList: workers,
      queue: {
        add(prompt: string, by: string, title?: string) {
          tasks.push({ id: `task-${++taskN}`, title: title ?? prompt.split('\n')[0], prompt, addedBy: by, addedAt: Date.now(), status: 'queued' });
          return undefined;
        },
        state: () => ({ tasks: tasks.map((x) => ({ ...x })), maxWorkers: 3 }),
      },
      workers: {
        list: () => workers,
        get: (wid: string) => workers.find((w) => w.id === wid),
        prompt(wid: string, text: string, by?: string) {
          prompts.push({ id: wid, text, by });
          return undefined;
        },
        resume(wid: string, text?: string) {
          resumes.push({ id: wid, text });
          return undefined;
        },
        station(deskId: string, by: string, text: string) {
          stations.push({ floor: id, deskId, by, text });
          return { info: worker('rec', 'working', { deskId }), hired: true };
        },
      },
    };
    return floor;
  };
  const floors = [floorOf('home', 'Home'), floorOf('personal-portfolio', 'Personal-Portfolio')];
  let present = opts.present ?? 0;
  const office: MailOffice = {
    floors: () => floors as unknown as MailFloor[],
    toast: (floor, text, level) => toasts.push({ floor, text, level }),
    present: () => present,
    url: () => 'http://localhost:4600',
    spend: (day) => (day ? 1.5 : undefined),
  };
  const mailbox: { uid: number; raw: Buffer; seen: boolean }[] = [];
  const sent: { to: string[]; raw: string }[] = [];
  const env = {
    verify: {} as { imap?: string; smtp?: string },
    receiveError: undefined as Error | undefined,
    received: 0,
  };
  const transport: MailTransport = {
    async receive(_a, cursor, take) {
      env.received++;
      if (env.receiveError) throw env.receiveError;
      let last = cursor.lastUid ?? 0;
      for (const m of mailbox.filter((x) => x.uid > last)) {
        const seen = await take({ uid: m.uid, raw: m.raw, size: m.raw.length });
        if (seen) m.seen = true;
        last = m.uid;
      }
      return { uidValidity: 1, lastUid: last };
    },
    async send(_a, to, raw) {
      sent.push({ to, raw });
    },
    async verify() {
      return env.verify;
    },
  };
  const clock = { now: new Date(2026, 8, 28, 7, 0, 0).getTime() };
  const states: MailState[] = [];
  const room = new Mailroom(dir, office, (s) => states.push(s), transport, () => clock.now);
  t.after(() => {
    room.stop();
    inboxes.forEach((i) => i.shutdown());
    rmSync(dir, { recursive: true, force: true });
  });
  const deliver = (raw: string) => mailbox.push({ uid: mailbox.length + 1, raw: Buffer.from(raw), seen: false });
  const lastSent = () => parseMail(Buffer.from(sent.at(-1)!.raw));
  return { dir, floors, room, office, mailbox, sent, env, clock, states, stations, prompts, resumes, toasts, deliver, lastSent, setPresent: (n: number) => (present = n) };
}

async function ready(t: any, opts?: { present?: number }) {
  const s = setup(t, opts);
  const r = await s.room.save(SETTINGS, 'Ada');
  assert.equal(r.ok, true, r.error);
  // Saving starts a look at the mailbox; let it finish, so the test's own looks start fresh.
  await s.room.check();
  s.sent.length = 0;
  return s;
}

test('not set up: nothing to check, and the office is asked to set her up', async (t) => {
  const s = setup(t);
  const state = s.room.state();
  assert.equal(state.configured, false);
  assert.equal(state.status, 'off');
  assert.equal(mailNeedsYou(state), 'setup');
  assert.deepEqual(s.room.brief(), { configured: false });
  await s.room.check();
  await s.room.tick();
  assert.equal(s.env.received, 0);
  s.room.setReminders(true);
  assert.equal(mailNeedsYou(s.room.state()), undefined, 'an admin can turn the reminders off');
  s.room.setReminders(false);
  assert.equal(mailNeedsYou(s.room.state()), 'setup');
});

test('settings are checked, and a blank password keeps the saved one only for the same mailbox', async (t) => {
  const s = setup(t);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ ...SETTINGS, address: 'nope' }, /Type her email address/],
    [{ ...SETTINGS, pass: '' }, /app password/],
    [{ ...SETTINGS, owners: '' }, /Who can email her/],
    [{ ...SETTINGS, owners: 'owner@example.com, not-an-address' }, /isn't an email address/],
    [{ ...SETTINGS, owners: 'Receptionist+x@example.com' }, /writing to herself/],
    [{ ...SETTINGS, briefing: '8am' }, /like 08:00/],
    [{ ...SETTINGS, floor: 'nowhere' }, /Choose one of the floors/],
    [{ ...SETTINGS, imap: { host: 'bad host!', port: 993 } }, /incoming \(IMAP\) server's name/],
    [{ ...SETTINGS, smtp: { host: 'smtp.example.com', port: 70000 } }, /outgoing \(SMTP\) port/],
  ];
  for (const [input, message] of bad) assert.match(String(s.room.validate(input)), message, JSON.stringify(input));
  const a = s.room.validate(SETTINGS);
  assert.equal(typeof a, 'object');
  if (typeof a === 'string') return;
  assert.deepEqual([a.name, a.user, a.smtp.security, a.onlyOwners, a.autoTriage, a.awayAlerts, a.owners], ['Receptionist', HER, 'tls', true, true, true, [OWNER, 'spouse@example.com']]);
  assert.equal((s.room.validate({ ...SETTINGS, smtp: { host: 'smtp.example.com', port: 587 } }) as { smtp: { security: string } }).smtp.security, 'starttls');
  assert.equal((await s.room.save(SETTINGS, 'Ada')).ok, true);
  assert.equal((s.room.validate({ ...SETTINGS, pass: '' }) as { pass: string }).pass, SETTINGS.pass);
  assert.match(String(s.room.validate({ ...SETTINGS, pass: '', imap: { host: 'evil.example.net', port: 993 } })), /app password/, 'a new server has to be given the password again');
});

test('saving: her mailbox must let her in, sending may fail with a warning, and the first save sends the how-to', async (t) => {
  const s = setup(t);
  s.env.verify = { imap: 'The mailbox refused the sign-in' };
  const refused = await s.room.save(SETTINGS, 'Ada');
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /didn't let her in: The mailbox refused the sign-in/);
  assert.equal(s.room.state().configured, false);
  s.env.verify = { smtp: 'The mail server refused the sign-in' };
  const warned = await s.room.save(SETTINGS, 'Ada');
  assert.equal(warned.ok, true);
  assert.match(warned.warning!, /can't write back yet/);
  assert.equal(s.sent.length, 0, 'no welcome when sending is broken');
  s.room.remove();
  s.env.verify = {};
  const ok = await s.room.save(SETTINGS, 'Ada');
  assert.equal(ok.ok, true);
  assert.equal(ok.warning, undefined);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0].to, [OWNER]);
  const welcome = s.lastSent();
  assert.equal(welcome.subject, '💁‍♀️ Your Receptionist is set up');
  assert.match(welcome.text, /Email me at receptionist@example\.com/);
  assert.match(welcome.text, /“todo:” goes straight onto To Do Next/);
  assert.match(welcome.text, /\[personal-portfolio\] at the start of the subject, or email receptionist\+personal-portfolio@example\.com/);
  assert.match(welcome.text, /Every morning at 08:00/);
  assert.equal(welcome.headers.get('auto-submitted')?.[0], 'auto-replied');
  // The password stays on disk, never in what the browser sees.
  const state = JSON.stringify(s.room.state());
  const view = s.room.view()!;
  assert.ok(!state.includes(SETTINGS.pass) && !JSON.stringify(view).includes(SETTINGS.pass));
  assert.equal(view.passSet, true);
  assert.equal(view.by, 'Ada');
  assert.ok(readFileSync(path.join(s.dir, 'mail.json'), 'utf8').includes(SETTINGS.pass));
  assert.deepEqual(s.room.brief(), { configured: true, address: HER });
  assert.equal(mailNeedsYou(s.room.state()), undefined);
});

test('mail from an allowed sender lands in the tray, attachments beside it, and wakes the Receptionist', async (t) => {
  const s = await ready(t);
  const boundary = 'b1';
  s.deliver([
    'From: Michael <Owner+phone@Example.com>',
    `To: ${HER}`,
    'Subject: Renew the car insurance',
    'Message-ID: <m1@example.com>',
    'Authentication-Results: mx.example.com; dkim=pass; spf=pass; dmarc=pass',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'Before the 15th. The policy is attached.',
    `--${boundary}`,
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="policy.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF policy').toString('base64'),
    `--${boundary}`,
    'Content-Type: image/png',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('tiny signature logo').toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n'));
  await s.room.check();
  const home = s.floors[0];
  await home.inbox.scan();
  const items = home.inbox.list();
  assert.deepEqual(items.map((i) => i.name.replace(/^\d{8}-\d{6}-/, '')).sort(), ['policy.pdf', 'renew-the-car-insurance.md']);
  const note = items.find((i) => i.kind === 'note')!;
  assert.equal(note.title, 'Renew the car insurance');
  assert.equal(note.from, 'Michael <Owner+phone@Example.com> · email');
  const read = await home.inbox.read(note.name);
  assert.match(read.body!, /^📧 Email to receptionist@example\.com, .+\. ✅ From an allowed sender/);
  assert.match(read.body!, /Before the 15th\. The policy is attached\./);
  assert.match(read.body!, /📎 Attachments, saved in the tray:\n- policy\.pdf/);
  assert.equal(s.mailbox[0].seen, true);
  assert.equal(s.stations.length, 1);
  assert.deepEqual([s.stations[0].floor, s.stations[0].deskId, s.stations[0].by], ['home', 'station-inbox', 'Email']);
  assert.match(s.stations[0].text, new RegExp(`- ${note.name}: “Renew the car insurance” from Michael`));
  assert.match(s.stations[0].text, /office-queue add --mail <name>/);
  assert.match(s.stations[0].text, /office-mail reply <name>/);
  assert.deepEqual(s.room.origin('home', note.name), { from: 'owner+phone@example.com', name: 'Michael', subject: 'Renew the car insurance', trusted: true });
  assert.equal(s.room.state().received, 1);
  assert.ok(s.toasts.some((x) => x.floor === 'home' && /Michael emailed the Receptionist: “Renew the car insurance”/.test(x.text)));
});

test('strangers, machines, forgeries and her own mail are kept away from the agents', async (t) => {
  const s = await ready(t);
  s.deliver(rawMail({ from: 'stranger@spam.example', subject: 'You won!' }));
  s.deliver(rawMail({ from: OWNER, subject: 'Out of office', headers: ['Auto-Submitted: auto-replied'] }));
  s.deliver(rawMail({ from: HER, subject: 'Myself' }));
  s.deliver(rawMail({ from: OWNER, subject: 'Delete everything', headers: ['Authentication-Results: mx.example.com; spf=fail; dkim=none; dmarc=fail'] }));
  await s.room.check();
  await s.floors[0].inbox.scan();
  assert.deepEqual(s.mailbox.map((m) => m.seen), [false, true, true, true], "a stranger's mail is left unread for a person");
  const items = s.floors[0].inbox.list();
  assert.deepEqual(items.map((i) => i.title), ['Delete everything'], 'only the forgery lands, marked, and nothing is woken for it');
  assert.match((await s.floors[0].inbox.read(items[0].name)).body!, /could not verify that/);
  assert.equal(s.stations.length, 0);
  assert.equal(s.room.origin('home', items[0].name)?.trusted, false);
  assert.match(String(await s.room.reply('home', items[0].name, 'Done!')), /isn't from an allowed sender/);
  assert.equal(s.room.state().ignored, 3);
  // With "only allowed senders" off, a stranger's mail comes in, marked, and still wakes nobody.
  await s.room.save({ ...SETTINGS, onlyOwners: false }, 'Ada');
  s.deliver(rawMail({ from: 'neighbour@example.net', subject: 'Your dog is in my garden' }));
  await s.room.check();
  await s.floors[0].inbox.scan();
  const neighbour = s.floors[0].inbox.list().find((i) => i.title === 'Your dog is in my garden')!;
  assert.match((await s.floors[0].inbox.read(neighbour.name)).body!, /Not from an allowed sender/);
  assert.equal(s.stations.length, 0);
});

test('mail finds its floor: a plus tag, a [tag] in the subject, or the default', () => {
  const floors = [{ id: 'home', name: 'Home' }, { id: 'personal-portfolio', name: 'Personal-Portfolio' }, { id: 'mft-trading-dashboard', name: 'MFT-Trading-Dashboard' }];
  const mail = (subject: string, to = HER, deliveredTo: string[] = []) => ({ subject, to: [{ address: to }], cc: [], deliveredTo });
  assert.deepEqual(routeMail(HER, mail('Hello', 'receptionist+Personal-Portfolio@example.com'), floors, 'home'), { floor: floors[1], title: 'Hello', shortcut: undefined });
  assert.deepEqual(routeMail(HER, mail('Hello', HER, ['receptionist+mft@example.com']), floors, 'home'), { floor: floors[2], title: 'Hello', shortcut: undefined });
  assert.deepEqual(routeMail(HER, mail('[portfolio] Fix the chart'), floors, 'home'), { floor: floors[1], title: 'Fix the chart', shortcut: undefined });
  assert.deepEqual(routeMail(HER, mail('todo: [home] Call the plumber'), floors, 'personal-portfolio'), { floor: floors[0], title: 'Call the plumber', shortcut: 'todo' });
  assert.deepEqual(routeMail(HER, mail('[home] queue: Update the budget sheet'), floors, 'personal-portfolio'), { floor: floors[0], title: 'Update the budget sheet', shortcut: 'queue' });
  assert.deepEqual(routeMail(HER, mail('Task: tidy up'), floors, 'home'), { floor: floors[0], title: 'tidy up', shortcut: 'queue' });
  assert.deepEqual(routeMail(HER, mail('[unknown] Hi'), floors, 'personal-portfolio'), { floor: floors[1], title: '[unknown] Hi', shortcut: undefined });
  assert.deepEqual(routeMail(HER, mail('Hi'), floors, ''), { floor: floors[0], title: 'Hi', shortcut: undefined });
  assert.equal(findFloor(floors, 'a'), undefined, 'two floors match "a": neither is guessed');
  assert.equal(plainAddress('A+tag@X.com'), 'a@x.com');
  assert.match(triagePrompt([{ item: 'a.md', title: 'A', from: 'M' }, { item: 'b.md', title: 'B', from: 'M' }]), /^📧 2 emails just came into the in-tray/);
});

test('"todo:" and "queue:" subjects are filed straight away, with a receipt in the thread', async (t) => {
  const s = await ready(t);
  s.deliver(rawMail({ from: OWNER, subject: 'todo: [portfolio] Rebalance the 401k', body: 'Target 70/30.', messageId: '<todo1@example.com>' }));
  s.deliver(rawMail({ from: OWNER, subject: 'queue: Update the budget sheet', body: 'Add September.', messageId: '<q1@example.com>' }));
  await s.room.check();
  assert.equal(s.stations.length, 0, 'no agent needed');
  const portfolio = s.floors[1];
  const plan = portfolio.plans.state().items[0];
  assert.equal(plan.text, 'Rebalance the 401k\n\nTarget 70/30.');
  const task = s.floors[0].tasks[0];
  assert.equal(task.title, 'Update the budget sheet');
  assert.match(task.prompt, /^From an email by owner@example\.com \(subject: queue: Update the budget sheet\):\n\nUpdate the budget sheet\n\nAdd September\./);
  assert.match(task.prompt, /a request from the people here/);
  assert.equal(task.addedBy, 'owner@example.com by email');
  for (const f of s.floors) {
    await f.inbox.scan();
    assert.equal(f.inbox.list().length, 0, 'filed notes go to the archive');
  }
  assert.equal(s.sent.length, 2);
  const [todoReceipt, queueReceipt] = s.sent.map((x) => parseMail(Buffer.from(x.raw)));
  assert.equal(todoReceipt.subject, 'Re: todo: [portfolio] Rebalance the 401k');
  assert.deepEqual(todoReceipt.inReplyTo, ['<todo1@example.com>']);
  assert.match(todoReceipt.text, /📒 Added to To Do Next on the Personal-Portfolio floor/);
  assert.match(queueReceipt.text, /📋 Queued on the Home floor:\n\nUpdate the budget sheet/);
  assert.deepEqual(queueReceipt.references, ['<q1@example.com>']);
  // The task finishes: the sender hears, in the same thread, with the pull request.
  s.floors[0].workerList.push(worker('byte', 'done', { name: 'Byte', task: { name: 'Budget', summary: 'Added the September rows and totals' } }));
  Object.assign(task, { status: 'done', outcome: 'done', finishedAt: s.clock.now, workerId: 'byte', workerName: 'Byte', pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', title: 'x' } });
  s.room.onQueue('home', s.floors[0].queue.state());
  await new Promise((r) => setImmediate(r));
  const done = s.lastSent();
  assert.equal(s.sent.length, 3);
  assert.equal(done.subject, 'Re: queue: Update the budget sheet');
  assert.deepEqual(done.inReplyTo, ['<q1@example.com>']);
  assert.match(done.text, /^✅ Done: Update the budget sheet\n\nByte finished it on the Home floor\.\n\nWhat it did: Added the September rows and totals\n\nPull request #12 \(open\): https:\/\/github\.com\/o\/r\/pull\/12/);
  s.room.onQueue('home', s.floors[0].queue.state());
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 3, 'told once');
});

test('the Receptionist writes back in the thread, only to the people allowed to email her', async (t) => {
  const s = await ready(t);
  s.deliver(rawMail({ from: 'Spouse <spouse@example.com>', subject: 'Book the dentist', messageId: '<d1@example.com>' }));
  await s.room.check();
  await s.floors[0].inbox.scan();
  const item = s.floors[0].inbox.list()[0].name;
  assert.equal(await s.room.reply('home', item, 'Put it on To Do Next for you.'), undefined);
  const r = s.lastSent();
  assert.deepEqual(s.sent.at(-1)!.to, ['spouse@example.com']);
  assert.equal(r.subject, 'Re: Book the dentist');
  assert.deepEqual(r.inReplyTo, ['<d1@example.com>']);
  assert.match(r.text, /^Put it on To Do Next for you\.\n\n—\n💁‍♀️ Receptionist, Agent Office/);
  assert.match(String(await s.room.reply('home', 'nope.md', 'x')), /didn't come by email/);
  assert.match(String(await s.room.reply('home', item, '  ')), /Write something/);
  assert.equal(await s.room.toOwner('Heads up', 'The tray is getting full', 'home'), undefined);
  assert.deepEqual(s.sent.at(-1)!.to, [OWNER]);
});

test('To Do Next items from email: a worker finishing one tells the sender; a person finishing it does not', async (t) => {
  const s = await ready(t);
  s.deliver(rawMail({ from: OWNER, subject: 'Fix the gate', messageId: '<g1@example.com>' }));
  s.deliver(rawMail({ from: OWNER, subject: 'Call mum', messageId: '<c1@example.com>' }));
  await s.room.check();
  const home = s.floors[0];
  await home.inbox.scan();
  const [gate, mum] = ['Fix the gate', 'Call mum'].map((title) => home.inbox.list().find((i) => i.title === title)!.name);
  const a = home.plans.apply({ action: 'add', text: 'Fix the gate' }).items.at(-1)!;
  const b = home.plans.apply({ action: 'add', text: 'Call mum' }).items.at(-1)!;
  assert.equal(s.room.link('home', 'plan', a.id, gate), undefined);
  assert.equal(s.room.link('home', 'plan', b.id, mum), undefined);
  assert.match(String(s.room.link('home', 'plan', b.id, 'handmade.md')), /didn't come by email/);
  home.workerList.push(worker('pixel', 'done', { name: 'Pixel' }));
  home.plans.start(a.id, { id: 'pixel', name: 'Pixel' });
  home.plans.onWorker(worker('pixel', 'done'));
  home.plans.apply({ action: 'edit', id: b.id, status: 'finished' });
  s.sent.length = 0;
  s.room.onPlans('home', home.plans.state());
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1);
  const done = s.lastSent();
  assert.deepEqual(done.inReplyTo, ['<g1@example.com>']);
  assert.match(done.text, /^✅ Done: Fix the gate\n\nPixel finished it on the Home floor\./);
});

test('replying to a "done" email goes straight to the worker when it can take it; otherwise to the tray', async (t) => {
  const s = await ready(t);
  s.deliver(rawMail({ from: OWNER, subject: 'queue: Draft the newsletter', messageId: '<n1@example.com>' }));
  await s.room.check();
  const home = s.floors[0];
  const task = home.tasks[0];
  home.workerList.push(worker('byte', 'done', { name: 'Byte' }));
  Object.assign(task, { status: 'done', outcome: 'done', finishedAt: s.clock.now, workerId: 'byte', workerName: 'Byte' });
  s.room.onQueue('home', home.queue.state());
  await new Promise((r) => setImmediate(r));
  const doneId = s.lastSent().messageId!;
  s.deliver(rawMail({ from: OWNER, subject: 'Re: Draft the newsletter', body: 'Make it shorter, please.\n\nOn Mon, Sep 28, 2026 at 9:12 AM Receptionist <receptionist@example.com> wrote:\n> ✅ Done', headers: [`In-Reply-To: ${doneId}`, `References: <n1@example.com> ${doneId}`] }));
  await s.room.check();
  assert.deepEqual(s.prompts, [{ id: 'byte', text: 'Make it shorter, please.', by: 'owner@example.com by email' }]);
  await home.inbox.scan();
  assert.equal(home.inbox.list().length, 0, 'answered, not filed');
  // Busy now: the next reply lands in the tray (marked as a reply) and goes to the Receptionist.
  home.workerList[0].status = 'working';
  s.deliver(rawMail({ from: OWNER, subject: 'Re: Draft the newsletter', body: 'And add a photo', headers: [`In-Reply-To: ${doneId}`] }));
  await s.room.check();
  await home.inbox.scan();
  const note = home.inbox.list()[0];
  assert.match((await home.inbox.read(note.name)).body!, /↩️ A reply to the Receptionist's email about work that finished/);
  assert.equal(s.stations.length, 1);
  // Its turn paused or was interrupted: it takes the reply as its next prompt.
  home.workerList[0].status = 'interrupted';
  s.deliver(rawMail({ from: OWNER, subject: 'Re: Draft the newsletter', body: 'Pick it up again', headers: [`In-Reply-To: ${doneId}`] }));
  await s.room.check();
  assert.deepEqual(s.prompts.at(-1), { id: 'byte', text: 'Pick it up again', by: 'owner@example.com by email' });
  // Asleep: woken with the reply.
  home.workerList[0].status = 'offline';
  s.deliver(rawMail({ from: OWNER, subject: 'Re: x', body: 'Carry on', headers: [`In-Reply-To: ${doneId}`] }));
  await s.room.check();
  assert.deepEqual(s.resumes, [{ id: 'byte', text: 'Carry on' }]);
});

test('away alerts: a worker left waiting while nobody is in the office gets its owner an email, once', async (t) => {
  const s = await ready(t, { present: 0 });
  const home = s.floors[0];
  const w = worker('dot', 'needs_input', { name: 'Dot', activity: 'Allow npm install?', task: { name: 'Set up the site', summary: 'Installing packages' } });
  home.workerList.push(w);
  s.room.onWorker('home', w);
  await s.room.tick();
  assert.equal(s.sent.length, 0, 'not straight away');
  s.clock.now += ALERT_AFTER_MS + 1;
  s.setPresent(1);
  await s.room.tick();
  assert.equal(s.sent.length, 0, 'not while someone is in the office');
  s.setPresent(0);
  await s.room.tick();
  assert.equal(s.sent.length, 1);
  const alert = s.lastSent();
  assert.equal(alert.subject, '🙋 Dot needs you · Home');
  assert.match(alert.text, /Dot is waiting on you on the Home floor\.\n\nWorking on: Set up the site — Installing packages\n\nIt asks: Allow npm install\?/);
  assert.match(alert.text, /needs you at the office: http:\/\/localhost:4600/);
  await s.room.tick();
  assert.equal(s.sent.length, 1, 'once per wait');
  // A board agent never alerts; neither does a worker someone is looking at.
  const kiosk = worker('rec', 'needs_input', { deskId: 'station-inbox' });
  const watched = worker('pip', 'done', { viewers: ['someone'] });
  home.workerList.push(kiosk, watched);
  s.room.onWorker('home', kiosk);
  s.room.onWorker('home', watched);
  s.clock.now += ALERT_AFTER_MS + 1;
  await s.room.tick();
  assert.equal(s.sent.length, 1);
  // A done worker's alert takes replies.
  const finished = worker('max', 'done', { name: 'Max', task: { name: 'Taxes', summary: 'Filled in the 1099 figures' } });
  home.workerList.push(finished);
  s.room.onWorker('home', finished);
  s.clock.now += ALERT_AFTER_MS + 1;
  await s.room.tick();
  const doneAlert = s.lastSent();
  assert.equal(doneAlert.subject, '✅ Max is done · Home');
  assert.match(doneAlert.text, /Reply to this email and I'll pass your answer to Max/);
  s.deliver(rawMail({ from: OWNER, subject: 'Re: ✅ Max is done', body: 'Also do the state return', headers: [`In-Reply-To: ${doneAlert.messageId}`] }));
  await s.room.check();
  assert.deepEqual(s.prompts.at(-1), { id: 'max', text: 'Also do the state return', by: 'owner@example.com by email' });
});

test('the morning briefing goes once a day, at its time, with each busy floor', async (t) => {
  const s = await ready(t);
  const home = s.floors[0];
  home.plans.apply({ action: 'add', text: 'Call the plumber' });
  home.plans.apply({ action: 'add', text: 'Renew passport' });
  home.inbox.note('Parking ticket', 'pay it');
  await home.inbox.scan();
  home.workerList.push(worker('dot', 'needs_input', { name: 'Dot' }));
  home.tasks.push({ id: 'x', title: 'Budget', prompt: 'p', addedBy: 'a', addedAt: 0, status: 'done', outcome: 'done', finishedAt: s.clock.now - 3_600_000, pr: { number: 3, url: 'u', state: 'MERGED', title: 't' } });
  await s.room.tick();
  assert.equal(s.sent.length, 0, 'it is 7am; the briefing is at 8');
  s.clock.now += 60 * 60_000 + 1000;
  await s.room.tick();
  assert.equal(s.sent.length, 1);
  const b = s.lastSent();
  assert.match(b.subject, /^☀️ Your office this morning · Monday, September 28$/);
  assert.match(b.text, /🏢 Home\n  📥 In the tray: 1 — “Parking ticket”\n  📒 To do: 2 — Call the plumber · Renew passport\n  🙋 Waiting on you: Dot\n  ✅ Finished since yesterday: Budget \(PR #3\)/);
  assert.doesNotMatch(b.text, /Personal-Portfolio/, 'a quiet floor is left out');
  assert.match(b.text, /💸 Tracked Claude spend yesterday: \$1\.50 \(an estimate/);
  await s.room.tick();
  assert.equal(s.sent.length, 1, 'once a day');
  // An office that starts long after the time skips that day's briefing.
  s.clock.now += 24 * 60 * 60_000 + 5 * 60 * 60_000;
  await s.room.tick();
  assert.equal(s.sent.length, 1);
});

test('a refused sign-in waits ten minutes before trying again, and is shown without the password', async (t) => {
  const s = await ready(t);
  await s.room.check();
  s.env.receiveError = new ImapError(`The mailbox refused the sign-in (${SETTINGS.pass} rejected)`, true);
  s.clock.now += POLL_MS;
  const before = s.env.received;
  await s.room.tick();
  assert.equal(s.env.received, before + 1);
  const state = s.room.state();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'The mailbox refused the sign-in (••• rejected)');
  assert.equal(mailNeedsYou(state), 'broken');
  assert.match(s.room.brief().problem!, /refused the sign-in/);
  s.clock.now += 5 * 60_000;
  await s.room.tick();
  assert.equal(s.env.received, before + 1, 'not yet');
  s.clock.now += 6 * 60_000;
  s.env.receiveError = undefined;
  await s.room.tick();
  assert.equal(s.env.received, before + 2);
  assert.equal(s.room.state().status, 'ok');
});

test('she never sends more than 40 emails an hour, and her memory survives a restart', async (t) => {
  const s = await ready(t);
  // The welcome email was the first of the hour's 40.
  for (let i = 0; i < 39; i++) assert.equal(await s.room.toOwner(`n${i}`, 'x'), undefined);
  assert.match(String(await s.room.toOwner('one too many', 'x')), /sent a lot of email lately/);
  s.clock.now += 61 * 60_000;
  assert.equal(await s.room.toOwner('later', 'x'), undefined);
  s.deliver(rawMail({ from: OWNER, subject: 'Remember me' }));
  await s.room.check();
  s.room.stop();
  const again = new Mailroom(s.dir, s.office, () => {}, { receive: async (_a, cursor) => ({ uidValidity: 1, lastUid: cursor.lastUid }), send: async () => {}, verify: async () => ({}) }, () => s.clock.now);
  assert.equal(again.state().configured, true);
  assert.equal(again.state().received, 1);
  assert.equal(again.state().sent, 41);
  await s.floors[0].inbox.scan();
  assert.equal(again.origin('home', s.floors[0].inbox.list()[0].name)?.subject, 'Remember me');
  again.remove();
  assert.equal(again.state().configured, false);
  assert.ok(!readFileSync(path.join(s.dir, 'mail.json'), 'utf8').includes(SETTINGS.pass), 'removing her mailbox forgets the password');
  assert.ok(existsSync(path.join(s.dir, 'mail-state.json')));
});
