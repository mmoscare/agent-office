import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TIMECARD_GRACE_MS, TIMECARD_KEEP_MS, type TimeCardState, type TimeStint } from '../shared/timecard.js';

interface Person { name: string; stints: TimeStint[] }

/** Whose card a connection clocks: an account's own, or on the shared password, the name they came in as. */
export function timeCardKey(accountId: string | undefined, name: string): string {
  return accountId ? `account:${accountId}` : `name:${name.trim().toLowerCase()}`;
}

/**
 * The office's 🗂️ Indirect Time cards, in <office>/.agent-office/timecard.json: when each person had
 * the office open in a browser. Their first window clocks them in and their last one closing clocks
 * them out, whichever floor they're on. While they're in, the stint's end is moved up on each tick,
 * so a crash ends it where the office last saw them rather than leaving it open forever.
 */
export class TimeCard {
  private people = new Map<string, Person>();
  /** Windows open now, per person. */
  private windows = new Map<string, number>();
  private file: string;
  private loadFailed = false;
  saveError?: string;

  constructor(dataDir: string, private now: () => number = Date.now) {
    this.file = path.join(dataDir, 'timecard.json');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (saved?.version !== 1 || !saved.people || typeof saved.people !== 'object') throw new Error('Unsupported card');
      for (const [key, p] of Object.entries<any>(saved.people)) {
        if (!p || typeof p.name !== 'string' || !Array.isArray(p.stints)) throw new Error('Invalid card');
        const stints: TimeStint[] = [];
        for (const s of p.stints) {
          if (!Number.isFinite(s?.start) || !Number.isFinite(s?.end) || s.end < s.start) throw new Error('Invalid stint');
          stints.push({ start: s.start, end: s.end });
        }
        this.people.set(key, { name: p.name, stints: stints.sort((a, b) => a.start - b.start) });
      }
    } catch {
      // Keep an unreadable card as it is; never replace it with an empty one.
      this.people.clear();
      this.loadFailed = true;
      this.saveError = 'The saved time card could not be read. The original file has been left untouched, and today is not being recorded.';
    }
  }

  /** A window opened: clocks them in, or carries on their last stint if they were only gone a moment. */
  join(key: string, name: string): void {
    const count = this.windows.get(key) ?? 0;
    this.windows.set(key, count + 1);
    const now = this.now();
    let person = this.people.get(key);
    if (!person) this.people.set(key, (person = { name, stints: [] }));
    person.name = name;
    if (count) return;
    const last = person.stints[person.stints.length - 1];
    if (last && now >= last.end && now - last.end <= TIMECARD_GRACE_MS) last.end = now;
    else person.stints.push({ start: now, end: now });
    this.write();
  }

  /** A window closed: the last one clocks them out. */
  leave(key: string): void {
    const count = this.windows.get(key) ?? 0;
    if (count > 1) return void this.windows.set(key, count - 1);
    this.windows.delete(key);
    this.stretch(key);
    this.write();
  }

  /** Everyone still in is still in: saved, so a crash loses at most a tick. */
  tick(): void {
    if (!this.windows.size) return;
    for (const key of this.windows.keys()) this.stretch(key);
    this.write();
  }

  /** The office is stopping: everyone's stint ends now (a restart soon after carries it on). */
  flush(): void {
    this.tick();
  }

  state(key: string): TimeCardState {
    const person = this.people.get(key);
    if (person && this.windows.has(key)) this.stretch(key);
    return {
      name: person?.name ?? '',
      stints: (person?.stints ?? []).map((s) => ({ ...s })),
      open: this.windows.has(key),
      ...(this.saveError ? { saveError: this.saveError } : {}),
    };
  }

  private stretch(key: string) {
    const last = this.people.get(key)?.stints.at(-1);
    if (last) last.end = Math.max(last.end, this.now());
  }

  private write() {
    if (this.loadFailed) return;
    const cutoff = this.now() - TIMECARD_KEEP_MS;
    const people: Record<string, Person> = {};
    for (const [key, p] of this.people) {
      p.stints = p.stints.filter((s) => s.end >= cutoff);
      people[key] = p;
    }
    try {
      const temp = this.file + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, people }, null, 2), { mode: 0o600 });
      renameSync(temp, this.file);
      this.saveError = undefined;
    } catch {
      this.saveError = 'Your time is showing, but the card could not be saved to disk.';
    }
  }
}
