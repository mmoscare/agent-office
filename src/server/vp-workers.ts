import { DESK_BY_ID } from '../shared/layout.js';
import type { QueueTask, WorkerInfo, WorkerStatus } from '../shared/protocol.js';
import { RESTART_ERROR } from '../shared/task-status.js';
import { isAsleep, isBusy } from '../shared/status.js';

// Which workers are stuck, and what the VP does about each (see vp.ts). Only waking a worker and
// telling it to carry on, or pointing out a known workaround, happens without a person: a permission
// prompt is always the owner's, never approved; a question or a long silence is for the VP's judgment.

export type StuckKind = 'permission' | 'question' | 'stopped' | 'asleep-with-task' | 'unshipped' | 'silent' | 'rate-limit' | 'hung-test';

/** What's done about it: wake it (resume, with `say`), nudge it (type `say`), escalate to the owner, or report it to the VP. */
export type StuckAction = 'wake' | 'nudge' | 'escalate' | 'report';

export interface Stuck {
  kind: StuckKind;
  action: StuckAction;
  /** One line: what's wrong, for the VP's list and the owner's item. */
  detail: string;
  /** What the worker is told, for a wake or a nudge. */
  say?: string;
}

export interface WorkerLook {
  id: string;
  name: string;
  /** Seat and branch: names get reused, so this is how a worker is named to the owner. */
  seat: string;
  status: WorkerStatus;
  /** When it went into this status (ms), as far as the office knows. */
  since: number;
  task?: string;
  pr?: { number: number; url: string };
  issue?: number;
  queueTask?: { id: string; status: string; outcome?: string; error?: string; unshipped?: { dirty: number; commits: number } };
  /** When its terminal last printed anything. */
  outputAt?: number;
  /** Its terminal's last lines, as plain text. */
  tail: string;
  /** Who last typed into its terminal, and when. */
  lastInput?: { by: string; at: number };
  /** The office saved its uncommitted work as a WIP commit when it last went down. */
  checkpointed: boolean;
  running: boolean;
  stuck?: Stuck;
}

export interface StuckLimits {
  needsInputMs: number;
  stoppedMs: number;
  silentMs: number;
  hungTestMs: number;
  /** A person typed into it this recently: it's theirs to move along, not the VP's. */
  humanMs: number;
}

export const DEFAULT_LIMITS: StuckLimits = { needsInputMs: 10 * 60_000, stoppedMs: 10 * 60_000, silentMs: 30 * 60_000, hungTestMs: 10 * 60_000, humanMs: 30 * 60_000 };

export const CONTINUE = 'continue';
const REST_HINT = 'You hit "GraphQL: API rate limit exceeded": the account\'s GraphQL quota is shared by every worker and runs dry. Use the REST API instead, which has its own quota: `gh api repos/<owner>/<repo>/pulls/<n>`, `gh api repos/<owner>/<repo>/pulls -f base=<base> -f head=<branch> -f title=... -F body=@file` to open a PR, and `git fetch origin <branch> && git checkout -b <branch> --track origin/<branch>` instead of gh pr checkout. Then carry on.';
const TEST_HINT = 'If your test run is hanging: on Windows plain `npm test` hangs in tests/pull-links.test.ts. Stop it and run `node --import tsx --test --test-force-exit --test-timeout=120000 <files>` instead, leaving out tests/console-shell.test.ts (it never exits). Then carry on.';
const SHIP_HINT = 'Your task finished, but its work isn\'t on GitHub yet (uncommitted files or commits no PR carries). Commit it, push the branch and open its pull request, then leave the handoff under the worker handoff rule.';

const PERMISSION = /Do you want to (?:proceed|make this edit|create|run|allow)|Allow (?:once|always)|Access external directory|don't ask again|Yes, allow|approve this/i;
const RATE_LIMIT = /GraphQL: API rate limit exceeded|API rate limit exceeded for/i;
const TESTING = /npm (?:run )?test\b|node (?:--import tsx )?--test\b|pull-links\.test/i;

/** How long, in words. */
export function forHowLong(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** Whether this worker is stuck, and what to do about it. */
export function classify(w: WorkerLook, now: number, limits: StuckLimits = DEFAULT_LIMITS): Stuck | undefined {
  const inState = now - w.since;
  const human = w.lastInput && !/^VP\b/.test(w.lastInput.by) && now - w.lastInput.at < limits.humanMs;
  const tail = w.tail.split('\n').slice(-15).join('\n');
  if (w.status === 'needs_input') {
    if (/^Wants permission/.test(w.task ?? '') || PERMISSION.test(tail)) {
      return { kind: 'permission', action: 'escalate', detail: `a permission prompt has been open for ${forHowLong(inState)}: only a person approves those` };
    }
    if (inState >= limits.needsInputMs) return { kind: 'question', action: 'report', detail: `waiting on an answer for ${forHowLong(inState)}` };
    return undefined;
  }
  // Its task was cut short (a restart, or its process ended) and nothing has moved it on since. One that
  // came back idle after a restart waits a couple of minutes first, in case someone's already on it.
  const t = w.queueTask;
  const cutShort = !!t && t.status === 'done' && t.outcome === 'exited' && !w.pr;
  const byRestart = (cutShort && t!.error === RESTART_ERROR) || w.checkpointed;
  if ((isAsleep(w.status) && (t?.status === 'running' || cutShort || w.checkpointed)) || (w.status === 'idle' && byRestart && inState >= 2 * 60_000 && !human)) {
    return { kind: 'asleep-with-task', action: 'wake', detail: `${byRestart ? 'stopped by a restart' : 'asleep'} with its task unfinished${w.task ? ` (${w.task})` : ''}`, say: CONTINUE };
  }
  if (RATE_LIMIT.test(tail) && !isBusy(w.status)) return { kind: 'rate-limit', action: 'nudge', detail: 'stopped on GitHub\'s GraphQL rate limit', say: REST_HINT };
  if ((w.status === 'paused' || w.status === 'interrupted') && inState >= limits.stoppedMs) {
    // Someone pressed Esc, or typed to it lately: that's theirs, the VP only reports it.
    if (w.status === 'interrupted' || human) return { kind: 'stopped', action: 'report', detail: `${w.status} for ${forHowLong(inState)}${human ? `, after ${w.lastInput!.by} typed to it` : ''}` };
    return { kind: 'stopped', action: 'nudge', detail: `paused for ${forHowLong(inState)} without finishing its turn`, say: CONTINUE };
  }
  if (w.status === 'done' && w.queueTask?.unshipped && (w.queueTask.unshipped.dirty || w.queueTask.unshipped.commits) && !w.pr) {
    const u = w.queueTask.unshipped;
    return { kind: 'unshipped', action: 'nudge', detail: `finished with no PR, leaving ${[u.dirty && `${u.dirty} uncommitted file${u.dirty === 1 ? '' : 's'}`, u.commits && `${u.commits} commit${u.commits === 1 ? '' : 's'} no PR carries`].filter(Boolean).join(' and ')}`, say: SHIP_HINT };
  }
  if (w.status === 'working' && w.outputAt !== undefined) {
    const quiet = now - w.outputAt;
    if (TESTING.test(tail) && quiet >= limits.hungTestMs) return { kind: 'hung-test', action: 'nudge', detail: `a test run has printed nothing for ${forHowLong(quiet)}`, say: TEST_HINT };
    if (quiet >= limits.silentMs) return { kind: 'silent', action: 'report', detail: `working, but its terminal has printed nothing for ${forHowLong(quiet)}` };
  }
  return undefined;
}

/** The facts the VP needs about each worker on the floor (board agents and the meeting table left out). */
export function lookAt(workers: WorkerInfo[], tasks: QueueTask[], extra: (w: WorkerInfo) => { since: number; outputAt?: number; tail: string; running: boolean }, now: number, limits?: StuckLimits): WorkerLook[] {
  const out: WorkerLook[] = [];
  for (const w of workers) {
    if (w.kind !== 'agent' || w.meeting || DESK_BY_ID.get(w.deskId)?.station) continue;
    const t = [...tasks].reverse().find((x) => x.workerId === w.id);
    const e = extra(w);
    const seat = DESK_BY_ID.get(w.deskId)?.label ?? w.deskId;
    const branch = w.worktree?.branch ?? w.workspace?.repositories.map((r) => r.branch).join(', ');
    const pr = w.pr ? { number: w.pr.number, url: w.pr.url } : t?.pr ? { number: t.pr.number, url: t.pr.url } : undefined;
    const look: WorkerLook = {
      id: w.id,
      name: w.name,
      seat: `${w.name} at ${seat}${branch ? ` (${branch})` : ''}`,
      status: w.status,
      since: e.since,
      task: w.status === 'needs_input' ? w.activity : (w.task?.name ?? t?.title ?? w.activity),
      pr,
      issue: t?.issue,
      queueTask: t && { id: t.id, status: t.status, outcome: t.outcome, error: t.error, unshipped: t.unshipped },
      outputAt: e.outputAt,
      tail: e.tail,
      lastInput: w.lastInput,
      checkpointed: !!w.checkpoints?.length,
      running: e.running,
    };
    look.stuck = classify(look, now, limits);
    out.push(look);
  }
  return out;
}
