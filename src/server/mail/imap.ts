// A small IMAP client (RFC 3501): just what the Receptionist needs to read her mailbox. It signs in
// over TLS, looks at the inbox, searches it by UID, fetches whole messages and marks them read.
// Literals ("{1234}" and that many bytes) are read by length, so a message's own lines never
// confuse it; a big one is gathered in chunks and put together once.

import net from 'node:net';
import tls from 'node:tls';

export class ImapError extends Error {
  constructor(
    message: string,
    /** The server turned the sign-in down: wrong address or password (retrying soon won't help). */
    readonly auth = false,
  ) {
    super(message);
  }
}

export interface ImapOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  timeoutMs?: number;
  /** Trust this certificate authority too (tests, or a mail server with its own). */
  ca?: string;
}

/** One line from the server, with the literals it carried: tag "*" untagged, "+" go ahead, else a command's tag. */
interface Response {
  tag: string;
  text: string;
  literals: Buffer[];
}

const MAX_LITERAL = 64 * 1024 * 1024;
const CRLF = Buffer.from('\r\n');

/** "28-Sep-2026", the way IMAP's SEARCH SINCE wants a date. */
export function imapDate(ms: number): string {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

/** An IMAP quoted string, or undefined when the text can't be one (it has line breaks or 8-bit characters). */
export function imapQuote(s: string): string | undefined {
  if (/[\r\n\0]/.test(s) || /[^\x20-\x7e]/.test(s)) return undefined;
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** What went wrong connecting, in plain words. */
export function connectError(err: unknown, host: string, what: string): Error {
  const e = err as NodeJS.ErrnoException & { reason?: string };
  const code = e?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ImapError(`Couldn't find the ${what} server ${host}: check its name`);
  if (code === 'ECONNREFUSED') return new ImapError(`The ${what} server ${host} refused the connection: check the port`);
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return new ImapError(`The ${what} server ${host} didn't answer`);
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate/i.test(e?.message ?? '')) return new ImapError(`The ${what} server's certificate didn't check out (${code || 'TLS'})`);
  if (/wrong version number|EPROTO/i.test(`${code} ${e?.message ?? ''}`)) return new ImapError(`The ${what} server at ${host} didn't speak TLS on that port`);
  return err instanceof Error ? err : new Error(String(err));
}

export class ImapClient {
  private socket?: net.Socket;
  private chunks: Buffer[] = [];
  private size = 0;
  /** Bytes the reader waits for before it looks again (a literal being gathered). */
  private need = 0;
  private tagN = 0;
  private pending?: { tag: string; untagged: Response[]; resolve: (r: { untagged: Response[]; text: string }) => void; reject: (e: Error) => void; onContinue?: () => void; timer: NodeJS.Timeout };
  private greeting?: { resolve: (r: Response) => void; reject: (e: Error) => void };
  private closedWith?: Error;
  capabilities = new Set<string>();

  private constructor(private opts: ImapOptions) {}

  /** Connects and signs in. */
  static async open(opts: ImapOptions): Promise<ImapClient> {
    const client = new ImapClient(opts);
    await client.connect();
    try {
      await client.login();
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  private get timeout() {
    return this.opts.timeoutMs ?? 60_000;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port, ca } = this.opts;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ImapError(`The mail server ${host} didn't answer`));
      }, Math.min(this.timeout, 30_000));
      const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}) });
      this.socket = socket;
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err) => {
        const e = connectError(err, host, 'mail');
        clearTimeout(timer);
        this.fail(e);
        reject(e);
      });
      socket.on('close', () => this.fail(new ImapError('The mail server closed the connection')));
      this.greeting = {
        resolve: (r) => {
          clearTimeout(timer);
          if (/^BYE\b/i.test(r.text)) return reject(new ImapError(`The mail server said goodbye: ${r.text.slice(4).trim()}`));
          this.noteCapabilities(r.text);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  private noteCapabilities(text: string) {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(text) ?? /^CAPABILITY (.+)$/i.exec(text);
    if (m) this.capabilities = new Set(m[1].toUpperCase().split(/\s+/));
  }

  private async login() {
    const { user, pass } = this.opts;
    const u = imapQuote(user);
    const p = imapQuote(pass);
    try {
      if (u && p) await this.command(`LOGIN ${u} ${p}`);
      else {
        // Can't be quoted: sign in with SASL PLAIN instead, the credentials sent once the server says go ahead.
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await this.command('AUTHENTICATE PLAIN', () => this.write(`${token}\r\n`));
      }
    } catch (err) {
      // Any NO or BAD to a sign-in is the server saying no to these credentials.
      if (err instanceof ImapError && /^(NO|BAD)\b/i.test(err.message)) {
        const said = err.message.replace(/^(NO|BAD)\s*(\[[^\]]*\]\s*)?/i, '').trim();
        throw new ImapError(`The mailbox refused the sign-in${said ? ` (${said})` : ''}: check the address, the login name and the app password`, true);
      }
      throw err;
    }
  }

  /** Opens a mailbox for reading and marking. */
  async select(mailbox = 'INBOX'): Promise<{ uidValidity: number; uidNext?: number; exists: number }> {
    const r = await this.command(`SELECT ${imapQuote(mailbox) ?? '"INBOX"'}`);
    let uidValidity = 0;
    let uidNext: number | undefined;
    let exists = 0;
    for (const u of r.untagged) {
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
      if (v) uidValidity = Number(v[1]);
      const n = /\[UIDNEXT (\d+)\]/i.exec(u.text);
      if (n) uidNext = Number(n[1]);
      const e = /^(\d+) EXISTS\b/i.exec(u.text);
      if (e) exists = Number(e[1]);
    }
    return { uidValidity, uidNext, exists };
  }

  /** UID SEARCH: the UIDs matching `criteria` (e.g. "UID 120:*", "UNSEEN SINCE 27-Sep-2026"). */
  async search(criteria: string): Promise<number[]> {
    const r = await this.command(`UID SEARCH ${criteria}`);
    const uids = new Set<number>();
    for (const u of r.untagged) {
      if (!/^SEARCH\b/i.test(u.text)) continue;
      for (const n of u.text.slice(6).trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.add(Number(n));
    }
    return [...uids].sort((a, b) => a - b);
  }

  /** How big each message is, by UID. */
  async sizes(uids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (!uids.length) return out;
    const r = await this.command(`UID FETCH ${uids.join(',')} (UID RFC822.SIZE)`);
    for (const u of r.untagged) {
      if (!/^\d+ FETCH\b/i.test(u.text)) continue;
      const uid = /\bUID (\d+)/i.exec(u.text);
      const size = /\bRFC822\.SIZE (\d+)/i.exec(u.text);
      if (uid && size) out.set(Number(uid[1]), Number(size[1]));
    }
    return out;
  }

  /** A whole message (or just its headers), without marking it read. */
  async fetch(uid: number, headersOnly = false): Promise<Buffer | undefined> {
    const section = headersOnly ? 'HEADER' : '';
    const r = await this.command(`UID FETCH ${uid} (UID BODY.PEEK[${section}])`);
    const want = new RegExp(`BODY\\[${section}\\](?:<\\d+>)? \\{(\\d+)\\+?\\}\\r\\n`, 'i');
    for (const u of r.untagged) {
      if (!/^\d+ FETCH\b/i.test(u.text)) continue;
      const id = /\bUID (\d+)/i.exec(u.text);
      if (id && Number(id[1]) !== uid) continue;
      const m = want.exec(u.text);
      if (!m) continue;
      // Which literal: the ones before it in the line come first.
      const before = (u.text.slice(0, m.index).match(/\{\d+\+?\}\r\n/g) ?? []).length;
      return u.literals[before];
    }
    return undefined;
  }

  async markSeen(uids: number[]): Promise<void> {
    if (!uids.length) return;
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Seen)`);
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // gone already
    }
    this.close();
  }

  close() {
    this.socket?.destroy();
  }

  private write(s: string) {
    this.socket?.write(s);
  }

  /** Sends a command and waits for its tagged answer; `onContinue` answers the server's "+" (go ahead). */
  private command(cmd: string, onContinue?: () => void): Promise<{ untagged: Response[]; text: string }> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (this.pending) return Promise.reject(new ImapError('One command at a time'));
    const tag = `A${String(++this.tagN).padStart(3, '0')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new ImapError('The mail server stopped answering'));
        this.close();
      }, this.timeout);
      this.pending = { tag, untagged: [], resolve, reject, onContinue, timer };
      this.write(`${tag} ${cmd}\r\n`);
    });
  }

  private fail(err: Error) {
    if (this.closedWith) return;
    this.closedWith = err;
    if (this.greeting) {
      this.greeting.reject(err);
      this.greeting = undefined;
    }
    const p = this.pending;
    if (p) {
      clearTimeout(p.timer);
      this.pending = undefined;
      p.reject(err);
    }
  }

  private onData(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size < this.need) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    this.chunks = [];
    this.size = 0;
    this.need = 0;
    try {
      while (buf.length) {
        const r = readResponse(buf);
        if ('need' in r) {
          this.chunks = [buf];
          this.size = buf.length;
          this.need = r.need;
          return;
        }
        buf = buf.subarray(r.consumed);
        this.dispatch(r.response);
      }
    } catch (err) {
      this.fail(err as Error);
      this.close();
    }
  }

  private dispatch(r: Response) {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = undefined;
      g.resolve(r);
      return;
    }
    const p = this.pending;
    if (r.tag === '+') {
      p?.onContinue?.();
      return;
    }
    if (r.tag === '*') {
      if (/^CAPABILITY\b/i.test(r.text)) this.noteCapabilities(r.text);
      p?.untagged.push(r);
      return;
    }
    if (!p || r.tag !== p.tag) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    const status = r.text.split(' ')[0]?.toUpperCase();
    this.noteCapabilities(r.text);
    if (status === 'OK') p.resolve({ untagged: p.untagged, text: r.text });
    else p.reject(new ImapError(r.text, /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|invalid credentials|login failed|authentication failed|web login required|application-specific password/i.test(r.text)));
  }
}

/**
 * Reads one response (a line, with any literals it carries) off the front of `buf`: what it is and
 * how many bytes it took, or how many bytes it needs before it's complete.
 */
export function readResponse(buf: Buffer): { response: Response; consumed: number } | { need: number } {
  let pos = 0;
  let text = '';
  const literals: Buffer[] = [];
  for (;;) {
    const nl = buf.indexOf(CRLF, pos);
    if (nl < 0) return { need: buf.length + 1 };
    const line = buf.toString('utf8', pos, nl);
    const m = /\{(\d+)\+?\}$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n > MAX_LITERAL) throw new ImapError('The mail server sent more than the office can take in one go');
      const start = nl + 2;
      if (buf.length < start + n) return { need: start + n + 2 };
      literals.push(Buffer.from(buf.subarray(start, start + n)));
      text += `${line}\r\n`;
      pos = start + n;
      continue;
    }
    text += line;
    const sp = text.indexOf(' ');
    return { response: { tag: sp < 0 ? text : text.slice(0, sp), text: sp < 0 ? '' : text.slice(sp + 1), literals }, consumed: nl + 2 };
  }
}
