import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BOTS, botDesk } from '../shared/bots.js';
import { normalizeRepo } from '../shared/floors.js';
import type { QueueTask, WorkerInfo } from '../shared/protocol.js';
import type { VpJobView, VpView } from '../shared/vp.js';
import { gh as realGh } from './github.js';
import { gitPull, officeRoot } from './git-board.js';
import { floorRepos, originRepo, sweep, summary, type SweepResult } from './vp-sweep.js';
import { DEFAULT_EVERY_MS, MIN_EVERY_MS, VpStore, prKey, type Duty } from './vp-state.js';
import { detectRecipe, verifySlot, type Recipe, type VerifyEnv } from './vp-verify.js';
import { lookAt, forHowLong, type WorkerLook } from './vp-workers.js';
import { postComment, type Gh } from './vp-github.js';

// The VP on one floor (see shared/bots.ts for the agent, vp-sweep.ts for the sweep): his memory, his
// standing duty, the one job he runs at a time, and his help for stuck workers. The office server
// runs all of it; the VP agent drives it with office-vp (/office/vp) and talks to people. Nothing
// here restarts the office, sends a worker home, approves a prompt, or edits a file.

/** What the VP needs from his floor. Narrow on purpose, so a test can fake it. */
export interface VpFloor {
  id: string;
  dir: string;
  dataDir: string;
  workers: {
    list(): WorkerInfo[];
    get(id: string): WorkerInfo | undefined;
    prompt(id: string, text: string, by?: string): string | undefined;
    resume(id: string, prompt?: string): string | undefined;
    peek(id: string, lines?: number): { tail: string; outputAt?: number; running: boolean } | undefined;
  };
  tasks(): QueueTask[];
  /** Adds a task to the floor's queue: its id, or why it couldn't. */
  queue(title: string, prompt: string, by: string): { id: string } | string;
  /** Files a To Do Next item: why it couldn't, if it couldn't. */
  plan(text: string): string | undefined;
  /** Why the machine is under pressure right now (machine.ts), if it is. */
  pressure(): string | undefined;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  /** Tells everyone on the floor how the VP stands. */
  emit(view: VpView): void;
  gh?: Gh;
  /** Where the throwaway folders go (tests put them in a scratch folder). */
  tmpRoot?: string;
  /** The running office's own checkout and the commit it started from, for "merges waiting for a restart" (tests fake it). */
  office?: { dir: string; head: string } | null;
  /** The worker limits for "stuck" (tests shorten them). */
  now?(): number;
}

/** How often the duty timer looks whether a sweep is due. */
const TICK_MS = 30_000;
const JOB_LOG = 200;

/** The commit the running office started from: HEAD of its checkout when this module loaded. */
const startHead: Promise<{ dir: string; head: string } | null> = (async () => {
  const dir = officeRoot();
  if (!dir) return null;
  const head = await gitOut(['rev-parse', 'HEAD'], dir);
  return head ? { dir, head } : null;
})();

function gitOut(args: string[], cwd: string, timeout = 30_000): Promise<string | undefined> {
  return new Promise((resolve) => execFile('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true }, (err, out) => resolve(err ? undefined : String(out).trim())));
}

/**
 * How many PRs have merged into `baseRef` since `startHead` (the commit the running office started
 * from): merges that only run once the office restarts. Undefined when it can't tell.
 */
export async function mergesSince(repoDir: string, startHead: string, baseRef: string): Promise<number | undefined> {
  const n = await gitOut(['rev-list', '--count', '--first-parent', '--merges', `${startHead}..${baseRef}`], repoDir);
  return n === undefined || !/^\d+$/.test(n) ? undefined : Number(n);
}

interface Job {
  id: string;
  kind: VpJobView['kind'];
  what: string;
  by: string;
  startedAt: number;
  finishedAt?: number;
  log: string[];
  result?: SweepResult;
  /** What the worker help did, and what it left for the VP's judgment. */
  help?: { done: string[]; owner: string[]; judge: string[] };
  error?: string;
  done: Promise<void>;
}

export class VpDesk {
  readonly store: VpStore;
  private timer?: NodeJS.Timeout;
  private job?: Job;
  private jobs = new Map<string, Job>();
  /** When each worker went into its status, as seen here. */
  private since = new Map<string, { status: string; at: number }>();
  private readonly bornAt: number;
  private waiting?: number;
  private stopped = false;

  constructor(private floor: VpFloor) {
    this.store = new VpStore(floor.dataDir);
    this.bornAt = this.now();
  }

  private now() {
    return this.floor.now?.() ?? Date.now();
  }

  private get gh(): Gh {
    return this.floor.gh ?? realGh;
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    void this.refreshWaiting();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** A worker changed: remember when its status did. */
  onWorker(w: WorkerInfo) {
    const was = this.since.get(w.id);
    if (!was || was.status !== w.status) this.since.set(w.id, { status: w.status, at: this.now() });
  }

  onWorkerGone(id: string) {
    this.since.delete(id);
  }

  // ---- Duty ------------------------------------------------------------------------------------

  get duty(): Duty | undefined {
    return this.store.state.duty;
  }

  /** Turns standing duty on or off; `everyMs` is how often it sweeps. Returns why it can't, if it can't. */
  setDuty(on: boolean, by: string, everyMs?: number): string | undefined {
    if (everyMs !== undefined && (!Number.isFinite(everyMs) || everyMs < MIN_EVERY_MS)) return `The VP sweeps at most every ${MIN_EVERY_MS / 60_000} minutes`;
    const prev = this.store.state.duty;
    this.store.state.duty = { on, by, at: on && prev?.on ? prev.at : this.now(), everyMs: everyMs ?? prev?.everyMs ?? DEFAULT_EVERY_MS };
    if (on && prev?.on) this.store.state.duty.by = prev.by;
    this.store.save();
    this.emit();
    // Straight to work: the first sweep starts now.
    if (on && !prev?.on) this.tick(true);
    return undefined;
  }

  private tick(force = false) {
    if (this.stopped) return;
    const d = this.store.state.duty;
    if (!d?.on || this.job) return;
    const last = this.store.state.lastSweep?.at ?? 0;
    if (!force && this.now() - last < d.everyMs) return;
    this.run('sweep', `duty sweep`, 'duty', async (job) => {
      job.result = await this.sweepNow(job, { via: 'duty' });
      job.help = await this.helpWorkers(job, true);
      this.report(job.result, job);
    });
  }

  // ---- Jobs --------------------------------------------------------------------------------------

  /** Starts a job unless one is running: then that one's id comes back, with `already`. */
  run(kind: Job['kind'], what: string, by: string, fn: (job: Job) => Promise<void>): { id: string; already?: boolean } {
    if (this.job) return { id: this.job.id, already: true };
    const job: Job = { id: randomBytes(4).toString('hex'), kind, what, by, startedAt: this.now(), log: [], done: Promise.resolve() };
    this.job = job;
    this.jobs.set(job.id, job);
    // Keep the last few, for office-vp status to report on.
    for (const id of [...this.jobs.keys()].slice(0, Math.max(0, this.jobs.size - 10))) this.jobs.delete(id);
    this.emit();
    job.done = (async () => {
      try {
        await fn(job);
      } catch (err) {
        job.error = (err as Error).message;
        this.log(job, `⚠️ ${job.error}`);
      } finally {
        job.finishedAt = this.now();
        if (this.job === job) this.job = undefined;
        await this.refreshWaiting();
        this.emit();
      }
    })();
    return { id: job.id };
  }

  jobById(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  private log(job: Job, line: string) {
    job.log.push(`${new Date(this.now()).toISOString().slice(11, 19)} ${line}`);
    if (job.log.length > JOB_LOG) job.log.splice(0, job.log.length - JOB_LOG);
  }

  private verifyEnv(job: Job): VerifyEnv {
    return { pressure: () => this.floor.pressure(), tmpRoot: this.floor.tmpRoot, log: (l) => this.log(job, l) };
  }

  /**
   * The checks for a repository. Detected each time from its package.json (agent-office gets the
   * office's own), and written to .agent-office/vp-recipes.json for the owner to see; once the owner
   * edits one there and sets its "source" to "saved", that one is used instead.
   */
  recipe(repoDir: string, repo: string): Recipe {
    const file = path.join(this.floor.dataDir, 'vp-recipes.json');
    let saved: Record<string, Recipe & { note?: string }> = {};
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // none yet
    }
    const mine = saved[repo.toLowerCase()];
    if (mine?.source === 'saved' && Array.isArray(mine.steps)) return mine;
    const found = detectRecipe(repoDir);
    if (JSON.stringify(mine?.steps) !== JSON.stringify(found.steps)) {
      const note = 'Detected by the VP. To change it, edit the steps and set "source" to "saved": the VP then keeps yours.';
      try {
        writeFileSync(file, JSON.stringify({ ...saved, [repo.toLowerCase()]: { ...found, note } }, null, 2), { mode: 0o600 });
      } catch {
        // unsaved: detected again next time
      }
    }
    return found;
  }

  sweepNow(job: Job, opts: { dryRun?: boolean; only?: { number: number; repo?: string }; mode?: 'sweep' | 'verify' | 'merge'; via: string }): Promise<SweepResult> {
    const duty = this.store.state.duty;
    return sweep(
      {
        floorDir: this.floor.dir,
        gh: this.gh,
        store: this.store,
        workers: () => this.floor.workers.list(),
        tasks: () => this.floor.tasks(),
        queue: (title, prompt) => this.floor.queue(title, prompt, BOTS.vp.name),
        nudge: (id, text) => this.floor.workers.prompt(id, text, BOTS.vp.name),
        escalate: (text) => this.floor.plan(text),
        verifyEnv: this.verifyEnv(job),
        recipe: (dir, repo) => this.recipe(dir, repo),
        pull: (rel) => gitPull(this.floor.dir, rel),
        log: (l) => this.log(job, l),
        mergedBy: () => (opts.via === 'duty' && duty?.on ? `on duty since ${new Date(duty.at).toISOString().slice(0, 16).replace('T', ' ')} UTC, turned on by ${duty.by}` : `asked by ${job.by}, with office-vp ${opts.via}`),
        now: () => this.now(),
      },
      opts,
    ).then((res) => {
      this.log(job, `📋 ${summary(res)}`);
      return res;
    });
  }

  // ---- Workers -----------------------------------------------------------------------------------

  /** Every worker on the floor, how long it's been as it is, and whether (and how) it's stuck. */
  workers(): WorkerLook[] {
    const now = this.now();
    return lookAt(
      this.floor.workers.list(),
      this.floor.tasks(),
      (w) => {
        const peek = this.floor.workers.peek(w.id, 20);
        const seen = this.since.get(w.id);
        const since = seen && seen.status === w.status ? seen.at : w.status === 'done' || w.status === 'needs_input' ? (w.waitingSince ?? this.bornAt) : this.bornAt;
        return { since, outputAt: peek?.outputAt, tail: peek?.tail ?? '', running: !!peek?.running };
      },
      now,
    );
  }

  /** A worker by id or name (a name can be reused: the first match at a desk). */
  findWorker(ref: string): WorkerInfo | undefined {
    const all = this.floor.workers.list();
    const r = ref.trim().toLowerCase();
    return all.find((w) => w.id === ref) ?? all.find((w) => w.name.toLowerCase() === r);
  }

  /** Types `text` into a worker's session (office-vp nudge). */
  nudge(ref: string, text: string, by: string): string | undefined {
    const w = this.findWorker(ref);
    if (!w) return `No worker called ${ref} on this floor`;
    if (w.status === 'needs_input') return `${w.name} is waiting on an answer or a permission prompt in its terminal: typing into it would answer it. A person sees to those (escalate it).`;
    if (!this.floor.workers.peek(w.id)?.running) return `${w.name} is asleep: wake it with office-vp wake ${w.name}`;
    return this.floor.workers.prompt(w.id, text, by);
  }

  /** Wakes an asleep worker, telling it `say` (office-vp wake); one at its prompt is just told it. */
  wake(ref: string, say: string, by: string): string | undefined {
    const w = this.findWorker(ref);
    if (!w) return `No worker called ${ref} on this floor`;
    if (this.floor.workers.peek(w.id)?.running) {
      if (w.status === 'needs_input') return `${w.name} is waiting on an answer or a permission prompt: a person sees to that`;
      if (w.status === 'working' || w.status === 'starting') return `${w.name} is awake and working already`;
      return this.floor.workers.prompt(w.id, say, by);
    }
    return this.floor.workers.resume(w.id, say);
  }

  /**
   * On duty, the safe help happens by itself, once per spell of being stuck: a worker asleep with its
   * task unfinished is woken and told "continue"; a known workaround is pointed out; a permission
   * prompt goes to the owner (never approved). What needs judgment is left for the VP agent's report.
   */
  async helpWorkers(job: Job, act: boolean): Promise<{ done: string[]; owner: string[]; judge: string[] }> {
    const out = { done: [] as string[], owner: [] as string[], judge: [] as string[] };
    const helped = this.store.state.helped;
    for (const w of this.workers()) {
      const s = w.stuck;
      if (!s) continue;
      const key = `${w.id}:${s.kind}:${w.since}`;
      if (helped[key]) continue;
      if (s.action === 'report') {
        out.judge.push(`${w.seat}: ${s.detail}`);
        // Reported once per spell, on duty; a sweep someone asked for only lists it.
        if (act) helped[key] = this.now();
        continue;
      }
      if (!act) continue;
      if (s.action === 'escalate') {
        const text = `VP needs you: ${w.seat} ${s.detail}. It's asking: ${w.task ?? 'see its terminal'}. Open its terminal (walk up to it and press O) and approve or deny it; the VP never approves prompts.`;
        const err = this.floor.plan(text);
        if (err) this.log(job, `⚠️ Couldn't file "${text}": ${err}`);
        out.owner.push(text);
      } else {
        const err = s.action === 'wake' ? this.wake(w.id, s.say ?? 'continue', BOTS.vp.name) : this.nudge(w.id, s.say ?? 'continue', BOTS.vp.name);
        if (err) {
          this.log(job, `⚠️ ${w.seat}: ${err}`);
          continue;
        }
        const said = s.action === 'wake' ? `woke ${w.seat} and told it "${s.say}"` : `told ${w.seat}: ${s.say === 'continue' ? '"continue"' : (s.say ?? '').split('.')[0]}`;
        out.done.push(`${said} (${s.detail})`);
        this.log(job, `🛟 ${said}`);
        await this.recordOnThread(w, `🛟 The VP ${said}, because it was ${s.detail}.`);
      }
      helped[key] = this.now();
    }
    // Forget spells long over.
    for (const [k, at] of Object.entries(helped)) if (this.now() - at > 7 * 24 * 3600_000) delete helped[k];
    this.store.save();
    return out;
  }

  /** Records an intervention on the worker's PR, or its issue. */
  private async recordOnThread(w: WorkerLook, text: string) {
    const repos = await floorRepos(this.floor.dir).catch(() => []);
    if (w.pr) {
      const repo = normalizeRepo(w.pr.url.replace(/\/pull\/\d+.*$/, ''));
      const r = repos.find((x) => x.repo.toLowerCase() === repo?.toLowerCase()) ?? repos[0];
      if (r && repo) await postComment(this.gh, r.dir, repo, w.pr.number, text);
    } else if (w.issue !== undefined && repos.length === 1) {
      await postComment(this.gh, repos[0].dir, repos[0].repo, w.issue, text);
    }
  }

  /** After a duty sweep: the VP agent hears about it only when there's something to say or judge. */
  private report(res: SweepResult | undefined, job: Job) {
    const help = job.help;
    if (!res) return;
    const lines: string[] = [];
    if (res.merged.length) lines.push(`Merged: ${res.merged.map((m) => `#${m.pr} ${m.title} (${m.url})`).join('; ')}.`);
    if (res.fixes.length) lines.push(`Fixes started: ${res.fixes.map((f) => `#${f.pr} (${f.reason}) ${f.taskId ? `task ${f.taskId}` : `by ${f.worker}`}`).join('; ')}.`);
    if (res.escalations.length) lines.push(`Handed to the owner: ${res.escalations.join(' | ')}`);
    if (help?.done.length) lines.push(`Helped: ${help.done.join('; ')}.`);
    if (help?.owner.length) lines.push(`For the owner: ${help.owner.join(' | ')}`);
    if (help?.judge.length) lines.push(`Needs your judgment: ${help.judge.join('; ')}. Look with office-vp workers, then help (office-vp nudge/wake) or escalate.`);
    if (res.errors.length) lines.push(`Errors: ${res.errors.join('; ')}`);
    if (this.waiting) lines.push(`${this.waiting} merge${this.waiting === 1 ? '' : 's'} waiting for a restart (you never restart the office).`);
    if (res.merged.length) this.floor.toast(`👔 The VP merged ${res.merged.map((m) => `#${m.pr}`).join(', ')}${this.waiting ? ` · ${this.waiting} merge${this.waiting === 1 ? '' : 's'} waiting for a restart` : ''}`);
    const vp = this.floor.workers.list().find((w) => w.deskId === botDesk('vp'));
    const something = res.merged.length || res.fixes.length || res.escalations.length || help?.owner.length || help?.judge.length;
    if (!vp || !something || !this.floor.workers.peek(vp.id)?.running || !(vp.status === 'idle' || vp.status === 'done')) return;
    this.floor.workers.prompt(vp.id, `Duty report from the office (sweep ${job.id}): ${lines.join(' ')} Say briefly what happened, with links, and a numbered list of what the owner needs to do (or "nothing").`, 'VP duty');
  }

  // ---- The restart count -------------------------------------------------------------------------

  /** On the office's own floor: how many merges wait for a restart. Undefined elsewhere. */
  async refreshWaiting(): Promise<number | undefined> {
    const office = this.floor.office === undefined ? await startHead : this.floor.office;
    if (!office) return (this.waiting = undefined);
    const appRepo = await originRepo(office.dir);
    const repos = await floorRepos(this.floor.dir).catch(() => []);
    const r = repos.find((x) => x.repo.toLowerCase() === appRepo?.toLowerCase());
    if (!r) return (this.waiting = undefined);
    const base = this.store.state.bases?.[r.repo.toLowerCase()] ?? (await gitOut(['rev-parse', '--abbrev-ref', 'origin/HEAD'], r.dir))?.replace(/^origin\//, '') ?? 'main';
    const n = await mergesSince(r.dir, office.head, `refs/remotes/origin/${base}`);
    this.waiting = n;
    return n;
  }

  // ---- What everyone sees ------------------------------------------------------------------------

  view(): VpView {
    const s = this.store.state;
    const j = this.job;
    const slot = verifySlot();
    return {
      duty: s.duty,
      job: j && { id: j.id, kind: j.kind, what: j.what, by: j.by, startedAt: j.startedAt, last: j.log.at(-1) },
      lastSweep: s.lastSweep,
      waitingRestart: this.waiting,
      verifying: slot.holder,
      merges: s.merges.slice(-5).reverse().map((m) => ({ pr: m.pr, repo: m.repo, title: m.title, url: m.url, at: m.at })),
    };
  }

  private emit() {
    this.floor.emit(this.view());
  }

  /** office-vp status: the last sweep's PRs by group, the stuck workers, the restart count, the duty. */
  status(): Record<string, unknown> {
    const last = [...this.jobs.values()].reverse().find((j) => j.result);
    const stuck = this.workers().filter((w) => w.stuck);
    const s = this.store.state;
    return {
      ...this.view(),
      duty: s.duty ? { ...s.duty, for: s.duty.on ? forHowLong(this.now() - s.duty.at) : undefined } : { on: false },
      prs: last?.result?.prs ?? [],
      sweptAt: last?.result?.at,
      fixes: Object.values(s.fixes).map((f) => ({ ...f, key: prKey(f.repo, f.pr) })),
      stuck: stuck.map((w) => ({ worker: w.seat, status: w.status, for: forHowLong(this.now() - w.since), ...w.stuck })),
      jobLog: (this.job ?? last)?.log.slice(-15) ?? [],
    };
  }
}

// ---- /office/vp -----------------------------------------------------------------------------------

export interface VpRequest {
  method: string;
  query: URLSearchParams;
  body?: Record<string, unknown>;
  /** Who's asking: the VP agent, and the person who last typed to him. */
  by: string;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const prNumber = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The VP's endpoint, behind office-vp. Resolves to an HTTP status and a JSON body. */
export async function handleVp(desk: VpDesk, req: VpRequest): Promise<{ status: number; body: unknown }> {
  if (req.method === 'GET') {
    const view = req.query.get('view') ?? 'status';
    if (view === 'status') return { status: 200, body: desk.status() };
    if (view === 'workers') return { status: 200, body: { workers: desk.workers().map((w) => ({ ...w, for: forHowLong(Date.now() - w.since) })) } };
    if (view === 'job') {
      const job = desk.jobById(req.query.get('id') ?? '');
      if (!job) return { status: 404, body: { error: 'No such job (office-vp status shows the latest)' } };
      return { status: 200, body: { id: job.id, kind: job.kind, what: job.what, startedAt: job.startedAt, finishedAt: job.finishedAt, log: job.log, result: job.result, error: job.error } };
    }
    return { status: 400, body: { error: 'view is status, workers or job' } };
  }
  if (req.method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
  const b = req.body ?? {};
  const action = str(b.action, 20);
  const repo = normalizeRepo(b.repo);
  switch (action) {
    case 'sweep': {
      const dryRun = b.dryRun === true;
      const r = desk.run('sweep', dryRun ? 'dry-run sweep' : 'sweep', req.by, async (job) => {
        job.result = await desk.sweepNow(job, { dryRun, via: 'sweep' });
        job.help = await desk.helpWorkers(job, false);
      });
      return { status: 200, body: { ok: true, job: r.id, already: r.already } };
    }
    case 'verify':
    case 'merge': {
      const n = prNumber(b.pr);
      if (!n) return { status: 400, body: { error: `Say which PR: office-vp ${action} <number>` } };
      const r = desk.run(action, `${action} #${n}`, req.by, async (job) => {
        job.result = await desk.sweepNow(job, { only: { number: n, repo }, mode: action, via: action });
      });
      return { status: 200, body: { ok: true, job: r.id, already: r.already } };
    }
    case 'retry': {
      const n = prNumber(b.pr);
      if (!n) return { status: 400, body: { error: 'Say which PR: office-vp retry <number>' } };
      const s = desk.store.state;
      const keys = Object.keys(s.fixes).filter((k) => k.endsWith(`#${n}`) && (!repo || k === prKey(repo, n)));
      if (!keys.length) return { status: 404, body: { error: `The VP has no fix on record for #${n}` } };
      for (const k of keys) {
        delete s.fixes[k];
        for (const e of Object.keys(s.escalated)) if (e.startsWith(`${k}:`)) delete s.escalated[e];
      }
      desk.store.save();
      return { status: 200, body: { ok: true, note: `Forgot the fix for #${n}: the next sweep may start one more.` } };
    }
    case 'nudge': {
      const text = str(b.text, 20_000).trim();
      if (!text) return { status: 400, body: { error: 'Give the text to type on stdin' } };
      const err = desk.nudge(str(b.worker, 64), text, req.by);
      return err ? { status: 400, body: { error: err } } : { status: 200, body: { ok: true } };
    }
    case 'wake': {
      const err = desk.wake(str(b.worker, 64), str(b.say, 2000).trim() || 'continue', req.by);
      return err ? { status: 400, body: { error: err } } : { status: 200, body: { ok: true } };
    }
    case 'duty': {
      const on = b.on === true;
      const every = b.everyMin === undefined ? undefined : Number(b.everyMin) * 60_000;
      const err = desk.setDuty(on, req.by, every);
      return err ? { status: 400, body: { error: err } } : { status: 200, body: { ok: true, duty: desk.duty } };
    }
    default:
      return { status: 400, body: { error: 'The action is sweep, verify, merge, retry, nudge, wake or duty' } };
  }
}
