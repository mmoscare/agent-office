import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TODO_IMAGE_RE } from '../shared/todos.js';

/** One picture on a kanban card, as a data: URL (the browser shrinks big ones before sending). */
export const TODO_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
type Ext = keyof typeof TYPES;

/** What the file's first bytes say it is, whatever it claims. */
function sniff(b: Buffer): Ext | undefined {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

/**
 * The pictures on kanban cards (see shared/todos.ts), kept in .agent-office/todo-images. Each is
 * named by a hash of what's in it, so the same picture twice is one file and a name never changes.
 */
export class TodoImages {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'todo-images');
  }

  /** Keeps a picture; its name, or why it can't. */
  add(raw: unknown): { id: string } | { error: string } {
    const dataURL = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).dataURL : undefined;
    const m = typeof dataURL === 'string' ? /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataURL) : null;
    if (!m) return { error: 'Cards take pictures (PNG, JPEG, GIF or WebP)' };
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length > TODO_IMAGE_MAX_BYTES) return { error: `That picture is too big (over ${TODO_IMAGE_MAX_BYTES / 1024 / 1024} MB)` };
    const ext = sniff(bytes);
    if (!ext) return { error: 'Cards take pictures (PNG, JPEG, GIF or WebP)' };
    return this.save(bytes, ext);
  }

  /** Keeps `bytes` as a picture of type `ext`; its name. */
  save(bytes: Buffer, ext: Ext): { id: string } | { error: string } {
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(this.dir, id), bytes, { mode: 0o600 });
    } catch {
      return { error: "Couldn't save the picture on the office's machine" };
    }
    return { id };
  }

  /** A picture, if there is one by that name. */
  get(id: string): { type: string; body: Buffer } | undefined {
    if (!TODO_IMAGE_RE.test(id)) return undefined;
    try {
      return { type: TYPES[id.split('.')[1] as Ext], body: readFileSync(path.join(this.dir, id)) };
    } catch {
      return undefined;
    }
  }
}
