import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ghRef, type ChangesState, FloorInfo, type GhPause, PeerInfo, ProjectInfo, type QueueState, ServerMsg, WorkerInfo } from '../shared/protocol.js';
import type { PlansState } from '../shared/plans.js';
import type { MailBrief } from '../shared/mail.js';
import { isBusy } from '../shared/status.js';
import { summarizeWorkers } from '../shared/attention.js';
import { floorRoster } from '../shared/roster.js';
import { pullForBranch } from '../shared/pulls.js';
import type { FloorDef } from './building.js';
import { excludeFromGit } from './config.js';
import { configuredProvider } from './agents.js';
import { WorkerManager, type HookEnv } from './workers.js';
import { GitHub, MergeWatch, type Board } from './github.js';
import { boardsDue, TICK_MS, type FloorWatch } from './board-cadence.js';
import { TaskQueue } from './queue.js';
import { Changes } from './changes.js';
import { WorkspaceChanges } from './workspace-changes.js';
import { Decor } from './decor.js';
import { Dog } from './dog.js';
import { Jukebox } from './jukebox.js';
import { Whiteboard } from './whiteboard.js';
import { Plans } from './plans.js';
import { Inbox } from './inbox.js';
import { MeetingRoom } from './meetings.js';
import { Worktrees } from './worktrees.js';
import { UnshippedWatch } from './unshipped.js';
import { readProjectLogo, type ProjectLogo } from './project-logo.js';
import type { Ledger } from './usage.js';
import type { Capacity } from './machine.js';

type ToastLevel = 'info' | 'warn' | 'error';

/** What a floor needs from the building around it. */
export interface FloorContext {
  agentCmd: string;
  agentArgs: string[];
  hook: HookEnv;
  /** Spend, across every floor. */
  ledger: Ledger;
  /** The office's worker limit, across every floor. */
  capacity: Capacity;
  /** To everyone on this floor. */
  emit(floor: Floor, msg: ServerMsg, droppable?: boolean): void;
  toast(floor: Floor, text: string, level?: ToastLevel): void;
  /** A worker's terminal output (or its side shell's), for whoever has that terminal open. */
  termData(workerId: string, data: string, viewers: string[], side?: boolean): void;
  /** What a worker changed, for whoever has its Changes window open. */
  changes(state: ChangesState, clients: string[]): void;
  /** A worker on this floor changed, or left (then just its id). */
  workerChanged(floor: Floor, w: WorkerInfo | string): void;
  /** How many people are on this floor right now. */
  people(floor: Floor): number;
  /** Who's on this floor, and where they stand. */
  peers(floor: Floor): PeerInfo[];
  /** Whether the office's in-tray door is open (see inbox.ts): one door for every floor. */
  inboxDoor(): boolean;
  /** The Receptionist's mailbox (see mailroom.ts): it hears about finished tasks and To Do Next items, to email whoever asked. */
  mail?: {
    brief(): MailBrief;
    queueChanged(floor: Floor, state: QueueState): void;
    plansChanged(floor: Floor, state: PlansState): void;
  };
}


/** What `git` says about a checkout: its name, branch and origin for the top bar. */
export function projectInfo(dir: string, name: string, agentCmd: string, agentArgs: string[]): ProjectInfo {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    name,
    dir,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(['remote', 'get-url', 'origin']),
    agentCmd: [agentCmd, ...agentArgs].join(' '),
    defaultProvider: configuredProvider(agentCmd),
    agentProviders: configuredProvider(agentCmd) === 'custom' ? ['claude', 'opencode', 'codex', 'custom'] : ['claude', 'opencode', 'codex'],
  };
}

/**
 * One floor of the building: a project's checkout with its own desks and workers, issues and PR
 * boards, task queue, pictures and jukebox, all kept in that checkout's .agent-office folder.
 */
export class Floor {
  readonly id: string;
  readonly dir: string;
  readonly project: ProjectInfo;
  readonly logo?: ProjectLogo;
  readonly workers: WorkerManager;
  readonly github: GitHub;
  readonly queue: TaskQueue;
  readonly changes: Changes;
  readonly workspaceChanges: WorkspaceChanges;
  readonly decor: Decor;
  readonly jukebox: Jukebox;
  /** The whiteboard everyone on the floor draws on together. */
  readonly whiteboard: Whiteboard;
  readonly plans: Plans;
  /** The 📥 in-tray: what came into the office from outside (see inbox.ts). */
  readonly inbox: Inbox;
  /** The meeting room, where workers work through a question together (see meetings.ts). */
  readonly meetings: MeetingRoom;
  /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
  readonly ready: Promise<void>;
  readonly dog: Dog;
  /** Office branches with work no PR carries, for the PR board and the queue's warnings (see unshipped.ts). */
  readonly unshipped: UnshippedWatch;
  private timer: NodeJS.Timeout;
  /** Looks at the boards again as soon as GitHub's rate limit lifts, rather than at the next tick. */
  private resume?: { at: number; timer: NodeJS.Timeout };
  /** Pull requests merging, to ring the gong for. */
  private merges = new MergeWatch();

  constructor(
    readonly def: FloorDef,
    private ctx: FloorContext,
  ) {
    this.id = def.id;
    this.dir = def.dir;
    const dataDir = path.join(def.dir, '.agent-office');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    excludeFromGit(def.dir);
    this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs);
    this.logo = readProjectLogo(def.dir);
    if (this.logo) this.project.logo = `/api/floors/${encodeURIComponent(def.id)}/logo?v=${this.logo.version}`;

    // Before the workers, so it hears about the ones who wake up needing input.
    this.dog = new Dog(def.id, dataDir, {
      workers: () => this.workers?.list() ?? [],
      people: () => ctx.peers(this),
      send: (dog) => ctx.emit(this, { t: 'dog', dog }),
    });

    this.workers = new WorkerManager(
      def.dir,
      dataDir,
      ctx.agentCmd,
      ctx.agentArgs,
      ctx.hook,
      {
        update: (worker) => {
          ctx.emit(this, { t: 'worker.update', worker });
          // Still being built: the first updates come from waking the workers already at their desks.
          this.queue?.onWorker(worker);
          this.plans?.onWorker(worker);
          this.meetings?.onWorker(worker);
          this.dog.onWorker(worker);
          ctx.workerChanged(this, worker);
        },
        remove: (workerId) => {
          this.changes?.forget(workerId);
          this.workspaceChanges?.forget(workerId);
          ctx.emit(this, { t: 'worker.remove', workerId });
          this.queue?.onWorkerGone(workerId);
          this.plans?.onWorkerGone(workerId);
          this.meetings?.onWorkerGone(workerId);
          this.dog.onWorkerGone(workerId);
          ctx.workerChanged(this, workerId);
        },
        data: (workerId, data, viewers) => ctx.termData(workerId, data, viewers),
        sideData: (workerId, data, viewers) => ctx.termData(workerId, data, viewers, true),
        screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
        toast: (text, level) => ctx.toast(this, text, level),
      },
      ctx.ledger,
      ctx.capacity,
    );

    this.github = new GitHub(
      def.dir,
      (state) => {
        ctx.emit(this, { t: 'gh.issues', state });
        this.resumeAfter(state.paused);
      },
      (state) => {
        ctx.emit(this, { t: 'gh.pulls', state });
        this.resumeAfter(state.paused);
        this.queue?.onPulls(state.items);
        // A pause only says the list is as it was: nothing new to act on.
        if (state.loading || state.error || state.paused) return;
        this.workers.onPulls(state.items);
        void this.unshipped?.scan();
        for (const p of this.merges.look(state.items)) {
          ctx.toast(this, `🎉 PR ${ghRef(p)} merged: ${p.title}`);
          this.merged(p.number, undefined, p.repo);
        }
      },
    );
    // The 📒 To Do Next board: before the queue, which moves its items along as their tasks run.
    this.plans = new Plans(dataDir, (state) => {
      ctx.emit(this, { t: 'plans', state });
      ctx.mail?.plansChanged(this, state);
    });
    // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
    this.queue = new TaskQueue(dataDir, this.workers, !!this.project.branch, {
      update: (state) => {
        ctx.emit(this, { t: 'queue', state });
        ctx.mail?.queueChanged(this, state);
      },
      toast: (text, level) => ctx.toast(this, text, level),
      claimIssue: (issue, repo) => this.github.claim(issue, repo),
      refreshGitHub: () => void this.github.refresh(),
      hiringPaused: () => ctx.ledger.hiringPaused,
      room: () => ctx.capacity.room(),
      emptied: () => {
        ctx.toast(this, '📋 The queue is empty: every task is done 🎉');
        ctx.emit(this, { t: 'gong', why: 'queue' });
      },
      startPlan: (plan, worker, task) => void this.plans.start(plan, worker, task),
      endPlan: (plan, outcome) => this.plans.end(plan, outcome),
      finished: () => this.unshipped?.soon(),
    });
    this.unshipped = new UnshippedWatch(def.dir, {
      workers: () => this.workers.list(),
      tasks: () => this.queue.state().tasks,
      board: () => this.github.pulls,
      repoName: (repoDir) => this.github.checkouts.find((c) => path.resolve(c.dir) === path.resolve(repoDir))?.repo,
      update: (state) => ctx.emit(this, { t: 'unshipped', state }),
      branches: (byBranch) => this.queue.onUnshipped(byBranch),
    });

    // Meetings seat their own workers round the meeting room's table and run them round by round.
    this.meetings = new MeetingRoom(
      def.dir,
      dataDir,
      {
        defaultProvider: this.workers.defaultProvider,
        list: () => this.workers.list(),
        seat: (deskId, by, prompt, provider, model, effort, meeting) => this.workers.spawn(deskId, by, prompt, false, 'agent', provider, model, effort, meeting),
        prompt: (id, text, by) => this.workers.prompt(id, text, by),
        write: (id, data, by) => this.workers.write(id, data, by),
        kill: (id) => this.workers.kill(id),
      },
      this.project.branch ? new Worktrees(def.dir) : undefined,
      {
        update: (state) => ctx.emit(this, { t: 'meeting', state }),
        toast: (text, level) => ctx.toast(this, text, level),
        hiringPaused: () => ctx.ledger.hiringPaused,
        postReview: (pr, file) => this.github.review(pr, file),
      },
    );

    // What each worker changed, for the Changes window at its desk (see changes.ts).
    this.changes = new Changes(
      def.dir,
      this.project.branch,
      (workerId) => {
        const w = this.workers.get(workerId);
        if (!w) return undefined;
        return { name: w.name, cwd: w.worktree ? path.join(def.dir, w.worktree.path) : def.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base };
      },
      (branch) => {
        return pullForBranch(this.github.pulls.items, branch)
          ?? this.workers.list().find((w) => w.worktree?.branch === branch)?.pr;
      },
      {
        state: (state, ids) => ctx.changes(state, ids),
        toast: (text, level) => ctx.toast(this, text, level),
        refreshGitHub: () => void this.github.refresh(),
      },
    );

    // On a floor that's a folder of checkouts, the board agents are told which ones.
    this.workers.checkouts = () => this.github.checkouts.map((c) => ({ repo: c.repo!, dir: c.rel! }));
    // The Receptionist is told how her mailbox stands.
    this.workers.stationContext = () => ({ mail: ctx.mail?.brief() });
    this.workspaceChanges = new WorkspaceChanges(def.dir, id => this.workers.get(id), {
      state: (state, ids) => ctx.changes(state, ids),
      toast: (text, level) => ctx.toast(this, text, level),
      refreshGitHub: () => {},
    });
    this.decor = new Decor(dataDir);
    this.jukebox = new Jukebox(dataDir);
    this.whiteboard = new Whiteboard(dataDir);
    // The 📥 in-tray watches its folder for what comes in from outside.
    this.inbox = new Inbox(dataDir, {
      update: (state) => ctx.emit(this, { t: 'inbox', state }),
      door: () => ctx.inboxDoor(),
    });
    this.ready = this.workers.start();
    // Once the workers are back: tasks the last office left running show whether their work was left behind.
    void this.ready.then(() => this.unshipped.scan(true));

    // Pull requests at once, for the queue, the Unshipped list and the gong's first look; issues when someone walks in.
    void this.github.refresh(false, ['pulls']);
    // Boards are kept as fresh as whoever's on the floor needs them (see board-cadence.ts).
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Background refreshes of whichever boards are due; `resuming` also retries those the rate limit held back. */
  private tick(resuming = false) {
    const held = resuming ? (['issues', 'pulls'] as Board[]).filter((b) => this.github[b].paused) : [];
    const due = boardsDue(this.watch(), this.github.asked, Date.now(), held);
    if (due.length) void this.github.refresh(false, due);
  }

  /** Boards the rate limit held back look again a second after it lifts. */
  private resumeAfter(paused?: GhPause) {
    if (!paused || paused.until <= Date.now() || this.resume?.at === paused.until) return;
    if (this.resume) clearTimeout(this.resume.timer);
    const timer = setTimeout(() => {
      this.resume = undefined;
      this.tick(true);
    }, paused.until - Date.now() + 1000);
    timer.unref?.();
    this.resume = { at: paused.until, timer };
  }

  /** Pull request `n` (of `repo`, on a floor of several) merged (`by` someone, from the PR window): the gong rings, once per PR. */
  merged(n: number, by?: string, repo?: string) {
    if (this.merges.ring(n, repo)) this.ctx.emit(this, { t: 'gong', why: 'merged', pr: n, by });
  }

  /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
  arrived() {
    const stale = (['issues', 'pulls'] as Board[]).filter((b) => Date.now() - this.github[b].fetchedAt > TICK_MS);
    if (stale.length) void this.github.refresh(false, stale);
  }

  /** Who the boards are kept fresh for. */
  private watch(): FloorWatch {
    return {
      people: this.ctx.people(this) > 0,
      busy: this.workers.list().some((w) => isBusy(w.status)) || this.queue.state().tasks.some((t) => t.status !== 'done') || this.meetings.state().current?.status === 'running',
      checkouts: Math.max(1, this.github.checkouts.length),
    };
  }

  info(): FloorInfo {
    const ws = this.workers.list();
    return {
      id: this.id,
      name: this.def.name,
      repo: this.def.repo,
      dir: this.dir,
      palette: this.def.palette,
      addedBy: this.def.addedBy,
      addedAt: this.def.addedAt,
      ...(this.def.backOffice ? { backOffice: true } : {}),
      ...summarizeWorkers(ws),
      roster: floorRoster(ws, this.def.repo || this.def.name),
      people: this.ctx.people(this),
    };
  }

  /**
   * With `keep` (a restart), the workers' terminals keep running for the next office to pick up.
   * Resolves once the workers' uncommitted work is saved as WIP commits (bounded, see wip-checkpoint.ts).
   */
  shutdown(keep = false): Promise<void> {
    clearInterval(this.timer);
    if (this.resume) clearTimeout(this.resume.timer);
    this.dog.stop();
    this.github.stop();
    this.queue.shutdown();
    this.unshipped.stop();
    this.meetings.shutdown();
    this.changes.stop();
    this.workspaceChanges.stop();
    this.whiteboard.flush();
    this.inbox.shutdown();
    this.workers.shutdown(keep);
    return this.workers.checkpoint(keep);
  }

  changesFor(workerId: string, repository?: string): Changes | undefined {
    const w = this.workers.get(workerId);
    if (w?.workspace) return repository ? this.workspaceChanges.get(workerId, repository) : undefined;
    return repository === undefined ? this.changes : undefined;
  }
}
