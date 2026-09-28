import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isPlanStatus, PLAN_LIMIT, PLAN_TEXT_MAX, type Plan, type PlanAction, type PlansState } from '../shared/plans.js';
import type { WorkerInfo } from '../shared/protocol.js';

export class PlansError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const validText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= PLAN_TEXT_MAX;

/** How a plan's queue task ended (see queue.ts). */
export type PlanOutcome = 'done' | 'exited' | 'killed' | 'failed';

/**
 * The floor's 📒 To Do Next board: the people's own list of what they want done here, in To Do,
 * Progress and Finished, kept in the floor's .agent-office/plans.json. People change it from the
 * binder (with a revision, so two windows don't overwrite each other); the board agents change it
 * with office-plans; and the office moves an item along by itself once a worker is handed it, at a
 * desk or from the 📋 queue: to Progress when the worker starts, to Finished when it finishes its turn.
 */
export class Plans {
  private file: string;
  /** The board as last read or saved, for the worker updates (which are many, and rarely matter). */
  private cached?: PlansState;

  constructor(dataDir: string, private onChange?: (state: PlansState) => void) { this.file = path.join(dataDir, 'plans.json'); }

  read(): PlansState {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.cached = { revision: 0, items: [] });
      throw new PlansError('The binder could not be read. Your saved plans have not been changed.', 500);
    }
    try {
      const s = JSON.parse(raw);
      if (!s || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.items) || s.items.length > PLAN_LIMIT ||
        s.items.some((p: any) => !p || typeof p.id !== 'string' || !p.id || !validText(p.text) || !isPlanStatus(p.status)) ||
        new Set(s.items.map((p: any) => p.id)).size !== s.items.length) throw new Error('Invalid plans');
      // The links the office keeps are optional, and a malformed one is dropped rather than refused.
      const items: Plan[] = s.items.map((p: any) => {
        const plan: Plan = { id: p.id, text: p.text, status: p.status };
        if (typeof p.task === 'string' && p.task) plan.task = p.task;
        if (p.worker && typeof p.worker === 'object' && typeof p.worker.id === 'string' && typeof p.worker.name === 'string') plan.worker = { id: p.worker.id, name: p.worker.name };
        if (Number.isFinite(p.finishedAt)) plan.finishedAt = p.finishedAt;
        return plan;
      });
      return (this.cached = { revision: s.revision, items });
    } catch { throw new PlansError('The saved binder needs repair. Your plans file has been left untouched.', 500); }
  }

  /** The board for the floor view: as it stands, or empty when it can't be read (the binder window says why). */
  state(): PlansState {
    try { return this.read(); }
    catch { return { revision: 0, items: [] }; }
  }

  /** A change from the binder window: refused when the window's copy is out of date. */
  change(input: unknown): PlansState {
    if (!input || typeof input !== 'object') throw new PlansError('Choose a plan action.');
    const v = input as Record<string, unknown>;
    const s = this.read();
    if (v.revision !== s.revision) throw new PlansError('This binder changed in another window. Refresh it before saving again.', 409);
    this.perform(s, v);
    return this.save(s);
  }

  /** A change by a board agent (office-plans) or the office itself: made to the board as it is now. */
  apply(action: PlanAction): PlansState {
    const s = this.read();
    this.perform(s, action as unknown as Record<string, unknown>);
    return this.save(s);
  }

  /** A worker was handed the plan, at a desk or by the queue (`task`): it's in progress, and the plan says by whom. */
  start(id: string, worker: { id: string; name: string }, task?: string): boolean {
    let s: PlansState;
    try { s = this.read(); } catch { return false; }
    const plan = s.items.find((p) => p.id === id);
    if (!plan) return false;
    plan.status = 'progress';
    plan.worker = { id: worker.id, name: worker.name };
    if (task) plan.task = task;
    else delete plan.task;
    delete plan.finishedAt;
    this.save(s);
    return true;
  }

  /**
   * The plan's queue task ended: finished when its worker got it done; back to To Do when it never
   * started; otherwise it stays in Progress, without its worker, for someone to requeue.
   */
  end(id: string, outcome: PlanOutcome): void {
    let s: PlansState;
    try { s = this.read(); } catch { return; }
    const plan = s.items.find((p) => p.id === id);
    if (!plan) return;
    if (outcome === 'done') {
      if (plan.status !== 'finished') plan.finishedAt = Date.now();
      plan.status = 'finished';
    } else if (outcome === 'failed') {
      plan.status = 'todo';
      delete plan.worker;
      delete plan.task;
    } else delete plan.worker;
    this.save(s);
  }

  /** A worker changed: the plans a worker is on are finished when it finishes its turn. */
  onWorker(w: WorkerInfo): void {
    if (w.status !== 'done') return;
    const cached = this.cached ?? this.state();
    if (!cached.items.some((p) => p.worker?.id === w.id && p.status === 'progress')) return;
    let s: PlansState;
    try { s = this.read(); } catch { return; }
    let changed = false;
    for (const p of s.items) {
      if (p.worker?.id !== w.id || p.status !== 'progress') continue;
      p.status = 'finished';
      p.finishedAt = Date.now();
      changed = true;
    }
    if (changed) this.save(s);
  }

  /** A worker went home: the plans it was on no longer say so (whatever column they're in). */
  onWorkerGone(workerId: string): void {
    const cached = this.cached ?? this.state();
    if (!cached.items.some((p) => p.worker?.id === workerId)) return;
    let s: PlansState;
    try { s = this.read(); } catch { return; }
    let changed = false;
    for (const p of s.items) {
      if (p.worker?.id !== workerId) continue;
      delete p.worker;
      changed = true;
    }
    if (changed) this.save(s);
  }

  private perform(s: PlansState, v: Record<string, unknown>) {
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
          const plan = s.items[index];
          if (v.status !== plan.status) {
            plan.status = v.status;
            // Back to To Do is a fresh start: whoever was on it, and whatever task, are forgotten.
            if (v.status === 'todo') { delete plan.worker; delete plan.task; delete plan.finishedAt; }
            if (v.status === 'finished') plan.finishedAt = Date.now();
          }
        }
      }
    } else throw new PlansError('Unknown plan action.');
  }

  private save(s: PlansState): PlansState {
    s.revision++;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } catch {
      throw new PlansError('Your change was not saved. Check that this floor’s folder is writable, then try again.', 500);
    } finally { try { unlinkSync(temp); } catch { /* Renamed, or never created. */ } }
    this.cached = s;
    try { this.onChange?.(s); } catch { /* a listener's trouble is its own */ }
    return s;
  }
}
