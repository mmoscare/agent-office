import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// What the VP remembers on a floor, kept in .agent-office/vp.json so a restart can't make him forget
// a fix task he queued (and queue a second one), a verify that passed, or who put him on duty.

/** The standing-duty switch: the owner's standing approval for verified merges on this floor. */
export interface Duty {
  on: boolean;
  by: string;
  at: number;
  /** How often the office sweeps while he's on duty. */
  everyMs: number;
}

/** The one fix for a PR: a queue task, or its own worker nudged to fix it. */
export interface FixRecord {
  pr: number;
  repo: string;
  /** The queue task, when it was one. */
  taskId?: string;
  /** The worker nudged instead, by id and by seat + branch. */
  workerId?: string;
  worker?: string;
  kind: ProblemKind;
  /** What was wrong: conflicting files, finding ids, failing checks or steps. */
  details: string[];
  reason: string;
  head: string;
  at: number;
  /** How many fixes this PR has had, this one included. */
  attempt: number;
}

export type ProblemKind = 'conflict' | 'codex' | 'ci' | 'verify';

/** A verify's outcome, kept by the exact tree it checked. */
export interface VerifiedRecord {
  pr: number;
  repo: string;
  head: string;
  base: string;
  tree: string;
  ok: boolean;
  reason?: string;
  steps: { name: string; ok: boolean; ms: number; skipped?: string; baseline?: number; timedOut?: boolean }[];
  at: number;
  ms: number;
}

export interface MergeRecord {
  pr: number;
  repo: string;
  title: string;
  url: string;
  head: string;
  base: string;
  tree: string;
  at: number;
  /** "duty" (the timer), "sweep" (asked), "merge" (office-vp merge), "go-live". */
  via: string;
}

export interface VpState {
  duty?: Duty;
  /** By pr key (repo#n): the fix under way or last made. */
  fixes: Record<string, FixRecord>;
  verified: Record<string, VerifiedRecord>;
  merges: MergeRecord[];
  /** Escalations already filed, by key: never twice for the same thing. */
  escalated: Record<string, number>;
  /** Interventions on workers already made, by key (worker + what + when its state began). */
  helped: Record<string, number>;
  lastSweep?: { at: number; ms: number; summary: string };
  /** Per repository (owner/name): the branch PRs merge into, when it isn't the default branch. */
  bases?: Record<string, string>;
}

export const DEFAULT_EVERY_MS = 10 * 60_000;
export const MIN_EVERY_MS = 2 * 60_000;
const KEEP_MERGES = 200;
const KEEP_VERIFIED = 100;

export const prKey = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

export function emptyState(): VpState {
  return { fixes: {}, verified: {}, merges: [], escalated: {}, helped: {} };
}

export class VpStore {
  readonly file: string;
  state: VpState;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'vp.json');
    this.state = this.load();
  }

  private load(): VpState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<VpState>;
      const s = emptyState();
      const d = raw.duty;
      if (d && typeof d.on === 'boolean') s.duty = { on: d.on, by: typeof d.by === 'string' ? d.by : 'someone', at: typeof d.at === 'number' ? d.at : 0, everyMs: typeof d.everyMs === 'number' && d.everyMs >= MIN_EVERY_MS ? d.everyMs : DEFAULT_EVERY_MS };
      if (raw.fixes && typeof raw.fixes === 'object') s.fixes = raw.fixes;
      if (raw.verified && typeof raw.verified === 'object') s.verified = raw.verified;
      if (Array.isArray(raw.merges)) s.merges = raw.merges;
      if (raw.escalated && typeof raw.escalated === 'object') s.escalated = raw.escalated;
      if (raw.helped && typeof raw.helped === 'object') s.helped = raw.helped;
      if (raw.lastSweep && typeof raw.lastSweep.at === 'number') s.lastSweep = raw.lastSweep;
      if (raw.bases && typeof raw.bases === 'object') s.bases = raw.bases;
      return s;
    } catch {
      return emptyState();
    }
  }

  save() {
    const s = this.state;
    if (s.merges.length > KEEP_MERGES) s.merges = s.merges.slice(-KEEP_MERGES);
    const verified = Object.entries(s.verified).sort((a, b) => b[1].at - a[1].at);
    if (verified.length > KEEP_VERIFIED) s.verified = Object.fromEntries(verified.slice(0, KEEP_VERIFIED));
    try {
      // Whole or not at all: a half-written file would forget the fix tasks.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
