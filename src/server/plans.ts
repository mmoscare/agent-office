import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isPlanStatus, PLAN_LIMIT, PLAN_TEXT_MAX, type PlansState } from '../shared/plans.js';

export class PlansError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= PLAN_TEXT_MAX;

/** Human plans only: no queue, worker or GitHub side effects. Each floor owns one file. */
export class Plans {
  private file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'plans.json'); }

  read(): PlansState {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, items: [] };
      throw new PlansError('The binder could not be read. Your saved plans have not been changed.', 500);
    }
    try {
      const s = JSON.parse(raw);
      if (!s || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.items) || s.items.length > PLAN_LIMIT ||
        s.items.some((p: any) => !p || typeof p.id !== 'string' || !p.id || !validText(p.text) || !isPlanStatus(p.status)) ||
        new Set(s.items.map((p: any) => p.id)).size !== s.items.length) throw new Error('Invalid plans');
      return s;
    } catch { throw new PlansError('The saved binder needs repair. Your plans file has been left untouched.', 500); }
  }

  change(input: unknown): PlansState {
    if (!input || typeof input !== 'object') throw new PlansError('Choose a plan action.');
    const v = input as Record<string, unknown>;
    const s = this.read();
    if (v.revision !== s.revision) throw new PlansError('This binder changed in another window. Refresh it before saving again.', 409);
    if (v.action === 'add') {
      if (!validText(v.text)) throw new PlansError(`Enter a plan of 1–${PLAN_TEXT_MAX} characters.`);
      if (s.items.length >= PLAN_LIMIT) throw new PlansError('This binder is full. Remove an old plan first.');
      s.items.push({ id: randomUUID(), text: v.text.trim(), status: 'todo' });
    } else if (v.action === 'edit' || v.action === 'remove') {
      const index = s.items.findIndex(p => p.id === v.id);
      if (index < 0) throw new PlansError('That plan no longer exists.', 404);
      if (v.action === 'remove') s.items.splice(index, 1);
      else {
        if (v.text === undefined && v.status === undefined) throw new PlansError('Choose a change.');
        if (v.text !== undefined) {
          if (!validText(v.text)) throw new PlansError(`Enter a plan of 1–${PLAN_TEXT_MAX} characters.`);
          s.items[index].text = v.text.trim();
        }
        if (v.status !== undefined) {
          if (!isPlanStatus(v.status)) throw new PlansError('Choose To Do, Progress or Finished.');
          s.items[index].status = v.status;
        }
      }
    } else throw new PlansError('Unknown plan action.');
    s.revision++;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } catch {
      throw new PlansError('Your change was not saved. Check that this floor’s folder is writable, then try again.', 500);
    } finally { try { unlinkSync(temp); } catch { /* Renamed, or never created. */ } }
    return s;
  }
}
