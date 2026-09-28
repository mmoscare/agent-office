// The 📥 in-tray: a folder per floor (.agent-office/inbox/) the office watches, and the door outside
// people and tools drop things in through (POST /api/inbox, see server.ts). Notes written in the office
// or sent in through the door are markdown files; anything else (a voice memo, a PDF, a photo) is a
// file dropped in the folder or sent in through the door. Dealt-with items go to inbox/archive/.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { INBOX_FILE_MAX, INBOX_LIMIT, INBOX_NOTE_MAX, INBOX_PREVIEW_MAX, isNoteName, noteFile, parseNote, type InboxItem, type InboxState } from '../shared/inbox.js';

export class InboxError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const SCAN_MS = 3000;
const ARCHIVE = 'archive';
/** A tray file's name, extension included. */
const NAME_MAX = 120;
/** How much of a note the tray reads for its card. */
const HEAD_BYTES = 8 * 1024;
/** How much of a note is shown or handed to a worker at once. */
const READ_MAX = 1024 * 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface InboxEvents {
  update(state: InboxState): void;
  /** Whether the in-tray door is open (an admin made a token for it). */
  door(): boolean;
}

/** One floor's in-tray: the files in its inbox folder, watched a few times a minute. */
export class Inbox {
  readonly dir: string;
  private items: InboxItem[] = [];
  private revision = 0;
  private signature = '';
  private timer: NodeJS.Timeout;
  /** The scan under way, so a scan asked for meanwhile waits for it (and it goes round again). */
  private running?: Promise<void>;
  private again = false;

  constructor(dataDir: string, private events: InboxEvents) {
    this.dir = path.join(dataDir, 'inbox');
    mkdirSync(path.join(this.dir, ARCHIVE), { recursive: true, mode: 0o700 });
    void this.scan();
    this.timer = setInterval(() => void this.scan(), SCAN_MS);
  }

  state(): InboxState {
    return { revision: this.revision, items: this.items.map((i) => ({ ...i })), dir: this.dir, door: this.events.door() };
  }

  /** The tray's items, newest first. */
  list(): InboxItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  find(name: string): InboxItem | undefined {
    return this.items.find((i) => i.name === name);
  }

  /** Looks at the folder now; tells the floor when something changed. Settles once the folder has been looked at. */
  scan(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.scanOnce();
        } while (this.again);
      } catch (err) {
        console.error('in-tray scan failed:', err);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async scanOnce() {
    let listing: string[];
    try {
      listing = await readdir(this.dir);
    } catch (err) {
      // The folder was taken away (or isn't there yet): an empty tray, made again when something is put in it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      listing = [];
    }
    const names = listing.filter((n) => !n.startsWith('.') && n !== ARCHIVE).sort();
    const found: { name: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      try {
        const s = await stat(path.join(this.dir, name));
        if (s.isFile()) found.push({ name, size: s.size, mtime: s.mtimeMs });
      } catch {
        // gone between readdir and stat: not in the tray
      }
    }
    const signature = found.map((f) => `${f.name}:${f.size}:${Math.round(f.mtime)}`).join('|');
    if (signature === this.signature) return;
    const known = new Map(this.items.map((i) => [`${i.name}:${i.size}:${Math.round(i.mtime)}`, i]));
    const items: InboxItem[] = [];
    for (const f of found) {
      const same = known.get(`${f.name}:${f.size}:${Math.round(f.mtime)}`);
      items.push(same ?? (await this.describe(f)));
    }
    items.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    this.items = items;
    this.signature = signature;
    this.revision++;
    this.events.update(this.state());
  }

  /** What a tray file is, for its card: a note's title, sender and preview, or just the file. */
  private async describe(f: { name: string; size: number; mtime: number }): Promise<InboxItem> {
    const item: InboxItem = { name: f.name, kind: isNoteName(f.name) ? 'note' : 'file', size: f.size, mtime: f.mtime, title: f.name };
    if (item.kind !== 'note') return item;
    try {
      const fh = await open(path.join(this.dir, f.name), 'r');
      try {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, f.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const note = parseNote(f.name, buf.subarray(0, bytesRead).toString('utf8'));
        item.title = note.title;
        if (note.from) item.from = note.from;
        const preview = note.body.replace(/\s+/g, ' ').trim();
        if (preview && preview !== item.title) item.preview = preview.length > INBOX_PREVIEW_MAX ? `${preview.slice(0, INBOX_PREVIEW_MAX - 1)}…` : preview;
      } finally {
        await fh.close();
      }
    } catch {
      // unreadable right now (being written?): the card shows the name until the next scan
    }
    return item;
  }

  /** A note written in the office or sent in through the door. Returns its file name. */
  note(title: string, text: string, from?: string): string {
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body && !title.trim()) throw new InboxError('The note is empty.');
    if (body.length > INBOX_NOTE_MAX) throw new InboxError(`Keep a note under ${Math.floor(INBOX_NOTE_MAX / 1024)} KB; send a longer one as a file.`);
    this.room();
    this.ensure();
    const name = this.freeName(`${stamp()}-${slug(title.trim() || body)}.md`);
    writeFileSync(path.join(this.dir, name), noteFile(title.slice(0, 200), body, from?.slice(0, 200)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    void this.scan();
    return name;
  }

  /** A file sent in through the door. Returns its file name in the tray. */
  file(name: string, bytes: Buffer): string {
    if (bytes.length > INBOX_FILE_MAX) throw new InboxError(`That file is too big for the tray (over ${Math.floor(INBOX_FILE_MAX / 1024 / 1024)} MB).`, 413);
    if (!bytes.length) throw new InboxError('The file is empty.');
    this.room();
    this.ensure();
    const clean = this.freeName(safeName(name));
    writeFileSync(path.join(this.dir, clean), bytes, { mode: 0o600, flag: 'wx' });
    void this.scan();
    return clean;
  }

  /** Where a tray item is (`archived`: where it went). Refuses names that aren't plain file names. */
  pathOf(name: string, archived = false): string {
    if (!plainName(name)) throw new InboxError('That is not a file in the tray.', 404);
    return path.join(this.dir, ...(archived ? [ARCHIVE, name] : [name]));
  }

  /** A tray item, with a note's text (up to a limit) or, for a file, just where it is. */
  async read(name: string): Promise<{ item: InboxItem; body?: string; truncated?: boolean; path: string }> {
    const item = this.find(name);
    if (!item) throw new InboxError('That is not in the tray (any more).', 404);
    const file = this.pathOf(name);
    if (item.kind !== 'note') return { item, path: file };
    try {
      const fh = await open(file, 'r');
      try {
        const size = (await fh.stat()).size;
        const buf = Buffer.alloc(Math.min(READ_MAX, size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const note = parseNote(name, buf.subarray(0, bytesRead).toString('utf8'));
        return { item, body: note.body, truncated: size > READ_MAX || undefined, path: file };
      } finally {
        await fh.close();
      }
    } catch (err) {
      if (err instanceof InboxError) throw err;
      throw new InboxError('That note could not be read.', 500);
    }
  }

  /** Moves a dealt-with item into archive/, and returns where it went. */
  archive(name: string): string {
    const from = this.pathOf(name);
    if (!this.find(name) && !existsSync(from)) throw new InboxError('That is not in the tray (any more).', 404);
    this.ensure();
    const to = path.join(this.dir, ARCHIVE, this.freeName(name, path.join(this.dir, ARCHIVE)));
    try {
      renameSync(from, to);
    } catch {
      throw new InboxError('That item could not be moved to the archive.', 500);
    }
    void this.scan();
    return to;
  }

  shutdown() {
    clearInterval(this.timer);
  }

  private room() {
    if (this.items.length >= INBOX_LIMIT) throw new InboxError(`The tray is full (${INBOX_LIMIT} items): triage or archive some first.`, 409);
  }

  /** The tray and its archive folder, made again if someone tidied them away. */
  private ensure() {
    mkdirSync(path.join(this.dir, ARCHIVE), { recursive: true, mode: 0o700 });
  }

  /** `name`, or `name (2)`, `name (3)`… when that's taken in `dir`. */
  private freeName(name: string, dir = this.dir): string {
    if (!existsSync(path.join(dir, name))) return name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (!existsSync(path.join(dir, candidate))) return candidate;
    }
  }
}

/** Something a file in the tray may be called: one plain name, nothing hidden, no path. */
export function plainName(name: unknown): name is string {
  return typeof name === 'string' && !!name && name.length <= NAME_MAX + 8 && !name.startsWith('.') && !/[\\/\0]/.test(name) && name !== ARCHIVE && !/[\x00-\x1f]/.test(name);
}

/** A file name from outside, made safe to write into the tray: its base name, cleaned up and cut down. */
export function safeName(input: string): string {
  const base = String(input ?? '').split(/[\\/]/).pop() ?? '';
  let name = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\w .()\[\]\-]/g, '-').replace(/-+/g, '-').replace(/^[\s.\-]+|[\s.]+$/g, '');
  if (!name) name = `file-${stamp()}`;
  const dot = name.lastIndexOf('.');
  let [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, ''];
  if (ext.length > 12) { stem = name; ext = ''; }
  if (WINDOWS_RESERVED.test(stem)) stem = `file-${stem}`;
  if (stem.length + ext.length > NAME_MAX) stem = stem.slice(0, NAME_MAX - ext.length).replace(/[\s.\-]+$/, '');
  return `${stem}${ext}`;
}

/** Local time, sortable: 20260928-091233. */
function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'note';
}

// ---- The door -----------------------------------------------------------------------------------

/** How many requests an address may make through the door a minute, and how many wrong tokens before it's shut on them for a while. */
const DOOR_PER_MINUTE = 30;
const DOOR_BAD_TOKENS = 10;
const DOOR_BAD_WINDOW_MS = 10 * 60_000;

/**
 * The in-tray door: POST /api/inbox from outside the office (a phone shortcut, a mail rule, a script),
 * let in by a token an admin makes in the In-tray window. Only its hash is kept, in the office's
 * intray.json, so the token shows once. A door with no token is closed.
 */
export class InTrayDoor {
  private file: string;
  private hash?: Buffer;
  private createdAt?: number;
  private by?: string;
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'intray.json');
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { hash?: string; createdAt?: number; by?: string };
      if (typeof saved.hash === 'string' && /^[0-9a-f]{64}$/.test(saved.hash)) {
        this.hash = Buffer.from(saved.hash, 'hex');
        this.createdAt = Number.isFinite(saved.createdAt) ? saved.createdAt : undefined;
        this.by = typeof saved.by === 'string' ? saved.by : undefined;
      }
    } catch {
      // no door yet
    }
  }

  get open(): boolean {
    return !!this.hash;
  }

  info(): { open: boolean; createdAt?: number; by?: string } {
    return { open: this.open, createdAt: this.createdAt, by: this.by };
  }

  /** A new token, which replaces any old one. Returned once, never shown again. */
  generate(by: string): string {
    const token = randomBytes(24).toString('base64url');
    this.hash = digest(token);
    this.createdAt = Date.now();
    this.by = by;
    this.persist();
    return token;
  }

  /** Shuts the door: the token stops working. */
  close() {
    this.hash = undefined;
    this.createdAt = undefined;
    this.by = undefined;
    this.persist();
  }

  /** Whether the token opens the door (a closed door opens for nobody). */
  check(token: unknown): boolean {
    if (!this.hash || typeof token !== 'string' || !token) return false;
    return timingSafeEqual(digest(token), this.hash);
  }

  /** Counts a request from an address; false once it's made too many this minute. */
  allow(ip: string): boolean {
    return this.count(`ip:${ip}`, DOOR_PER_MINUTE, 60_000);
  }

  /** Counts a wrong token from an address; false once there have been too many lately. */
  allowBadToken(ip: string): boolean {
    return this.count(`bad:${ip}`, DOOR_BAD_TOKENS, DOOR_BAD_WINDOW_MS);
  }

  private count(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
    const rec = this.hits.get(key);
    if (!rec || rec.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    rec.count++;
    return rec.count <= limit;
  }

  private persist() {
    try {
      if (!this.hash) writeFileSync(this.file, '{}\n', { mode: 0o600 });
      else writeFileSync(this.file, JSON.stringify({ hash: this.hash.toString('hex'), createdAt: this.createdAt, by: this.by }, null, 2) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('in-tray door could not be saved:', err);
    }
  }
}

function digest(token: string): Buffer {
  return createHash('sha256').update('agent-office in-tray:').update(token).digest();
}

/** How big a tray file the office serves to the browser (/api/inbox/file); bigger ones are opened from the folder. */
export const INBOX_SERVE_MAX = 25 * 1024 * 1024;
const TYPES: Record<string, string> = {
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
};
/** What a tray file is served as, and whether the browser may show it in a tab rather than save it. */
export function fileType(name: string): { type: string; inline: boolean } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const type = TYPES[ext] ?? 'application/octet-stream';
  return { type, inline: type !== 'application/octet-stream' };
}

/** Reads a whole request body as bytes, up to a limit (413 past it). */
export function readBytes(req: NodeJS.ReadableStream & { destroy?: () => void }, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new InboxError('too large', 413));
        req.destroy?.();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
