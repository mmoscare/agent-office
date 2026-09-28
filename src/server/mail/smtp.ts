// A small SMTP client (RFC 5321): how the Receptionist sends her replies. It connects with TLS
// straight away (port 465) or upgrades with STARTTLS (587), signs in with AUTH PLAIN or LOGIN, and
// hands over one message. Plain, unencrypted SMTP isn't offered: the password would travel in the clear.

import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { connectError } from './imap.js';
import type { MailSecurity } from '../../shared/mail.js';

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    /** The server turned the sign-in down. */
    readonly auth = false,
  ) {
    super(message);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  pass: string;
  timeoutMs?: number;
  /** Trust this certificate authority too (tests, or a mail server with its own). */
  ca?: string;
}

interface Reply {
  code: number;
  lines: string[];
}

/** The name the office gives itself in EHLO: this machine's, tidied into something a server accepts. */
function helloName(): string {
  const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '').replace(/^[.-]+|[.-]+$/g, '');
  return name.includes('.') ? name : `${name || 'agent-office'}.local`;
}

/** Lines starting with a dot get another one (RFC 5321 4.5.2), and every line ends in CRLF. */
export function dotStuff(message: string): string {
  return message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

class Conversation {
  private socket: net.Socket;
  private buffer = '';
  private lines: string[] = [];
  private waiter?: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private failed?: Error;

  constructor(
    socket: net.Socket,
    private timeoutMs: number,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket) {
    // No setEncoding: a STARTTLS upgrade takes this socket over, and TLS needs its bytes as they are.
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        this.lines.push(this.buffer.slice(0, nl).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.pump();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new SmtpError('The mail server closed the connection')));
  }

  /** The socket after STARTTLS: the old one's listeners stay behind on it. */
  replace(socket: net.Socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.attach(socket);
  }

  private fail(err: Error) {
    this.failed ??= err;
    const w = this.waiter;
    if (w) {
      clearTimeout(w.timer);
      this.waiter = undefined;
      w.reject(this.failed);
    }
  }

  /** A reply is complete at a line with its code and a space (not a dash) after it. */
  private pump() {
    const w = this.waiter;
    if (!w) return;
    const end = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return;
    const lines = this.lines.splice(0, end + 1);
    clearTimeout(w.timer);
    this.waiter = undefined;
    w.resolve({ code: Number(lines[end].slice(0, 3)), lines: lines.map((l) => l.slice(4)) });
  }

  read(timeoutMs = this.timeoutMs): Promise<Reply> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new SmtpError('The mail server stopped answering'));
        this.socket.destroy();
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.pump();
    });
  }

  write(s: string) {
    this.socket.write(s);
  }

  /** Sends a command and checks its reply's code. `secret` keeps the command out of the error. */
  async send(cmd: string, expect: number[], secret = false): Promise<Reply> {
    this.write(`${cmd}\r\n`);
    return this.expect(expect, secret ? cmd.split(' ').slice(0, 2).join(' ') : cmd);
  }

  async expect(codes: number[], what: string, timeoutMs?: number): Promise<Reply> {
    const r = await this.read(timeoutMs);
    if (!codes.includes(r.code)) {
      const said = r.lines.join(' ').trim();
      const auth = r.code === 535 || r.code === 534 || (r.code >= 500 && /^AUTH\b/i.test(what));
      throw new SmtpError(auth ? `The mail server refused the sign-in (${r.code}${said ? ` ${said}` : ''}): check the address, the login name and the app password` : `The mail server said ${r.code}${said ? ` ${said}` : ''} to ${what.split(':')[0]}`, r.code, auth);
    }
    return r;
  }

  get raw() {
    return this.socket;
  }

  close() {
    this.socket.destroy();
  }
}

function connect(opts: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const { host, port, ca } = opts;
    const tlsOpts = { servername: net.isIP(host) ? undefined : host, ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}) };
    const socket = opts.security === 'tls' ? tls.connect({ host, port, ...tlsOpts }) : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(`The mail server ${host} didn't answer`));
    }, Math.min(opts.timeoutMs ?? 30_000, 30_000));
    const ready = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    // Stays on after it connects, so an error before the conversation takes over can't go unheard.
    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(connectError(err, host, 'outgoing mail'));
    });
    socket.once(opts.security === 'tls' ? 'secureConnect' : 'connect', ready);
  });
}

function upgrade(socket: net.Socket, opts: SmtpOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const { host, ca } = opts;
    socket.removeAllListeners('data');
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    // The plain socket still carries the TLS one: an error on it must not go unheard.
    socket.on('error', () => undefined);
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}) });
    secure.on('error', (err: Error) => reject(connectError(err, host, 'outgoing mail')));
    secure.once('secureConnect', () => resolve(secure));
  });
}

/** Connects, says hello (upgrading to TLS for STARTTLS) and signs in. */
async function open(opts: SmtpOptions): Promise<Conversation> {
  const socket = await connect(opts);
  const talk = new Conversation(socket, opts.timeoutMs ?? 30_000);
  try {
    // A server says hello at once. Silence usually means the wrong kind of port: one that wants TLS
    // straight away, reached with STARTTLS (a TLS client talking to a plain port fails at once instead).
    try {
      await talk.expect([220], 'the greeting', Math.min(opts.timeoutMs ?? 10_000, 10_000));
    } catch (err) {
      if (err instanceof SmtpError && /stopped answering/.test(err.message)) {
        throw new SmtpError(`The mail server ${opts.host} didn't say hello on port ${opts.port}${opts.security === 'starttls' ? ': if that port expects TLS straight away (like 465), choose TLS' : ''}`);
      }
      throw err;
    }
    let hello = await hi(talk);
    if (opts.security === 'starttls') {
      if (!hello.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError(`The mail server ${opts.host} doesn't offer STARTTLS on port ${opts.port}: try port 465`);
      await talk.send('STARTTLS', [220]);
      talk.replace(await upgrade(talk.raw, opts));
      hello = await hi(talk);
    }
    const auth = hello.lines.map((l) => /^AUTH[ =](.*)$/i.exec(l)?.[1]).find(Boolean)?.toUpperCase().split(/\s+/) ?? [];
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      await talk.send(`AUTH PLAIN ${b64(`\0${opts.user}\0${opts.pass}`)}`, [235], true);
    } else {
      await talk.send('AUTH LOGIN', [334]);
      await talk.send(b64(opts.user), [334], true);
      await talk.send(b64(opts.pass), [235], true);
    }
    return talk;
  } catch (err) {
    talk.close();
    throw err;
  }
}

async function hi(talk: Conversation): Promise<Reply> {
  try {
    return await talk.send(`EHLO ${helloName()}`, [250]);
  } catch (err) {
    if (err instanceof SmtpError && err.code >= 500) return talk.send(`HELO ${helloName()}`, [250]);
    throw err;
  }
}

/** Signs in and out again: whether sending would work. */
export async function verifySmtp(opts: SmtpOptions): Promise<void> {
  const talk = await open(opts);
  await talk.send('QUIT', [221]).catch(() => undefined);
  talk.close();
}

/** Sends one message (already composed, see mime.ts) from `from` to each of `to`. */
export async function sendMail(opts: SmtpOptions, from: string, to: string[], message: string): Promise<void> {
  if (!to.length) throw new SmtpError('Nobody to send it to');
  const talk = await open(opts);
  try {
    await talk.send(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of to) await talk.send(`RCPT TO:<${rcpt}>`, [250, 251]);
    await talk.send('DATA', [354]);
    const body = dotStuff(message);
    talk.write(body.endsWith('\r\n') ? `${body}.\r\n` : `${body}\r\n.\r\n`);
    await talk.expect([250], 'the message', 120_000);
    await talk.send('QUIT', [221]).catch(() => undefined);
  } finally {
    talk.close();
  }
}
