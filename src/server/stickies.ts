import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applySticky, checkStickyItem, presetStickies, STICKY_LIMIT, type StickyAction, type StickyNote } from '../shared/stickies.js';

/**
 * Lists kept, at most: one per account, and one for everyone on the shared password. Past it, the
 * list seen longest ago goes, so someone new always gets theirs.
 */
export const STICKY_LISTS_KEPT = 256;

/**
 * Everyone's reminder stickies (see shared/stickies.ts): one list per person for the whole building,
 * so the same notes are on every floor, saved in the office's .agent-office/stickies.json. A person
 * is their account, or everyone on the shared password together. A list that isn't saved yet starts
 * with the four reminders; an empty saved list stays empty (they took them all down). The lists are
 * kept in the order they were last seen, oldest first, on disk too.
 */
export class Stickies {
  private lists = new Map<string, readonly StickyNote[]>();
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'stickies.json');
    this.load();
  }

  /** `owner`'s list. The first time they're seen, the four reminders go up and are saved. */
  list(owner: string): readonly StickyNote[] {
    const had = this.lists.get(owner);
    if (had) {
      // Seen just now: to the back of the line.
      this.lists.delete(owner);
      this.lists.set(owner, had);
      return had;
    }
    const seeded = presetStickies();
    this.lists.set(owner, seeded);
    // Full: let go of whoever has gone longest unseen (a revoked account, most likely), not the newcomer.
    for (const old of this.lists.keys()) {
      if (this.lists.size <= STICKY_LISTS_KEPT) break;
      this.lists.delete(old);
    }
    this.save();
    return seeded;
  }

  /** `owner`'s list after `a`, saved; null when it changed nothing. */
  apply(owner: string, a: StickyAction): readonly StickyNote[] | null {
    const was = this.list(owner);
    const next = applySticky(was, a);
    if (next === was) return null;
    this.lists.set(owner, next);
    this.save();
    return next;
  }

  private load() {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    // The file is oldest first, so an overfull one keeps its most recently seen lists.
    for (const [owner, raw] of Object.entries(saved as Record<string, unknown>).slice(-STICKY_LISTS_KEPT)) {
      if (!Array.isArray(raw)) continue;
      const seen = new Set<string>();
      const items: StickyNote[] = [];
      for (const r of raw.slice(0, STICKY_LIMIT)) {
        const t = checkStickyItem(r);
        if (t && !seen.has(t.id)) seen.add(t.id), items.push(t);
      }
      // Even an empty list is remembered, so taking every note down doesn't put the presets back.
      this.lists.set(owner, items);
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.lists), null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}
