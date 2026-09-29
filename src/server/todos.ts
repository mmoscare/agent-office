import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyTodo, checkTodoItem, TODO_LIMIT, type TodoAction, type TodoItem } from '../shared/todos.js';

/** Lists kept, at most: one per account, and one for everyone on the shared password. */
const LISTS_KEPT = 256;

/**
 * Everyone's own 🔥 To Do board (see shared/todos.ts): one list per person for the whole building, so
 * it's the same on every floor, saved in the office's .agent-office/todos.json. A person is their
 * account, or everyone on the shared password together (they're the office's own people).
 */
export class Todos {
  private lists = new Map<string, readonly TodoItem[]>();
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'todos.json');
    this.load();
  }

  /** `owner`'s list, in order. */
  list(owner: string): readonly TodoItem[] {
    return this.lists.get(owner) ?? [];
  }

  /** `owner`'s list after `a`, saved; null when it changed nothing. */
  apply(owner: string, a: TodoAction): readonly TodoItem[] | null {
    const was = this.list(owner);
    if (!this.lists.has(owner) && this.lists.size >= LISTS_KEPT) return null;
    const next = applyTodo(was, a);
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
      return; // none yet, or a broken file: start with empty lists
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [owner, raw] of Object.entries(saved as Record<string, unknown>).slice(0, LISTS_KEPT)) {
      if (!Array.isArray(raw)) continue;
      const seen = new Set<string>();
      const items: TodoItem[] = [];
      for (const r of raw.slice(0, TODO_LIMIT)) {
        const t = checkTodoItem(r);
        if (t && !seen.has(t.id)) seen.add(t.id), items.push(t);
      }
      this.lists.set(owner, items);
    }
  }

  private save() {
    try {
      // Written aside and moved into place, so a crash mid-write can't leave half a list.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.lists), null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`agent-office: couldn't save ${this.file}: ${(err as Error).message}`);
    }
  }
}
