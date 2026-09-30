import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyContent, checkContentItem, CONTENT_LIMIT, type ContentAction, type ContentItem } from '../shared/content-kanban.js';

/**
 * A floor's 🎬 Content Kanban (see shared/content-kanban.ts): one board everyone on the floor
 * shares, saved in the floor's .agent-office/content-kanban.json.
 */
export class ContentKanban {
  private items: readonly ContentItem[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'content-kanban.json');
    this.load();
  }

  /** Every card, in order. */
  list(): readonly ContentItem[] {
    return this.items;
  }

  /** The board after `a` by `by`, saved; null when it changed nothing. */
  apply(a: ContentAction, by?: string): readonly ContentItem[] | null {
    const next = applyContent(this.items, a, Date.now(), by);
    if (next === this.items) return null;
    this.items = next;
    this.save();
    return next;
  }

  private load() {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // none yet, or a broken file: start with an empty board
    }
    if (!Array.isArray(saved)) return;
    const seen = new Set<string>();
    const items: ContentItem[] = [];
    for (const raw of saved.slice(0, CONTENT_LIMIT)) {
      const t = checkContentItem(raw);
      if (t && !seen.has(t.id)) seen.add(t.id), items.push(t);
    }
    this.items = items;
  }

  private save() {
    try {
      // Written aside and moved into place, so a crash mid-write can't leave half a board.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}
