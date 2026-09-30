import type { WorkerStatus } from './protocol.js';

// The guided office update (server/office-update.ts, client ui/office-update.ts): after a pull request
// for Agent Office itself is merged, one step at a time — pull the floor, pull the app folder, get new
// packages, build, restart — each checked before moving on, and said in plain English.

export type UpdateStepId = 'floor' | 'app' | 'packages' | 'build' | 'restart';

export const UPDATE_STEPS: { id: UpdateStepId; title: string }[] = [
  { id: 'floor', title: 'Pull the floor' },
  { id: 'app', title: 'Pull the app folder' },
  { id: 'packages', title: 'New packages' },
  { id: 'build', title: 'Build' },
  { id: 'restart', title: 'Restart' },
];

/** What a step's button did, for a person: what happened, and the technical part for "Show details". */
export interface UpdateOutcome {
  ok: boolean;
  /** Short, plain English: what happened, and what to do next when that's on you. */
  message: string;
  /** More plain lines worth saying, e.g. that the folder has commits GitHub doesn't. */
  notes?: string[];
  /** Git or npm output, file lists: hidden behind "Show details". */
  details?: string;
  at: number;
}

/** A pull request the update brings, from its merge commit on the app folder's GitHub branch. */
export interface UpdatePr {
  number: number;
  title: string;
  /** Its merge commit, to check it's in what's running. */
  sha: string;
}

export interface UpdateWorker {
  id: string;
  name: string;
  /** The floor it sits on. */
  floor: string;
  status: WorkerStatus;
}

/** What was running and who was busy, saved just before the office restarted for an update. */
export interface UpdateRestartRecord {
  at: number;
  by: string;
  /** The app folder's commit the office should come back on. */
  expect: string;
  prs: UpdatePr[];
  /** Workers who were busy (or waiting on you): they come back idle and need a "continue". */
  busy: UpdateWorker[];
  acknowledged?: boolean;
}

export type UpdateStepState = 'done' | 'todo' | 'skipped';

export interface OfficeUpdateState {
  /** The folder the office runs from. */
  appDir: string;
  branch?: string;
  /** Its GitHub copy, e.g. origin/personal. */
  upstream?: string;
  /** The commit that GitHub copy is at: which update this is. */
  target?: string;
  /** owner/name, when it's on GitHub (for links to the pull requests). */
  github?: string;
  /** Whether this person may press the buttons (the office's admins). */
  admin: boolean;
  /** Pull requests this update brings: merged on GitHub, not yet running. */
  prs: UpdatePr[];
  /** New commits on GitHub that came without a pull request. */
  otherCommits: number;
  /** Floors that are checkouts of the office's own repository. */
  floors: { name: string; dir: string; behind: number; dirty: number }[];
  app: { behind: number; ahead: number; dirty: string[]; head?: string };
  packages: {
    /** What's installed doesn't match package-lock.json. */
    needed: boolean;
    /** Something the running office itself uses changed, not just build tools. */
    runtime: boolean;
    changes: string[];
    /** They're installed in the staging copy, ready to switch in at the restart. */
    staged: boolean;
  };
  build: {
    state: 'idle' | 'packages' | 'building' | 'ready' | 'failed';
    /** What it's doing now, while it runs. */
    phase?: string;
    startedAt?: number;
    finishedAt?: number;
    /** The commit built (or being built). */
    commit?: string;
    /** The last lines of npm's output. */
    tail?: string;
  };
  /** What the running office was built from, when that's known. */
  running: { commit?: string; startedAt: number };
  restart: {
    /** The office can restart itself (it runs under a launcher that starts it again). */
    available: boolean;
    /** Why not: a launcher from before this feature, a PowerShell window, anything else. */
    reason?: 'old-launcher' | 'powershell' | 'other';
    /** Waiting for every worker to be idle, since then. */
    waiting?: number;
    /** A restart was asked for and hasn't happened yet. */
    pending?: boolean;
    /** The new packages can only switch in with the launcher, or by hand with the office stopped. */
    needsPackagesByHand?: boolean;
  };
  /** Workers who would be interrupted by a restart now. */
  busy: UpdateWorker[];
  steps: Record<UpdateStepId, UpdateStepState>;
  /** The latest outcome of each step's button, for this update. */
  outcomes: Partial<Record<UpdateStepId, UpdateOutcome>>;
  /** The last restart for an update, and how it went. */
  last?: UpdateRestartRecord & {
    verdict: 'live' | 'pending' | 'old-code' | 'rolled-back';
    /** Plain English for anything but live. */
    message?: string;
    details?: string;
    /** The busy workers as they are now. */
    now: (UpdateWorker & { gone?: boolean })[];
  };
  error?: string;
}

/**
 * New packages when the office restarts by hand (no launcher to switch the staged build in): with the
 * office stopped, install them in the app folder and build there. The build is its own command, not
 * left to npm ci's prepare script, which doesn't run when install scripts are turned off.
 */
export function packagesByHand(appDir: string): string {
  return [`cd "${appDir}"`, 'npm ci', 'npm run build'].join('\n');
}

/** Workers a restart would interrupt: working (or starting), or waiting on an answer from you. */
export function interruptedByRestart(status: WorkerStatus): boolean {
  return status === 'working' || status === 'starting' || status === 'needs_input';
}

/** Workers "Restart as soon as everyone is idle" waits for: those actually doing something. */
export function blocksIdleRestart(status: WorkerStatus): boolean {
  return status === 'working' || status === 'starting';
}
