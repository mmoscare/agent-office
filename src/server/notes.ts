import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyNote, checkNotesState, EMPTY_NOTES, isNoteImage, NOTE_IMAGE_MAX_BYTES, noteImageId, type NoteAction, type NotesState } from '../shared/notes.js';

/** Pads kept, at most: one per account, and one for everyone on the shared password. */
const PADS_KEPT = 256;

/** How much room pictures in notes get, and how soon ones no note has are cleared away. */
export interface NoteImageLimits {
  /** A picture no note has (even in Recently deleted) is kept this long, as it may be on its way into one, then cleared away. */
  graceMs: number;
  /** A person's pictures that aren't in a note yet, in bytes, at most: past it, more wait until those are in a note or cleared. */
  waitingMax: number;
  /** All of a person's pictures, in bytes, at most. */
  totalMax: number;
  /** How often everyone's unused pictures are cleared away; 0 for only at start-up, on adding one and on a note going for good. */
  sweepMs: number;
}
export const NOTE_IMAGE_LIMITS: NoteImageLimits = { graceMs: 10 * 60_000, waitingMax: 100 * 1024 * 1024, totalMax: 2 * 1024 * 1024 * 1024, sweepMs: 10 * 60_000 };

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/** What kind of picture these bytes are, of the ones a note can have. SVG isn't one: it can carry script. */
export function noteImageType(b: Buffer): string | undefined {
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString('latin1') === s;
  if (at(0, '\x89PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  return undefined;
}

export const NOTE_IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * Everyone's own 📝 Notes pad (see shared/notes.ts): one per person for the whole building, saved in
 * the office's .agent-office/notes.json, with their pictures in .agent-office/notes-images, a folder
 * each. A person is their account, or everyone on the shared password together, as for the To Do board.
 */
export class Notes {
  private pads = new Map<string, NotesState>();
  private file: string;
  private imagesDir: string;
  private limits: NoteImageLimits;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(dataDir: string, limits: Partial<NoteImageLimits> = {}) {
    this.file = path.join(dataDir, 'notes.json');
    this.imagesDir = path.join(dataDir, 'notes-images');
    this.limits = { ...NOTE_IMAGE_LIMITS, ...limits };
    this.load();
    this.sweep();
    if (this.limits.sweepMs > 0) {
      this.sweeper = setInterval(() => this.sweep(), this.limits.sweepMs);
      this.sweeper.unref?.();
    }
  }

  /** Stops clearing away unused pictures on the clock. */
  close() {
    clearInterval(this.sweeper);
  }

  /** Clears away the pictures no note has that are past the grace period, for everyone (and for folders nobody's pad owns any more). */
  sweep() {
    let dirs: string[];
    try {
      dirs = readdirSync(this.imagesDir);
    } catch {
      return; // no pictures yet
    }
    const owners = new Map([...this.pads.keys()].map((owner) => [this.dirName(owner), owner]));
    for (const dir of dirs) {
      const owner = owners.get(dir);
      this.pruneDir(path.join(this.imagesDir, dir), new Set(owner ? this.pad(owner).notes.flatMap((n) => n.images) : []));
    }
  }

  /** `owner`'s pad. */
  pad(owner: string): NotesState {
    return this.pads.get(owner) ?? EMPTY_NOTES;
  }

  /** `owner`'s pad after `a` at `now`, saved; null when it changed nothing. */
  apply(owner: string, a: NoteAction, now = Date.now()): NotesState | null {
    const was = this.pad(owner);
    if (!this.pads.has(owner) && this.pads.size >= PADS_KEPT) return null;
    const next = applyNote(was, a, now);
    if (next === was) return null;
    this.pads.set(owner, next);
    this.save();
    // Pictures in notes gone for good go with them (but not one just added, on its way into a note).
    if (next.notes.length < was.notes.length) this.pruneImages(owner);
    return next;
  }

  /** Keeps a picture for `owner`'s notes; its name to put in a note, or what's wrong with it (and the HTTP status to say so with). */
  addImage(owner: string, body: unknown): { id: string } | { error: string; status?: number } {
    const dataURL = body && typeof body === 'object' ? (body as { dataURL?: unknown }).dataURL : undefined;
    const m = typeof dataURL === 'string' ? /^data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataURL) : null;
    if (!m) return { error: 'That isn’t a picture' };
    const bytes = Buffer.from(m[1], 'base64');
    if (!bytes.length) return { error: 'That isn’t a picture' };
    if (bytes.length > NOTE_IMAGE_MAX_BYTES) return { error: `That picture is too big for a note (${Math.round(NOTE_IMAGE_MAX_BYTES / 1024 / 1024)} MB at most)` };
    const type = noteImageType(bytes);
    const id = type && noteImageId(createHash('sha256').update(bytes).digest('hex'), type);
    if (!id) return { error: 'Only PNG, JPEG, GIF and WebP pictures can go in a note' };
    const dir = this.dirOf(owner);
    const file = path.join(dir, id);
    try {
      if (existsSync(file)) {
        // Kept already: fresh again, so it isn't cleared away before it's back in a note.
        const now = new Date();
        utimesSync(file, now, now);
        return { id };
      }
      // Room for it: unused pictures past the grace period go first, then the limits.
      this.pruneImages(owner);
      const { total, waiting } = this.usage(owner);
      if (waiting + bytes.length > this.limits.waitingMax) {
        return { status: 429, error: `A lot of pictures (${size(waiting)}) were added in the last few minutes without going into a note. Wait a few minutes and try again.` };
      }
      if (total + bytes.length > this.limits.totalMax) {
        return { status: 507, error: `Your notes already hold ${size(total)} of pictures, as much as they can (${size(this.limits.totalMax)}). Delete notes with pictures you don't need, and empty Recently deleted, to make room.` };
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(`agent-office: couldn't save a picture for notes: ${(err as Error).message}`);
      return { error: 'The office couldn’t save that picture' };
    }
    return { id };
  }

  /** Where `owner`'s picture `id` is on disk, if they have one by that name. */
  imagePath(owner: string, id: string): string | null {
    if (!isNoteImage(id)) return null;
    const file = path.join(this.dirOf(owner), id);
    return existsSync(file) ? file : null;
  }

  /** `owner`'s own folder of pictures, named by a hash so no account name ends up in a path. */
  private dirOf(owner: string): string {
    return path.join(this.imagesDir, this.dirName(owner));
  }

  private dirName(owner: string): string {
    return createHash('sha256').update(owner).digest('hex').slice(0, 24);
  }

  /** The bytes of `owner`'s pictures: all of them, and the ones no note has. */
  private usage(owner: string): { total: number; waiting: number } {
    const dir = this.dirOf(owner);
    const used = new Set(this.pad(owner).notes.flatMap((n) => n.images));
    let total = 0;
    let waiting = 0;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // none yet
    }
    for (const name of names) {
      let bytes = 0;
      try {
        bytes = statSync(path.join(dir, name)).size;
      } catch {
        continue;
      }
      total += bytes;
      if (!used.has(name)) waiting += bytes;
    }
    return { total, waiting };
  }

  /** Clears away `owner`'s pictures that no note has (even in Recently deleted), once they're past the grace period. */
  private pruneImages(owner: string) {
    this.pruneDir(this.dirOf(owner), new Set(this.pad(owner).notes.flatMap((n) => n.images)));
  }

  private pruneDir(dir: string, used: Set<string>) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (used.has(name)) continue;
      const file = path.join(dir, name);
      try {
        if (now - statSync(file).mtimeMs >= this.limits.graceMs) unlinkSync(file);
      } catch {
        // gone already, or busy: next time
      }
    }
  }

  private load() {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // none yet, or a broken file: start with empty pads
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [owner, raw] of Object.entries(saved as Record<string, unknown>).slice(0, PADS_KEPT)) this.pads.set(owner, checkNotesState(raw));
  }

  private save() {
    try {
      // Written aside and moved into place, so a crash mid-write can't leave half a pad.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.pads)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}
