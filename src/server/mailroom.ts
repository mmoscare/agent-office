// The Receptionist's mailbox. An admin gives her one (any IMAP/SMTP mailbox with an app password,
// see ui/mail.ts); from then on the office looks at its inbox every minute. Mail from the people
// allowed to email her lands in the right floor's 📥 in-tray, attachments and all, and she's woken to
// deal with it: work for the agents goes on the task queue, things for a person on To Do Next, and
// she writes back saying what she did. When a task that came by email finishes, the sender hears
// about it in the same thread; replying to that (or to a "needs you" email) goes straight to the
// worker. There's a morning briefing too. Everything she sends goes to the people who may email her,
// so nothing can use her to write to anyone else.
//
// The settings, password included, live in <dataDir>/mail.json (mode 0600) and never reach the
// browser; what she remembers (where she got to in the inbox, threads, who asked for what) lives in
// <dataDir>/mail-state.json.

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ImapClient, ImapError, imapDate } from './mail/imap.js';
import { SmtpError, sendMail, verifySmtp } from './mail/smtp.js';
import { composeMail, parseMail, senderVerdict, stripQuoted, type ParsedMail } from './mail/mime.js';
import type { Inbox } from './inbox.js';
import type { Plans } from './plans.js';
import type { TaskQueue } from './queue.js';
import type { WorkerManager } from './workers.js';
import { MAIL_OFF, isEmailAddress, type MailBrief, type MailSecurity, type MailSettingsView, type MailState } from '../shared/mail.js';
import { DESK_BY_ID, STATIONS } from '../shared/layout.js';
import { planTitle, type PlansState } from '../shared/plans.js';
import { INBOX_FILE_MAX, INBOX_NOTE_MAX } from '../shared/inbox.js';
import { alertDetail } from '../shared/status.js';
import type { QueueState, QueueTask, WorkerInfo, WorkerStatus } from '../shared/protocol.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How often the mailroom looks around: new mail is fetched every POLL_MS, alerts and the briefing checked each tick. */
export const TICK_MS = 15_000;
export const POLL_MS = MINUTE;
const MAX_BACKOFF_MS = 15 * MINUTE;
/** A refused sign-in isn't retried for a while: servers lock out mailboxes that keep trying. */
const AUTH_BACKOFF_MS = 10 * MINUTE;
/** Messages taken per look; the rest wait for the next one. */
export const MAX_PER_CHECK = 25;
/** Bigger messages are left in the mailbox, with just their headers in the tray. */
const MAX_FETCH = 25 * 1024 * 1024;
/** On her first look at a mailbox, unread mail this recent is taken; anything older is left alone. */
const FIRST_LOOK_MS = DAY;
const MAX_ATTACHMENTS = 10;
/** Inline pictures smaller than this are logos in signatures, not something to keep. */
const SIGNATURE_IMAGE = 20 * 1024;
/** A worker has waited on someone this long, with nobody around, before its owner is emailed. */
export const ALERT_AFTER_MS = 3 * MINUTE;
const SEND_PER_HOUR = 40;
const SEND_PER_DAY = 200;
const ALERTS_PER_HOUR = 10;
/** New mail she couldn't be woken for is tried again for this long. */
const TRIAGE_RETRY_MS = 30 * MINUTE;
/** A morning briefing is only sent this long after its time: an office started at 3pm skips that day's. */
const BRIEFING_WINDOW_MS = 3 * HOUR;
const KEEP_THREADS_MS = 45 * DAY;
const KEEP_ORIGINS_MS = 90 * DAY;
const INBOX_DESK = STATIONS.find((s) => s.station === 'inbox')!.id;
const SHORTCUT = /^(to-?do|queue|task)\s*:\s*/i;

/** Her mailbox's settings, password and all: only ever on the office's machine. */
export interface MailAccount {
  address: string;
  name: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number; security: MailSecurity };
  user: string;
  pass: string;
  owners: string[];
  onlyOwners: boolean;
  floor: string;
  autoTriage: boolean;
  briefing: string;
  awayAlerts: boolean;
  by: string;
  at: number;
}

/** What the mailroom needs from a floor. Narrow on purpose, so a test can fake it. */
export interface MailFloor {
  id: string;
  name: string;
  inbox: Pick<Inbox, 'note' | 'file' | 'archive' | 'read' | 'find' | 'list'>;
  plans: Pick<Plans, 'apply' | 'state'>;
  queue: Pick<TaskQueue, 'add' | 'state'>;
  workers: Pick<WorkerManager, 'list' | 'get' | 'prompt' | 'resume' | 'station'>;
}

export interface MailOffice {
  floors(): MailFloor[];
  /** A note on one floor's screens, or every floor's. */
  toast(floor: string | undefined, text: string, level?: 'info' | 'warn' | 'error'): void;
  /** People in the office who are really there: a tab open and looked at lately. */
  present(): number;
  /** The office's own address, for links in her emails. */
  url(): string;
  /** Tracked Claude spend on a local day (YYYY-MM-DD), for the briefing. */
  spend?(day: string): number | undefined;
}

export interface Inbound {
  uid: number;
  raw?: Buffer;
  size: number;
  /** Too big to fetch: just its headers. */
  headersOnly?: boolean;
}

export interface Cursor {
  uidValidity?: number;
  lastUid?: number;
}

/** How mail comes and goes: the real mailbox, or a fake one in tests. */
export interface MailTransport {
  /** Signs in, hands each new message to `take` (oldest first) and marks it read when `take` says so. Returns where it got to. */
  receive(a: MailAccount, cursor: Cursor, take: (m: Inbound) => Promise<boolean>): Promise<Cursor & { error?: Error }>;
  send(a: MailAccount, to: string[], raw: string): Promise<void>;
  /** Whether reading and sending would work: what's wrong with each, if anything. */
  verify(a: MailAccount): Promise<{ imap?: string; smtp?: string }>;
}

const imapOptions = (a: MailAccount) => ({ host: a.imap.host, port: a.imap.port, user: a.user, pass: a.pass });
const smtpOptions = (a: MailAccount) => ({ host: a.smtp.host, port: a.smtp.port, security: a.smtp.security, user: a.user, pass: a.pass });

export const netTransport: MailTransport = {
  async receive(a, cursor, take) {
    const c = await ImapClient.open(imapOptions(a));
    try {
      const box = await c.select('INBOX');
      const fresh = cursor.uidValidity !== box.uidValidity || cursor.lastUid === undefined;
      let last: number;
      let uids: number[];
      if (fresh) {
        // A new mailbox (or one renumbered): start at the newest message, taking only recent unread mail.
        last = box.uidNext ? box.uidNext - 1 : Math.max(0, ...(await c.search('UID *')));
        uids = await c.search(`UNSEEN SINCE ${imapDate(Date.now() - FIRST_LOOK_MS)}`);
      } else {
        last = cursor.lastUid!;
        uids = (await c.search(`UID ${last + 1}:*`)).filter((u) => u > last);
      }
      uids = uids.slice(0, MAX_PER_CHECK);
      const sizes = await c.sizes(uids);
      let error: Error | undefined;
      for (const uid of uids) {
        const size = sizes.get(uid) ?? 0;
        const big = size > MAX_FETCH;
        const raw = await c.fetch(uid, big);
        let seen: boolean;
        try {
          seen = await take({ uid, raw, size, headersOnly: big });
        } catch (err) {
          // Stop here: this one is tried again next time.
          error = err as Error;
          break;
        }
        if (seen) await c.markSeen([uid]);
        if (uid > last) last = uid;
      }
      return { uidValidity: box.uidValidity, lastUid: last, error };
    } finally {
      await c.logout();
    }
  },
  send: (a, to, raw) => sendMail(smtpOptions(a), a.address, to, raw),
  async verify(a) {
    const out: { imap?: string; smtp?: string } = {};
    try {
      const c = await ImapClient.open(imapOptions(a));
      await c.select('INBOX');
      await c.logout();
    } catch (err) {
      out.imap = (err as Error).message;
    }
    try {
      await verifySmtp(smtpOptions(a));
    } catch (err) {
      out.smtp = (err as Error).message;
    }
    return out;
  },
};

interface Origin {
  floor: string;
  item: string;
  /** Who sent it (lowercased), and their name. */
  from: string;
  name?: string;
  subject: string;
  messageId?: string;
  references: string[];
  trusted: boolean;
  at: number;
}

interface Link {
  origin: string;
  /** The finish already emailed about (a task's finishedAt), so each is told once. */
  notified?: number;
}

type ThreadKind = 'receipt' | 'reply' | 'done' | 'alert' | 'briefing' | 'welcome' | 'note';

interface Thread {
  kind: ThreadKind;
  floor?: string;
  worker?: string;
  task?: string;
  origin?: string;
  at: number;
}

interface Memory {
  cursor: Cursor & { account?: string };
  origins: Record<string, Origin>;
  links: Record<string, Link>;
  threads: Record<string, Thread>;
  sent: number[];
  alerts: number[];
  briefedOn?: string;
  stats: { received: number; ignored: number; sent: number; lastMailAt?: number };
}

interface Saved {
  account?: MailAccount;
  remindersOff?: boolean;
}

interface Watch {
  floor: string;
  status: WorkerStatus;
  since: number;
  sent?: boolean;
}

interface Triage {
  items: { item: string; title: string; from: string }[];
  since: number;
  warned?: boolean;
}

const emptyMemory = (): Memory => ({ cursor: {}, origins: {}, links: {}, threads: {}, sent: [], alerts: [], stats: { received: 0, ignored: 0, sent: 0 } });

/** An address to compare by: lowercased, without a +tag. */
export function plainAddress(address: string): string {
  const [local, domain] = address.trim().toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain ?? ''}`;
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const originKey = (floor: string, item: string) => `${floor}/${item}`;
const linkKey = (floor: string, what: 'task' | 'plan', id: string) => `${floor}/${what}/${id}`;
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const re = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim() || 'your email'}`);
const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The floor a tag names: its id, its name, or the one floor whose id contains it. */
export function findFloor<F extends { id: string; name: string }>(floors: F[], tag: string): F | undefined {
  const t = slug(tag);
  if (!t) return undefined;
  const exact = floors.find((f) => f.id === t || slug(f.name) === t);
  if (exact) return exact;
  const partial = floors.filter((f) => f.id.includes(t) || slug(f.name).includes(t));
  return partial.length === 1 ? partial[0] : undefined;
}

/**
 * Which floor an email is for, its title, and a shortcut if it asked for one: "you+household@…",
 * "[household]" at the start of the subject, "todo:" or "queue:" before or after that.
 */
export function routeMail<F extends { id: string; name: string }>(address: string, mail: Pick<ParsedMail, 'subject' | 'deliveredTo' | 'to' | 'cc'>, floors: F[], fallback: string): { floor: F; title: string; shortcut?: 'todo' | 'queue' } {
  const [local, domain] = address.toLowerCase().split('@');
  let floor: F | undefined;
  for (const addr of [...mail.deliveredTo, ...mail.to.map((x) => x.address), ...mail.cc.map((x) => x.address)]) {
    const [l, d] = addr.toLowerCase().split('@');
    if (d !== domain || !l.startsWith(`${local}+`)) continue;
    floor = findFloor(floors, l.slice(local.length + 1));
    if (floor) break;
  }
  let s = mail.subject.trim();
  let cut = SHORTCUT.exec(s);
  if (cut) s = s.slice(cut[0].length);
  const tag = /^\[([^\]]{1,60})\]\s*/.exec(s);
  const tagged = tag ? findFloor(floors, tag[1]) : undefined;
  if (tagged) {
    s = s.slice(tag![0].length);
    floor ??= tagged;
  }
  if (!cut) {
    cut = SHORTCUT.exec(s);
    if (cut) s = s.slice(cut[0].length);
  }
  const kind = cut ? (/^q|^t(?!o)/i.test(cut[1]) ? 'queue' : 'todo') : undefined;
  return { floor: floor ?? floors.find((f) => f.id === fallback) ?? floors[0], title: s.trim(), shortcut: kind };
}

/** What the Receptionist is asked when new mail comes in. */
export function triagePrompt(items: Triage['items']): string {
  const one = items.length === 1;
  const list = items.map((i) => `- ${i.item}: “${i.title}” from ${i.from}`).join('\n');
  return [
    `📧 ${one ? 'An email just came' : `${items.length} emails just came`} into the in-tray from an allowed sender:`,
    list,
    `Deal with ${one ? 'it' : 'them'} now. Read each with office-inbox read <name>, then hand the work out: work for the agents goes on the task queue with office-queue add --mail <name> (the sender is emailed when it's done), things for a person go on To Do Next with office-plans add --mail <name>, and GitHub issues or pull requests go to the Issues or PR agent with office-ask. Archive each item once it's filed. Then reply to the sender with office-mail reply <name>: a few friendly lines on what you did with it, and what happens next.`,
  ].join('\n\n');
}

export class Mailroom {
  private settingsFile: string;
  private memoryFile: string;
  private saved: Saved = {};
  private memory: Memory = emptyMemory();
  private status: MailState['status'] = 'off';
  private error?: string;
  private checkedAt?: number;
  private sendError?: string;
  private nextPollAt = 0;
  private failures = 0;
  private checking?: Promise<void>;
  private recheck?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private triage = new Map<string, Triage>();
  private watch = new Map<string, Watch>();
  private lastEmitted = '';
  private lastEmittedAt = 0;
  private stopped = false;

  constructor(
    dataDir: string,
    private office: MailOffice,
    private onState: (state: MailState) => void,
    private transport: MailTransport = netTransport,
    private now: () => number = Date.now,
  ) {
    this.settingsFile = path.join(dataDir, 'mail.json');
    this.memoryFile = path.join(dataDir, 'mail-state.json');
    this.saved = read<Saved>(this.settingsFile) ?? {};
    if (this.saved.account && !validAccount(this.saved.account)) this.saved.account = undefined;
    const m = read<Partial<Memory>>(this.memoryFile);
    if (m) this.memory = { ...emptyMemory(), ...m, stats: { ...emptyMemory().stats, ...m.stats } };
    if (this.saved.account) this.status = 'ok';
  }

  /** Starts looking at the mailbox (a few seconds from now) and keeps at it. */
  start() {
    this.nextPollAt = this.now() + 5_000;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  get account(): MailAccount | undefined {
    return this.saved.account;
  }

  state(): MailState {
    const a = this.saved.account;
    const stats = this.memory.stats;
    const base = { received: stats.received, ignored: stats.ignored, sent: stats.sent, lastMailAt: stats.lastMailAt, remindersOff: this.saved.remindersOff || undefined };
    if (!a) return { ...MAIL_OFF, ...base };
    return { ...base, configured: true, address: a.address, name: a.name, status: this.status, error: this.error, checkedAt: this.checkedAt, sendError: this.sendError, autoTriage: a.autoTriage, briefing: a.briefing || undefined, awayAlerts: a.awayAlerts };
  }

  /** What the Receptionist is told about her mailbox. */
  brief(): MailBrief {
    const a = this.saved.account;
    if (!a) return { configured: false };
    const problem = this.status === 'error' ? this.error : this.sendError ? `she can't send email: ${this.sendError}` : undefined;
    return { configured: true, address: a.address, ...(problem ? { problem } : {}) };
  }

  /** Her settings as an admin sees them in the setup form (no password). */
  view(): MailSettingsView | undefined {
    const a = this.saved.account;
    if (!a) return undefined;
    const { pass, ...rest } = a;
    return { ...rest, passSet: !!pass };
  }

  /** Checks settings from the form, filling in the saved password when the form left it blank. */
  validate(input: unknown): MailAccount | string {
    if (!input || typeof input !== 'object') return 'Fill in the form';
    const v = input as Record<string, any>;
    const saved = this.saved.account;
    const text = (x: unknown, max: number) => (typeof x === 'string' ? x.replace(/[\r\n\0]+/g, ' ').trim().slice(0, max) : '');
    const address = text(v.address, 254).toLowerCase();
    if (!isEmailAddress(address)) return 'Type her email address: the mailbox you made for her';
    const name = text(v.name, 60) || 'Receptionist';
    const host = (x: unknown) => text(x, 253).toLowerCase();
    const port = (x: unknown, dflt: number) => (x === undefined || x === '' ? dflt : Number(x));
    const imap = { host: host(v.imap?.host), port: port(v.imap?.port, 993) };
    const smtpPort = port(v.smtp?.port, 465);
    const smtp = { host: host(v.smtp?.host), port: smtpPort, security: (v.smtp?.security === 'tls' || v.smtp?.security === 'starttls' ? v.smtp.security : smtpPort === 465 ? 'tls' : 'starttls') as MailSecurity };
    for (const [what, s] of [['incoming (IMAP)', imap], ['outgoing (SMTP)', smtp]] as const) {
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s.host)) return `Type the ${what} server's name`;
      if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return `The ${what} port is a number from 1 to 65535`;
    }
    const user = text(v.user, 320) || address;
    const typed = typeof v.pass === 'string' ? v.pass.replace(/[\r\n]+/g, '') : '';
    if (typed.length > 1024) return 'That password is too long';
    // A blank password keeps the saved one, but only for the same mailbox on the same servers.
    const same = saved && saved.address === address && saved.user === user && saved.imap.host === imap.host && saved.smtp.host === smtp.host;
    const pass = typed || (same ? saved.pass : '');
    if (!pass) return 'Paste her mailbox’s app password';
    const ownersRaw = Array.isArray(v.owners) ? v.owners : typeof v.owners === 'string' ? v.owners.split(/[\s,;]+/) : [];
    const owners = [...new Set(ownersRaw.map((o: unknown) => text(o, 254).toLowerCase()).filter(Boolean))] as string[];
    if (!owners.length) return 'Type your own email address under “Who can email her”: only mail from there is acted on';
    const bad = owners.find((o) => !isEmailAddress(o));
    if (bad) return `${bad} isn't an email address`;
    if (owners.some((o) => plainAddress(o) === plainAddress(address))) return 'Her own address can’t be one of the people who email her: she would end up writing to herself';
    if (owners.length > 20) return 'Up to 20 people can email her';
    const floor = text(v.floor, 120);
    if (floor && !this.office.floors().some((f) => f.id === floor)) return 'Choose one of the floors for mail that doesn’t say which';
    const briefing = text(v.briefing, 5);
    if (briefing && !/^([01]\d|2[0-3]):[0-5]\d$/.test(briefing)) return 'The briefing time is like 08:00';
    const flag = (x: unknown, dflt: boolean) => (typeof x === 'boolean' ? x : dflt);
    return { address, name, imap, smtp, user, pass, owners, onlyOwners: flag(v.onlyOwners, true), floor, autoTriage: flag(v.autoTriage, true), briefing, awayAlerts: flag(v.awayAlerts, true), by: saved?.by ?? '', at: saved?.at ?? 0 };
  }

  /** Tries settings without saving them. */
  async test(input: unknown): Promise<{ imap?: string; smtp?: string; error?: string }> {
    const a = this.validate(input);
    if (typeof a === 'string') return { error: a };
    return this.hideSecret(a, await this.transport.verify(a));
  }

  /** Saves settings once her mailbox lets her in. A first setup sends the owner a welcome email with the how-to. */
  async save(input: unknown, by: string): Promise<{ ok: boolean; error?: string; warning?: string; state: MailState }> {
    const v = this.validate(input);
    if (typeof v === 'string') return { ok: false, error: v, state: this.state() };
    const check = this.hideSecret(v, await this.transport.verify(v));
    if (check.imap) return { ok: false, error: `Her mailbox didn't let her in: ${check.imap}`, state: this.state() };
    const before = this.saved.account;
    this.saved.account = { ...v, by, at: this.now() };
    this.persistSettings();
    if (!before || fingerprint(before) !== fingerprint(v)) this.memory.cursor = {};
    this.status = 'ok';
    this.error = undefined;
    this.sendError = check.smtp;
    this.failures = 0;
    this.nextPollAt = this.now();
    this.persistMemory();
    this.emit(true);
    let warning = check.smtp ? `She can read mail, but sending didn't work, so she can't write back yet: ${check.smtp}` : undefined;
    if (!check.smtp && !before) {
      const err = await this.deliver(this.saved.account, { to: [v.owners[0]], subject: '💁‍♀️ Your Receptionist is set up', text: this.welcomeText(this.saved.account), thread: { kind: 'welcome' } });
      if (err) warning = `Saved, but the welcome email didn't go: ${err}`;
    }
    void this.check();
    return { ok: true, warning, state: this.state() };
  }

  /** Forgets her mailbox (and its password). */
  remove() {
    this.saved.account = undefined;
    this.persistSettings();
    this.memory.cursor = {};
    this.persistMemory();
    this.status = 'off';
    this.error = this.sendError = undefined;
    this.triage.clear();
    this.watch.clear();
    this.emit(true);
  }

  /** An admin asked her to stop (or start again) reminding everyone that she has no email. */
  setReminders(off: boolean) {
    this.saved.remindersOff = off || undefined;
    this.persistSettings();
    this.emit(true);
  }

  /**
   * Looks at the mailbox now. Asked while a look is under way, it looks once more after that one, so
   * mail that arrived meanwhile is included; however many ask meanwhile share that second look.
   */
  check(): Promise<void> {
    const a = this.saved.account;
    if (!a || this.stopped) return Promise.resolve();
    if (this.checking) {
      this.recheck ??= this.checking.then(() => {
        this.recheck = undefined;
        return this.check();
      });
      return this.recheck;
    }
    this.checking = this.poll(a).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async poll(a: MailAccount) {
    const now = this.now();
    try {
      const cursor = this.memory.cursor.account === fingerprint(a) ? this.memory.cursor : {};
      const r = await this.transport.receive(a, cursor, (m) => this.take(a, m));
      if (this.saved.account !== a) return;
      this.memory.cursor = { uidValidity: r.uidValidity, lastUid: r.lastUid, account: fingerprint(a) };
      this.failures = 0;
      this.status = r.error ? 'error' : 'ok';
      this.error = r.error ? this.clean(a, r.error.message) : undefined;
      this.nextPollAt = this.now() + POLL_MS;
    } catch (err) {
      if (this.saved.account !== a) return;
      this.failures++;
      this.status = 'error';
      this.error = this.clean(a, (err as Error).message);
      const auth = (err instanceof ImapError || err instanceof SmtpError) && err.auth;
      this.nextPollAt = this.now() + Math.max(auth ? AUTH_BACKOFF_MS : 0, Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** (this.failures - 1)));
    }
    this.checkedAt = now;
    this.persistMemory();
    this.flushTriage();
    this.emit();
  }

  /** One message from the mailbox. Resolves to whether to mark it read (unknown senders' mail is left unread). */
  private async take(a: MailAccount, m: Inbound): Promise<boolean> {
    if (!m.raw) return true;
    const mail = parseMail(m.raw);
    const from = mail.from?.address;
    const stats = this.memory.stats;
    if (!from || plainAddress(from) === plainAddress(a.address) || mail.headers.has('x-agent-office') || mail.automatic) {
      stats.ignored++;
      return true;
    }
    const owner = a.owners.some((o) => plainAddress(o) === plainAddress(from));
    const verdict = senderVerdict(mail.auth);
    const trusted = owner && verdict !== 'fail';
    if (!owner && a.onlyOwners) {
      stats.ignored++;
      return false;
    }
    const floors = this.office.floors();
    if (!floors.length) throw new Error('The office has no floors to put mail on yet');
    stats.received++;
    stats.lastMailAt = this.now();
    const sender = mail.from?.name || from;
    // A reply to something she sent: an answer for the worker it was about, if it can take one now.
    const thread = this.threadOf(mail);
    if (thread && trusted && this.answer(thread, mail, sender)) return true;
    const route = routeMail(a.address, mail, floors, a.floor);
    const floor = route.floor;
    const title = route.title || firstLine(mail.text).slice(0, 120) || '(no subject)';
    const { item, attachments } = this.file(floor, a, mail, title, { owner, verdict, headersOnly: !!m.headersOnly, size: m.size, thread });
    const key = originKey(floor.id, item);
    this.memory.origins[key] = {
      floor: floor.id,
      item,
      from: from.toLowerCase(),
      name: mail.from?.name,
      subject: mail.subject || title,
      messageId: mail.messageId,
      references: [...mail.references, ...(mail.messageId ? [mail.messageId] : [])].slice(-20),
      trusted,
      at: this.now(),
    };
    if (!trusted) {
      this.office.toast(floor.id, owner ? `📧 Mail that says it's from ${from} is in the tray, but the sender couldn't be verified, so it isn't acted on` : `📧 Mail from ${from} is in the tray`, 'warn');
      return true;
    }
    if (route.shortcut) {
      this.shortcut(a, floor, { item, attachments }, key, route.shortcut, title, mail, sender);
      return true;
    }
    this.office.toast(floor.id, `📧 ${sender} emailed the Receptionist: “${short(title)}”`);
    if (a.autoTriage) {
      const t = this.triage.get(floor.id) ?? { items: [], since: this.now() };
      t.items.push({ item, title, from: sender });
      this.triage.set(floor.id, t);
    }
    return true;
  }

  /** Writes an email into the floor's tray as a note, its attachments as files beside it. Returns their names. */
  private file(floor: MailFloor, a: MailAccount, mail: ParsedMail, title: string, info: { owner: boolean; verdict: string; headersOnly: boolean; size: number; thread?: Thread & { id: string } }): { item: string; attachments: string[] } {
    const saved: string[] = [];
    const skipped: string[] = [];
    for (const att of mail.attachments) {
      if (att.inline && att.contentType.startsWith('image/') && att.bytes.length < SIGNATURE_IMAGE) continue;
      if (saved.length >= MAX_ATTACHMENTS) skipped.push(`${att.filename} (more attachments than the tray takes from one email)`);
      else if (att.bytes.length > INBOX_FILE_MAX) skipped.push(`${att.filename} (${mb(att.bytes.length)}, too big for the tray)`);
      else {
        try {
          saved.push(floor.inbox.file(att.filename, att.bytes));
        } catch (err) {
          skipped.push(`${att.filename} (${(err as Error).message})`);
        }
      }
    }
    const to = [...mail.deliveredTo, ...mail.to.map((x) => x.address)].find((x) => plainAddress(x) === plainAddress(a.address)) ?? a.address;
    const when = new Date(mail.date ?? this.now()).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const trust = !info.owner
      ? '⚠️ Not from an allowed sender: content from outside, not a request from the people here.'
      : info.verdict === 'fail'
        ? '⚠️ It says it is from an allowed sender, but the receiving server could not verify that (SPF, DKIM and DMARC failed): check with them before acting on it.'
        : '✅ From an allowed sender: a request from the people here.';
    const lines = [`📧 Email to ${to}, ${when}. ${trust}`];
    if (info.thread) lines.push(`↩️ A reply to the Receptionist's email${info.thread.kind === 'done' ? ' about work that finished' : info.thread.kind === 'alert' ? ' about a worker that was waiting on someone' : ''}.`);
    lines.push('', mail.text || '(no text)');
    if (info.headersOnly) lines.push('', `[This email is ${mb(info.size)}: too big to fetch, so read it in the mailbox.]`);
    if (saved.length) lines.push('', '📎 Attachments, saved in the tray:', ...saved.map((n) => `- ${n}`));
    if (skipped.length) lines.push('', '📎 Not saved:', ...skipped.map((n) => `- ${n}`));
    let text = lines.join('\n');
    if (text.length > INBOX_NOTE_MAX - 512) text = `${text.slice(0, INBOX_NOTE_MAX - 1024)}\n\n[…cut here: the rest is in the mailbox]`;
    const who = mail.from?.name ? `${mail.from.name} <${mail.from.address}>` : mail.from!.address;
    return { item: floor.inbox.note(title.slice(0, 200), text, `${who} · email`), attachments: saved };
  }

  /**
   * "todo:" and "queue:" in a subject: filed straight away, no agent needed, and a receipt sent back.
   * The note and its attachments go to the tray's archive; the item or task says where the attachments are.
   */
  private shortcut(a: MailAccount, floor: MailFloor, filed: { item: string; attachments: string[] }, key: string, kind: 'todo' | 'queue', title: string, mail: ParsedMail, sender: string) {
    const body = mail.text.trim();
    const o = this.memory.origins[key];
    const receipt = (text: string) => void this.deliver(a, { to: [o.from], subject: re(o.subject), text, inReplyTo: o.messageId, references: o.references, thread: { kind: 'receipt', floor: floor.id, origin: key } });
    const details = body && body !== title ? body : '';
    const put = () => {
      const moved = filed.attachments.map((name) => this.archive(floor, name)).filter((p): p is string => !!p);
      this.archive(floor, filed.item);
      return moved.length ? `\n\n📎 Attachments from the email:\n${moved.map((p) => `- ${p}`).join('\n')}` : '';
    };
    if (kind === 'todo') {
      let id: string | undefined;
      try {
        id = floor.plans.apply({ action: 'add', text: `${title}${details ? `\n\n${details}` : ''}`.slice(0, 9_000) }).items.at(-1)?.id;
      } catch (err) {
        this.office.toast(floor.id, `📧 Couldn't file “${short(title)}” on To Do Next: ${(err as Error).message}`, 'warn');
        return receipt(`I couldn't put “${title}” on To Do Next on the ${floor.name} floor: ${(err as Error).message}. It's waiting in the in-tray instead.`);
      }
      const files = put();
      if (id) {
        this.memory.links[linkKey(floor.id, 'plan', id)] = { origin: key };
        // The attachments belong with the item.
        if (files) {
          try {
            const plan = floor.plans.state().items.find((p) => p.id === id);
            if (plan) floor.plans.apply({ action: 'edit', id, text: `${plan.text}${files}`.slice(0, 10_000) });
          } catch {
            // the item stands without them
          }
        }
      }
      this.office.toast(floor.id, `📒 ${sender} emailed “${short(title)}” onto To Do Next`);
      return receipt(`📒 Added to To Do Next on the ${floor.name} floor:\n\n${title}\n\nI'll email you when a worker finishes it. Reply here to add anything.`);
    }
    const files = put();
    const prompt = `From an email by ${sender} (subject: ${o.subject}):\n\n${title}${details ? `\n\n${details}` : ''}${files}\n\nIt came to the office's Receptionist from an allowed sender, so it's a request from the people here. Do what it asks, then say what you did.`;
    const err = floor.queue.add(prompt, `${sender} by email`, title.slice(0, 120));
    if (err) {
      this.office.toast(floor.id, `📧 Couldn't queue “${short(title)}”: ${err}`, 'warn');
      return receipt(`I couldn't queue “${title}” on the ${floor.name} floor: ${err}. The email is in the in-tray's archive; forward it to me again when there's room.`);
    }
    const task = floor.queue.state().tasks.at(-1);
    if (task) this.memory.links[linkKey(floor.id, 'task', task.id)] = { origin: key };
    this.office.toast(floor.id, `📋 ${sender} emailed “${short(title)}” onto the task queue`);
    receipt(`📋 Queued on the ${floor.name} floor:\n\n${title}\n\nA worker picks it up as soon as there's room, and I'll email you here when it's done.`);
  }

  /** Puts a tray item away; resolves to where it went. */
  private archive(floor: MailFloor, item: string): string | undefined {
    try {
      return floor.inbox.archive(item);
    } catch {
      // someone put it away already
      return undefined;
    }
  }

  /** The office's email this one replies to, if it's one. */
  private threadOf(mail: ParsedMail): (Thread & { id: string }) | undefined {
    for (const id of [...mail.inReplyTo, ...[...mail.references].reverse()]) {
      const t = this.memory.threads[id];
      if (t) return { ...t, id };
    }
    return undefined;
  }

  /** A reply to a "needs you" or "done" email goes to that worker as its next message, when it's free to take one. */
  private answer(t: Thread, mail: ParsedMail, sender: string): boolean {
    if ((t.kind !== 'alert' && t.kind !== 'done') || !t.floor || !t.worker) return false;
    const floor = this.floor(t.floor);
    const w = floor?.workers.get(t.worker);
    const text = stripQuoted(mail.text);
    if (!floor || !w || !text) return false;
    const by = `${sender} by email`;
    let err: string | undefined;
    if (w.status === 'done' || w.status === 'idle') err = floor.workers.prompt(w.id, text, by);
    else if (w.status === 'exited' || w.status === 'offline') err = floor.workers.resume(w.id, text);
    else return false;
    if (err) return false;
    this.office.toast(floor.id, `📧 ${sender} answered ${w.name} by email`);
    return true;
  }

  /** Wakes the Receptionist for the mail that came in, one prompt per floor. Tried again on later ticks when she can't be woken. */
  private flushTriage() {
    for (const [floorId, t] of this.triage) {
      const floor = this.floor(floorId);
      if (!floor) {
        this.triage.delete(floorId);
        continue;
      }
      const her = floor.workers.list().find((w) => w.deskId === INBOX_DESK);
      // Waiting on an answer in her terminal: a prompt typed now would answer it.
      const why = her?.status === 'needs_input' ? 'she is waiting on an answer in her terminal' : undefined;
      const r = why ?? floor.workers.station(INBOX_DESK, 'Email', triagePrompt(t.items));
      if (typeof r === 'string') {
        if (this.now() - t.since > TRIAGE_RETRY_MS) {
          this.triage.delete(floorId);
          this.office.toast(floorId, `📧 ${t.items.length === 1 ? 'An email waits' : `${t.items.length} emails wait`} in the in-tray: the Receptionist couldn't get to ${t.items.length === 1 ? 'it' : 'them'} (${r})`, 'warn');
        } else if (!t.warned) {
          t.warned = true;
          this.office.toast(floorId, `📧 New email is in the in-tray, but the Receptionist can't start on it yet: ${r}. She'll try again.`, 'warn');
        }
        continue;
      }
      this.triage.delete(floorId);
      this.office.toast(floorId, `💁‍♀️ The Receptionist is going through ${t.items.length === 1 ? `“${short(t.items[0].title, 40)}”` : `${t.items.length} new emails`}`);
    }
  }

  // ---- For the Receptionist (office-mail) and the other board agents ----------------------------

  /** Who sent a tray item, if it came by email. */
  origin(floorId: string, item: string): { from: string; name?: string; subject: string; trusted: boolean } | undefined {
    const o = this.memory.origins[originKey(floorId, item)];
    return o ? { from: o.from, name: o.name, subject: o.subject, trusted: o.trusted } : undefined;
  }

  /** Links a queued task or a To Do Next item to the email it came from, so its sender hears when it's done. */
  link(floorId: string, what: 'task' | 'plan', id: string, item: string): string | undefined {
    const key = originKey(floorId, item);
    const o = this.memory.origins[key];
    if (!o) return `${item} didn't come by email, so there's nobody to tell when it's done`;
    if (!o.trusted) return `${item} isn't from an allowed sender, so nobody is emailed about it`;
    this.memory.links[linkKey(floorId, what, id)] = { origin: key };
    this.persistMemory();
    return undefined;
  }

  /** Her reply to the sender of a tray item, in their thread. Resolves to what went wrong, if anything. */
  async reply(floorId: string, item: string, text: string): Promise<string | undefined> {
    const a = this.saved.account;
    if (!a) return "Her email isn't set up";
    const key = originKey(floorId, item);
    const o = this.memory.origins[key];
    if (!o) return `${item} didn't come by email`;
    if (!o.trusted) return `${item} isn't from an allowed sender: she only writes to the people here`;
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Write something to send';
    if (clean.length > 20_000) return 'Keep it under 20,000 characters';
    return this.deliver(a, { to: [o.from], subject: re(o.subject), text: clean, inReplyTo: o.messageId, references: o.references, thread: { kind: 'reply', floor: floorId, origin: key } });
  }

  /** An email to the owner (the first person allowed to email her). */
  async toOwner(subject: string, text: string, floorId?: string): Promise<string | undefined> {
    const a = this.saved.account;
    if (!a) return "Her email isn't set up";
    const s = subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    const clean = text.replace(/\r\n?/g, '\n').trim();
    if (!s) return 'Give it a subject';
    if (!clean) return 'Write something to send';
    if (clean.length > 20_000) return 'Keep it under 20,000 characters';
    return this.deliver(a, { to: [a.owners[0]], subject: s, text: clean, thread: { kind: 'note', floor: floorId } });
  }

  // ---- Hearing from the floors -----------------------------------------------------------------

  /** A floor's queue changed: tasks that came by email and just finished get their sender an email. */
  onQueue(floorId: string, state: QueueState) {
    const a = this.saved.account;
    if (!a) return;
    for (const t of state.tasks) {
      if (t.status !== 'done' || !t.finishedAt) continue;
      const key = linkKey(floorId, 'task', t.id);
      const link = this.memory.links[key];
      if (!link || link.notified === t.finishedAt) continue;
      const o = this.memory.origins[link.origin];
      if (!o) {
        delete this.memory.links[key];
        continue;
      }
      // Done is done; a task that stopped short keeps its link, so a requeue that finishes is told too.
      if (t.outcome === 'done') delete this.memory.links[key];
      else link.notified = t.finishedAt;
      // Its To Do Next item is finished by the same thing: one email is enough.
      if (t.plan) delete this.memory.links[linkKey(floorId, 'plan', t.plan)];
      void this.deliver(a, { to: [o.from], subject: re(o.subject), text: this.doneText(floorId, t), inReplyTo: o.messageId, references: o.references, thread: { kind: 'done', floor: floorId, worker: t.workerId, task: t.id, origin: link.origin } });
    }
    this.persistMemory();
  }

  /** A floor's To Do Next board changed: items that came by email and a worker just finished get their sender an email. */
  onPlans(floorId: string, state: PlansState) {
    const a = this.saved.account;
    if (!a) return;
    let changed = false;
    for (const p of state.items) {
      const key = linkKey(floorId, 'plan', p.id);
      const link = this.memory.links[key];
      if (!link || p.status !== 'finished') continue;
      // Its queued task will say so, with the pull request.
      if (p.task && this.memory.links[linkKey(floorId, 'task', p.task)]) continue;
      delete this.memory.links[key];
      changed = true;
      const o = this.memory.origins[link.origin];
      // Finished by a person moving the card: they know already.
      if (!o || !p.worker) continue;
      const floor = this.floor(floorId);
      const w = floor?.workers.get(p.worker.id);
      const text = [`✅ Done: ${planTitle(p.text)}`, '', `${p.worker.name} finished it on the ${floor?.name ?? floorId} floor.`, ...(w?.task?.summary ? ['', `What it did: ${w.task.summary}`] : []), '', `Reply here to follow up: while ${p.worker.name} is still at its desk, your reply goes straight to it.`].join('\n');
      void this.deliver(a, { to: [o.from], subject: re(o.subject), text, inReplyTo: o.messageId, references: o.references, thread: { kind: 'done', floor: floorId, worker: p.worker.id, origin: link.origin } });
    }
    if (changed) this.persistMemory();
  }

  /** A worker changed: one left waiting on someone is watched, for an email if nobody's around to see it. */
  onWorker(floorId: string, w: WorkerInfo) {
    if (w.kind !== 'agent') return;
    const desk = DESK_BY_ID.get(w.deskId);
    if (desk?.station || desk?.room) return;
    if (w.status === 'needs_input' || w.status === 'done') {
      const prev = this.watch.get(w.id);
      if (!prev || prev.status !== w.status) this.watch.set(w.id, { floor: floorId, status: w.status, since: this.now() });
    } else this.watch.delete(w.id);
  }

  onWorkerGone(workerId: string) {
    this.watch.delete(workerId);
  }

  // ---- Every tick ----------------------------------------------------------------------------

  async tick() {
    const a = this.saved.account;
    if (!a || this.stopped) return;
    const now = this.now();
    if (now >= this.nextPollAt) await this.check();
    this.flushTriage();
    if (a.awayAlerts) await this.alerts(a, now);
    if (a.briefing) await this.maybeBrief(a, now);
  }

  /** Emails the owner about workers left waiting on someone while nobody's in the office. */
  private async alerts(a: MailAccount, now: number) {
    if (this.office.present() > 0) return;
    this.memory.alerts = this.memory.alerts.filter((t) => now - t < HOUR);
    for (const [id, watch] of this.watch) {
      if (watch.sent || now - watch.since < ALERT_AFTER_MS) continue;
      const floor = this.floor(watch.floor);
      const w = floor?.workers.get(id);
      if (!floor || !w || w.status !== watch.status) {
        this.watch.delete(id);
        continue;
      }
      if (w.acked || w.viewers.length) continue;
      watch.sent = true;
      // A task that came by email gets its own "done" email.
      const task = floor.queue.state().tasks.find((t) => t.workerId === id && t.status !== 'queued');
      if (w.status === 'done' && task && this.memory.links[linkKey(floor.id, 'task', task.id)]) continue;
      if (this.memory.alerts.length >= ALERTS_PER_HOUR) continue;
      this.memory.alerts.push(now);
      const waiting = w.status === 'needs_input';
      const detail = alertDetail(w);
      const text = [
        waiting ? `🙋 ${w.name} is waiting on you on the ${floor.name} floor.` : `✅ ${w.name} finished on the ${floor.name} floor, and it's your turn.`,
        ...(w.task ? ['', `Working on: ${w.task.name}${w.task.summary ? ` — ${w.task.summary}` : ''}`] : []),
        ...(detail ? ['', `${waiting ? 'It asks' : 'It said'}: ${short(detail, 600)}`] : []),
        '',
        waiting
          ? `It's waiting on a question or a permission in its terminal, so this one needs you at the office: ${this.office.url()}`
          : `Reply to this email and I'll pass your answer to ${w.name} as its next message.`,
      ].join('\n');
      await this.deliver(a, { to: [a.owners[0]], subject: `${waiting ? '🙋' : '✅'} ${w.name} ${waiting ? 'needs you' : 'is done'} · ${floor.name}`, text, thread: { kind: 'alert', floor: floor.id, worker: id } });
    }
  }

  private async maybeBrief(a: MailAccount, now: number) {
    const today = localDay(now);
    if (this.memory.briefedOn === today) return;
    const [hh, mm] = a.briefing.split(':').map(Number);
    const at = new Date(now);
    at.setHours(hh, mm, 0, 0);
    const late = now - at.getTime();
    if (late < 0) return;
    this.memory.briefedOn = today;
    this.persistMemory();
    if (late > BRIEFING_WINDOW_MS) return;
    await this.deliver(a, { to: [a.owners[0]], subject: `☀️ Your office this morning · ${new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`, text: this.briefingText(now), thread: { kind: 'briefing' } });
  }

  /** The morning briefing: each floor's tray, To Do Next and queue, who's waiting on you, and what finished since yesterday. */
  briefingText(now = this.now()): string {
    const since = now - DAY;
    const sections: string[] = [];
    for (const floor of this.office.floors()) {
      const tray = floor.inbox.list();
      const plans = floor.plans.state().items;
      const todo = plans.filter((p) => p.status === 'todo');
      const doing = plans.filter((p) => p.status === 'progress');
      const finished = plans.filter((p) => p.status === 'finished' && (p.finishedAt ?? 0) >= since);
      const tasks = floor.queue.state().tasks;
      const running = tasks.filter((t) => t.status === 'running');
      const queued = tasks.filter((t) => t.status === 'queued');
      const doneTasks = tasks.filter((t) => t.status === 'done' && t.outcome === 'done' && (t.finishedAt ?? 0) >= since);
      const waiting = floor.workers.list().filter((w) => w.kind === 'agent' && w.status === 'needs_input');
      if (!tray.length && !todo.length && !doing.length && !finished.length && !running.length && !queued.length && !doneTasks.length && !waiting.length) continue;
      const lines = [`🏢 ${floor.name}`];
      const list = (xs: string[], n = 5) => `${xs.slice(0, n).join(' · ')}${xs.length > n ? ` · and ${xs.length - n} more` : ''}`;
      if (tray.length) lines.push(`  📥 In the tray: ${tray.length} — ${list(tray.map((i) => `“${short(i.title, 40)}”`))}`);
      if (todo.length) lines.push(`  📒 To do: ${todo.length} — ${list(todo.map((p) => short(planTitle(p.text), 40)))}`);
      if (doing.length) lines.push(`  🔧 In progress: ${list(doing.map((p) => `${short(planTitle(p.text), 40)}${p.worker ? ` (${p.worker.name})` : ''}`))}`);
      if (running.length || queued.length) lines.push(`  📋 Task queue: ${running.length} running, ${queued.length} waiting`);
      if (waiting.length) lines.push(`  🙋 Waiting on you: ${list(waiting.map((w) => w.name))}`);
      const done = [...doneTasks.map((t) => `${short(t.title, 40)}${t.pr ? ` (PR #${t.pr.number})` : ''}`), ...finished.filter((p) => !p.task || !doneTasks.some((t) => t.id === p.task)).map((p) => short(planTitle(p.text), 40))];
      if (done.length) lines.push(`  ✅ Finished since yesterday: ${list(done)}`);
      sections.push(lines.join('\n'));
    }
    const out = [`Good morning! Here's your office at ${new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`, ''];
    out.push(sections.length ? sections.join('\n\n') : 'All quiet: nothing in the trays, nothing on the boards, nobody waiting on you.');
    const spent = this.office.spend?.(localDay(now - DAY));
    if (spent) out.push('', `💸 Tracked Claude spend yesterday: $${spent.toFixed(2)} (an estimate from the Claude workers' transcripts; other providers aren't counted).`);
    out.push('', 'Reply with anything you want done today, and I’ll hand it out.');
    return out.join('\n');
  }

  private doneText(floorId: string, t: QueueTask): string {
    const floor = this.floor(floorId);
    const w = t.workerId ? floor?.workers.get(t.workerId) : undefined;
    const who = t.workerName ?? 'A worker';
    const head = t.outcome === 'done' ? `✅ Done: ${t.title}` : `⚠️ Stopped: ${t.title}`;
    const lines = [head, ''];
    if (t.outcome === 'done') lines.push(`${who} finished it on the ${floor?.name ?? floorId} floor.`);
    else if (t.outcome === 'failed') lines.push(`It couldn't start on the ${floor?.name ?? floorId} floor: ${t.error ?? 'no reason given'}.`);
    else lines.push(`${who} stopped before finishing it on the ${floor?.name ?? floorId} floor${t.error ? ` (${t.error})` : ''}. Requeue it from the task queue in the office when you're ready.`);
    if (w?.task?.summary) lines.push('', `What it did: ${w.task.summary}`);
    if (t.pr) lines.push('', `Pull request #${t.pr.number} (${t.pr.state.toLowerCase()}): ${t.pr.url}`);
    if (t.outcome === 'done' && w) lines.push('', `Reply here to follow up: while ${w.name} is still at its desk, your reply goes straight to it.`);
    return lines.join('\n');
  }

  private welcomeText(a: MailAccount): string {
    const floors = this.office.floors();
    const [local, domain] = a.address.split('@');
    const example = floors[1] ?? floors[0];
    return [
      `Hi! I'm the Receptionist at your Agent Office. Email me at ${a.address} and I'll hand the work out.`,
      '',
      'How it works',
      '• Write to me like you would to an assistant: “Renew the car insurance before the 15th, the policy is attached.”',
      '• I read it, put work for the agents on the task queue, put things for you on To Do Next, and write back saying what I did.',
      '• When a queued task is done, I email you here with the result (and the pull request, if there is one).',
      '',
      'Shortcuts',
      '• A subject starting with “todo:” goes straight onto To Do Next.',
      '• A subject starting with “queue:” goes straight onto the task queue.',
      ...(example ? [`• Pick a floor with [${example.id}] at the start of the subject, or email ${local}+${example.id}@${domain}.`, `  Floors: ${floors.map((f) => f.id).join(', ')}.`] : []),
      ...(a.awayAlerts ? ['• When a worker needs you and nobody’s in the office, I email you. Reply, and your answer goes to the worker.'] : []),
      ...(a.briefing ? [`• Every morning at ${a.briefing} I send you a briefing.`] : []),
      '',
      `I only act on mail from ${a.owners.join(', ')}.`,
    ].join('\n');
  }

  // ---- Sending ---------------------------------------------------------------------------------

  /** Sends one of her emails; resolves to what went wrong, if anything. */
  private async deliver(a: MailAccount, msg: { to: string[]; subject: string; text: string; inReplyTo?: string; references?: string[]; thread?: Omit<Thread, 'at'> }): Promise<string | undefined> {
    const now = this.now();
    this.memory.sent = this.memory.sent.filter((t) => now - t < DAY);
    if (this.memory.sent.filter((t) => now - t < HOUR).length >= SEND_PER_HOUR || this.memory.sent.length >= SEND_PER_DAY) {
      return 'She has sent a lot of email lately, so she waits before sending more';
    }
    // Only ever to the people allowed to email her.
    const to = msg.to.filter((x) => a.owners.some((o) => plainAddress(o) === plainAddress(x)));
    if (!to.length) return 'She only writes to the people allowed to email her';
    const [, domain] = a.address.split('@');
    const id = `<${randomBytes(12).toString('hex')}@${domain}>`;
    const raw = composeMail({
      from: { name: a.name, address: a.address },
      to: to.map((address) => ({ address })),
      subject: msg.subject,
      text: `${msg.text}\n\n—\n💁‍♀️ ${a.name}, Agent Office · reply to this email and it comes to me`,
      messageId: id,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      date: new Date(now),
      headers: [['Auto-Submitted', 'auto-replied'], ['X-Agent-Office', 'receptionist']],
    });
    try {
      await this.transport.send(a, to, raw);
    } catch (err) {
      this.sendError = this.clean(a, (err as Error).message);
      this.emit(true);
      return this.sendError;
    }
    const was = this.sendError;
    this.sendError = undefined;
    this.memory.sent.push(now);
    this.memory.stats.sent++;
    if (msg.thread) this.memory.threads[id] = { ...msg.thread, at: now };
    this.prune(now);
    this.persistMemory();
    this.emit(!!was);
    return undefined;
  }

  // ---- Keeping things ----------------------------------------------------------------------------

  private floor(id: string): MailFloor | undefined {
    return this.office.floors().find((f) => f.id === id);
  }

  /** A server's words, never with her password in them. */
  private clean(a: MailAccount, message: string): string {
    return a.pass && a.pass.length >= 4 ? message.split(a.pass).join('•••') : message;
  }

  private hideSecret<T extends Record<string, string | undefined>>(a: MailAccount, r: T): T {
    const out = { ...r };
    for (const k of Object.keys(out) as (keyof T)[]) if (typeof out[k] === 'string') out[k] = this.clean(a, out[k] as string) as T[keyof T];
    return out;
  }

  private prune(now: number) {
    for (const [id, t] of Object.entries(this.memory.threads)) if (now - t.at > KEEP_THREADS_MS) delete this.memory.threads[id];
    for (const [key, o] of Object.entries(this.memory.origins)) {
      if (now - o.at <= KEEP_ORIGINS_MS) continue;
      if (Object.values(this.memory.links).some((l) => l.origin === key)) continue;
      delete this.memory.origins[key];
    }
  }

  private emit(force = false) {
    const s = this.state();
    const { checkedAt, ...rest } = s;
    const key = JSON.stringify(rest);
    // A look at the mailbox every minute that found nothing new tells the browsers only now and then.
    if (!force && key === this.lastEmitted && this.now() - this.lastEmittedAt < 5 * MINUTE) return;
    this.lastEmitted = key;
    this.lastEmittedAt = this.now();
    this.onState(s);
  }

  private persistSettings() {
    write(this.settingsFile, this.saved);
  }

  private persistMemory() {
    write(this.memoryFile, this.memory);
  }
}

function fingerprint(a: Pick<MailAccount, 'address' | 'user' | 'imap'>): string {
  return `${a.address}|${a.user}|${a.imap.host}:${a.imap.port}`;
}

function validAccount(a: MailAccount): boolean {
  return !!a && isEmailAddress(a.address) && typeof a.pass === 'string' && !!a.pass && Array.isArray(a.owners) && a.owners.length > 0 && !!a.imap?.host && !!a.smtp?.host;
}

function read<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function write(file: string, data: unknown) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    console.error(`mailroom: couldn't save ${path.basename(file)}:`, (err as Error).message);
    try {
      unlinkSync(tmp);
    } catch {
      // never made
    }
  }
}
