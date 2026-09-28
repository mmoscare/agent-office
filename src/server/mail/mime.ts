// Reading and writing email: just enough RFC 5322 and MIME for the Receptionist's mailbox. Reading
// takes a whole message (bytes, as IMAP hands it over) apart into who it's from, what it's about, its
// text and its attachments. Writing makes a plain-text UTF-8 message, quoted-printable encoded.

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  /** Inline in the message (a picture in a signature), not attached. */
  inline: boolean;
  bytes: Buffer;
}

/** What the receiving server found checking the sender (the topmost Authentication-Results header). */
export interface AuthResults {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

export interface ParsedMail {
  /** Every header, lowercased name → values (topmost first), with encoded words decoded. */
  headers: Map<string, string[]>;
  from?: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  /** Delivered-To and X-Original-To: the address it actually reached, plus-tag and all. */
  deliveredTo: string[];
  subject: string;
  date?: number;
  messageId?: string;
  inReplyTo: string[];
  references: string[];
  /** The message's text: its plain-text part, or its HTML part as text. */
  text: string;
  attachments: MailAttachment[];
  /** Sent by a machine, not a person: an auto-reply, a bounce, a newsletter or mailing list. */
  automatic: boolean;
  auth?: AuthResults;
}

const MAX_DEPTH = 12;
const MAX_PARTS = 300;

// ---- Reading ------------------------------------------------------------------------------------

export function parseMail(raw: Buffer): ParsedMail {
  const root = parsePart(raw);
  const walked: Walked = { plain: [], html: [], attachments: [], parts: 0 };
  walk(root, walked, 0);
  const headers = root.headers;
  const one = (name: string) => headers.get(name)?.[0];
  const all = (name: string) => headers.get(name) ?? [];
  const addresses = (name: string) => all(name).flatMap(parseAddressList);
  const ids = (name: string) => all(name).flatMap((v) => v.match(/<[^<>\s]+>/g) ?? []);
  const date = one('date') ? Date.parse(one('date')!.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
  const text = walked.plain.length ? walked.plain.join('\n\n') : walked.html.map(htmlToText).join('\n\n');
  const type = parseParams(one('content-type') ?? '').value;
  return {
    headers,
    from: addresses('from')[0] ?? addresses('sender')[0],
    to: addresses('to'),
    cc: addresses('cc'),
    replyTo: addresses('reply-to'),
    deliveredTo: [...all('delivered-to'), ...all('x-original-to')].flatMap(parseAddressList).map((a) => a.address),
    subject: (one('subject') ?? '').replace(/\s+/g, ' ').trim(),
    date: Number.isFinite(date) ? date : undefined,
    messageId: ids('message-id')[0],
    inReplyTo: ids('in-reply-to'),
    references: ids('references'),
    text: text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim(),
    attachments: walked.attachments,
    automatic: isAutomatic(headers, type),
    auth: authResults(one('authentication-results')),
  };
}

interface Part {
  headers: Map<string, string[]>;
  body: Buffer;
}

interface Walked {
  plain: string[];
  html: string[];
  attachments: MailAttachment[];
  parts: number;
}

function parsePart(raw: Buffer): Part {
  let at = raw.indexOf('\r\n\r\n');
  let skip = 4;
  const lf = raw.indexOf('\n\n');
  if (lf >= 0 && (at < 0 || lf < at)) {
    at = lf;
    skip = 2;
  }
  // A part that starts with a blank line has no headers at all.
  if (raw[0] === 0x0a || (raw[0] === 0x0d && raw[1] === 0x0a)) return { headers: new Map(), body: raw.subarray(raw[0] === 0x0a ? 1 : 2) };
  if (at < 0) return { headers: parseHeaders(textOf(raw)), body: Buffer.alloc(0) };
  return { headers: parseHeaders(textOf(raw.subarray(0, at))), body: raw.subarray(at + skip) };
}

/** Header bytes as text: UTF-8 when they are (RFC 6532), else the old 8-bit way. */
function textOf(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function parseHeaders(head: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  for (const line of head.replace(/\r?\n(?=[ \t])/g, '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    const list = headers.get(name) ?? [];
    list.push(decodeWords(line.slice(colon + 1).trim()));
    headers.set(name, list);
  }
  return headers;
}

function walk(part: Part, out: Walked, depth: number) {
  if (++out.parts > MAX_PARTS) return;
  const header = (name: string) => part.headers.get(name)?.[0] ?? '';
  const ct = parseParams(header('content-type') || 'text/plain');
  const type = ct.value || 'text/plain';
  const disposition = parseParams(header('content-disposition'));
  const filename = (disposition.params.filename || ct.params.name || '').trim();
  if (type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    const kids = splitMultipart(part.body, ct.params.boundary).map(parsePart);
    if (type === 'multipart/alternative') {
      // One of them is the message: plain text when there is one, else the richest.
      const results = kids.map((k) => {
        const w: Walked = { plain: [], html: [], attachments: [], parts: out.parts };
        walk(k, w, depth + 1);
        out.parts = Math.max(out.parts, w.parts);
        return w;
      });
      const chosen = results.find((w) => w.plain.length) ?? [...results].reverse().find((w) => w.html.length) ?? results[0];
      if (chosen) {
        out.plain.push(...chosen.plain);
        out.html.push(...chosen.html);
      }
      for (const w of results) out.attachments.push(...w.attachments);
      return;
    }
    for (const k of kids) walk(k, out, depth + 1);
    return;
  }
  const data = decodeTransfer(part.body, header('content-transfer-encoding'));
  const attached = disposition.value === 'attachment' || !!filename;
  if (!attached && (type === 'text/plain' || type === 'text/html')) {
    (type === 'text/plain' ? out.plain : out.html).push(decodeBytes(data, ct.params.charset));
    return;
  }
  if (!attached && (type === 'message/delivery-status' || type.startsWith('text/rfc822-headers'))) return;
  if (!data.length) return;
  const same = out.attachments.filter((a) => (type === 'message/rfc822') === (a.contentType === 'message/rfc822')).length;
  out.attachments.push({ filename: filename || defaultName(type, same + 1), contentType: type, inline: disposition.value === 'inline' || (!disposition.value && !filename), bytes: data });
}

function defaultName(type: string, n: number): string {
  if (type === 'message/rfc822') return n > 1 ? `forwarded message ${n}.eml` : 'forwarded message.eml';
  const ext: Record<string, string> = { 'text/plain': 'txt', 'text/html': 'html', 'text/calendar': 'ics', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/heic': 'heic', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'text/csv': 'csv' };
  return `attachment ${n}.${ext[type] ?? 'bin'}`;
}

/** The parts of a multipart body, between its boundary lines. */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let pos = 0;
  let start = -1;
  let closed = false;
  for (;;) {
    const at = body.indexOf(delimiter, pos);
    if (at < 0) break;
    const lineStart = at === 0 || body[at - 1] === 0x0a;
    const after = at + delimiter.length;
    // A boundary line is the delimiter, maybe "--", then only whitespace to the end of the line.
    const closing = body[after] === 0x2d && body[after + 1] === 0x2d;
    let eol = body.indexOf(0x0a, after);
    if (eol < 0) eol = body.length;
    const rest = body.subarray(closing ? after + 2 : after, eol).toString('latin1');
    if (!lineStart || !/^[ \t\r]*$/.test(rest)) {
      pos = after;
      continue;
    }
    if (start >= 0) {
      let end = at;
      if (end > start && body[end - 1] === 0x0a) end--;
      if (end > start && body[end - 1] === 0x0d) end--;
      parts.push(body.subarray(start, end));
    }
    if (closing) {
      closed = true;
      break;
    }
    start = eol + 1;
    pos = start;
    if (parts.length >= MAX_PARTS) {
      closed = true;
      break;
    }
  }
  // No closing boundary (a cut-off message): what's after the last boundary is still a part.
  if (!closed && start >= 0 && start < body.length) parts.push(body.subarray(start));
  return parts;
}

export function decodeTransfer(body: Buffer, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQP(body);
    default:
      return body;
  }
}

export function decodeQP(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let o = 0;
  const hex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c !== 0x3d) {
      out[o++] = c;
      continue;
    }
    if (i + 2 < input.length && hex(input[i + 1]) && hex(input[i + 2])) {
      out[o++] = parseInt(String.fromCharCode(input[i + 1], input[i + 2]), 16);
      i += 2;
      continue;
    }
    // A soft line break: "=", maybe some spaces, then the end of the line.
    let j = i + 1;
    while (j < input.length && (input[j] === 0x20 || input[j] === 0x09)) j++;
    if (input[j] === 0x0d && input[j + 1] === 0x0a) {
      i = j + 1;
      continue;
    }
    if (input[j] === 0x0a) {
      i = j;
      continue;
    }
    if (j >= input.length) break;
    out[o++] = c;
  }
  return out.subarray(0, o);
}

/** Text in a charset, as best it can be read. */
export function decodeBytes(bytes: Buffer, charset?: string): string {
  const cs = (charset ?? 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** Decodes RFC 2047 encoded words ("=?UTF-8?B?…?="); neighbours in the same charset join up first, so a character split between them survives. */
export function decodeWords(value: string): string {
  if (!value.includes('=?')) return value;
  const out: string[] = [];
  let last = 0;
  let pending: { charset: string; bytes: Buffer[] } | undefined;
  const flush = () => {
    if (!pending) return;
    out.push(decodeBytes(Buffer.concat(pending.bytes), pending.charset));
    pending = undefined;
  };
  for (const m of value.matchAll(WORD)) {
    const between = value.slice(last, m.index);
    // Whitespace between two encoded words is not part of the text.
    if (!(pending && /^\s*$/.test(between))) {
      flush();
      out.push(between);
    }
    const charset = m[1].split('*')[0];
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : decodeQP(Buffer.from(m[3].replace(/_/g, ' '), 'latin1'));
    if (pending && pending.charset.toLowerCase() === charset.toLowerCase()) pending.bytes.push(bytes);
    else {
      flush();
      pending = { charset, bytes: [bytes] };
    }
    last = (m.index ?? 0) + m[0].length;
  }
  flush();
  out.push(value.slice(last));
  return out.join('');
}

/** A header's value and its parameters: `text/plain; charset="utf-8"`, with RFC 2231's continued and encoded ones put together. */
export function parseParams(header: string): { value: string; params: Record<string, string> } {
  const pieces = splitOutside(header, ';');
  const value = (pieces.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  const extended: Record<string, { n: number; star: boolean; text: string }[]> = {};
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    const raw = unquote(piece.slice(eq + 1).trim());
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!m) continue;
    if (m[2] === undefined && !m[3]) params[m[1]] = decodeWords(raw);
    else (extended[m[1]] ??= []).push({ n: m[2] === undefined ? 0 : Number(m[2]), star: !!m[3], text: raw });
  }
  for (const [key, list] of Object.entries(extended)) {
    list.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    list.forEach((p, i) => {
      let text = p.text;
      if (p.star && i === 0) {
        const q = /^([^']*)'[^']*'(.*)$/.exec(text);
        if (q) {
          charset = q[1] || 'utf-8';
          text = q[2];
        }
      }
      bytes.push(p.star ? percentDecode(text) : Buffer.from(text, 'utf8'));
    });
    params[key] = decodeBytes(Buffer.concat(bytes), charset);
  }
  return { value, params };
}

function percentDecode(text: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...Buffer.from(text[i], 'utf8'));
  }
  return Buffer.from(out);
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

/** Splits on `sep` where it isn't inside quotes, angle brackets or parentheses. */
function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === sep && !angle && !paren) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** `"Doe, Jane" <jane@x.com>, bob@y.com (Bob)` → who they are. Groups ("team: a@x, b@y;") are opened up. */
export function parseAddressList(value: string): MailAddress[] {
  const out: MailAddress[] = [];
  let text = value.trim();
  // A group: its name and the colon before the addresses, and the semicolon after.
  const group = /^[^"<>@,]*?:(?!\/\/)/.exec(text);
  if (group && !/^[^<]*@/.test(group[0])) text = text.slice(group[0].length).replace(/;\s*$/, '');
  for (const entry of splitOutside(text, ',')) {
    let comment = '';
    const bare = entry.replace(/\(((?:[^()\\]|\\.)*)\)/g, (_, c: string) => {
      comment ||= c.trim();
      return ' ';
    });
    const angle = /<([^<>]*)>/.exec(bare);
    const address = (angle ? angle[1] : bare).trim().replace(/^mailto:/i, '');
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const name = angle ? unquote(bare.slice(0, angle.index).trim()).trim() : comment;
    out.push(name ? { name, address } : { address });
  }
  return out;
}

function isAutomatic(headers: Map<string, string[]>, type: string): boolean {
  const one = (n: string) => (headers.get(n)?.[0] ?? '').trim().toLowerCase();
  const auto = one('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(one('precedence'))) return true;
  if (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  if (type === 'multipart/report') return true;
  const from = (headers.get('from')?.[0] ?? '').toLowerCase();
  if (/\b(mailer-daemon|postmaster)@/.test(from)) return true;
  const returnPath = one('return-path');
  return returnPath === '<>';
}

function authResults(value: string | undefined): AuthResults | undefined {
  if (!value) return undefined;
  const out: AuthResults = {};
  for (const m of value.matchAll(/\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const kind = m[1].toLowerCase() as keyof AuthResults;
    const result = m[2].toLowerCase();
    // Several signatures: one that passes is enough.
    if (!out[kind] || result === 'pass') out[kind] = result;
  }
  return out;
}

/** Whether the receiving server's checks say the sender is who they say (pass), isn't (fail), or can't tell. */
export function senderVerdict(auth: AuthResults | undefined): 'pass' | 'fail' | 'unknown' {
  if (!auth) return 'unknown';
  if (auth.dmarc === 'pass' || auth.dkim === 'pass' || auth.spf === 'pass') return 'pass';
  if (auth.dmarc === 'fail') return 'fail';
  const bad = (r?: string) => r === 'fail' || r === 'softfail' || r === 'permerror';
  if (bad(auth.spf) && (bad(auth.dkim) || !auth.dkim || auth.dkim === 'none')) return 'fail';
  return 'unknown';
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', bull: '•', middot: '·', zwnj: '', zwj: '' };

/** HTML mail as readable text: paragraphs and line breaks kept, links written out. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(https?:[^"']+)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, _q, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    return label && label !== href ? `${label} (${href})` : href;
  });
  // A paragraph gets a blank line round it; a div (a line, the way Gmail writes them) and a list item just a line break.
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|h[1-6]|tr|table|blockquote|section|article|header|footer|ul|ol)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|tr|table|blockquote|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
  return s.replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A reply without what it quotes: the lines starting with ">", and everything from "On … wrote:" (or Outlook's header block) down. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^On\b/i.test(t)) {
      const joined = [t, lines[i + 1]?.trim() ?? '', lines[i + 2]?.trim() ?? ''].join(' ');
      const end = joined.search(/\bwrote:/i);
      if (end >= 0 && end < 300) break;
    }
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t)) break;
    if (/^From:\s/i.test(t) && lines.slice(i + 1, i + 5).some((x) => /^\s*(Sent|Date|To|Subject):\s/i.test(x))) break;
    if (/^Sent from my \w+/i.test(t) || /^Get Outlook for /i.test(t)) break;
    if (/^>/.test(t)) continue;
    if (line === '-- ') break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Writing ------------------------------------------------------------------------------------

export interface OutgoingMail {
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  text: string;
  /** With its angle brackets: <…@…>. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  headers?: [string, string][];
}

/** A plain-text UTF-8 message, ready to send: CRLF line ends, quoted-printable body. */
export function composeMail(m: OutgoingMail): string {
  const lines: string[] = [
    `From: ${formatAddress(m.from)}`,
    fold('To', m.to.map(formatAddress), ', '),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${mailDate(m.date ?? new Date())}`,
    `Message-ID: ${m.messageId}`,
  ];
  if (m.inReplyTo) lines.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references?.length) lines.push(fold('References', m.references, ' '));
  for (const [name, value] of m.headers ?? []) lines.push(`${name}: ${value.replace(/[\r\n]+/g, ' ')}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
  return `${lines.join('\r\n')}\r\n\r\n${encodeQP(m.text)}\r\n`;
}

/** A header whose values go on as many lines as they need: `sep` is ', ' for addresses, ' ' for message ids. */
function fold(name: string, values: string[], sep: ', ' | ' '): string {
  const joiner = sep.trim();
  let out = `${name}: `;
  let line = out.length;
  values.forEach((v, i) => {
    if (i === 0) {
      out += v;
      line += v.length;
      return;
    }
    const piece = `${joiner} ${v}`;
    if (line + piece.length > 76) {
      out += `${joiner}\r\n ${v}`;
      line = 1 + v.length;
    } else {
      out += piece;
      line += piece.length;
    }
  });
  return out;
}

export function formatAddress(a: MailAddress): string {
  if (!a.name) return a.address;
  const name = a.name.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(name)) return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]*$/.test(name) ? `${name} <${a.address}>` : `"${name.replace(/(["\\])/g, '\\$1')}" <${a.address}>`;
  return `${encodeHeader(name)} <${a.address}>`;
}

/** A header's text: as it is when it's plain ASCII, else as UTF-8 encoded words, split so none is over 75 characters. */
export function encodeHeader(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Quoted-printable, lines of at most 76 characters. */
export function encodeQP(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let current = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const token = (b === 0x20 || b === 0x09) && last
        ? `=${b.toString(16).toUpperCase().padStart(2, '0')}`
        : (b >= 33 && b <= 126 && b !== 0x3d) || b === 0x20 || b === 0x09
          ? String.fromCharCode(b)
          : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (current.length + token.length > 75) {
        out.push(`${current}=`);
        current = '';
      }
      current += token;
    }
    out.push(current);
  }
  return out.join('\r\n');
}

/** RFC 5322's date: "Mon, 28 Sep 2026 09:12:33 -0400". */
export function mailDate(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}
