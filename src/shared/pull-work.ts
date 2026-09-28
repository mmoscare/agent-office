import type { GhPull, PullWork, WorkerInfo } from './protocol.js';

export const PULL_WORK_LABEL = {
  comments: 'Fix comments & merge',
  conflicts: 'Fix conflicts & merge',
  review: 'Review',
  ask: 'PR task',
} as const;

/** Validate at the wire/disk boundary; never infer an assignment from prompt text. */
export function readPullWork(value: unknown): PullWork | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Partial<PullWork>;
  if (!Number.isSafeInteger(v.number) || v.number! <= 0 || typeof v.url !== 'string' || v.url.length > 2048) return;
  if (typeof v.action !== 'string' || !Object.hasOwn(PULL_WORK_LABEL, v.action)) return;
  try {
    const url = new URL(v.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !new RegExp(`/[^/]+/[^/]+/pull/${v.number}/?$`).test(url.pathname)) return;
    return { number: v.number!, url: `${url.origin}${url.pathname.replace(/\/$/, '')}`, action: v.action! };
  } catch { return; }
}

type Pull = Pick<GhPull, 'number' | 'headRefName'> & Partial<Pick<GhPull, 'url' | 'repo' | 'state'>>;
const sameUrl = (a: string, b: string) => a.replace(/\/$/, '').toLowerCase() === b.replace(/\/$/, '').toLowerCase();

/** Explicit assignments win over the PR's original desk, including a different worktree. */
export function pullWorkers(workers: Iterable<WorkerInfo>, pr: Pull): WorkerInfo[] {
  return [...workers].filter(w => w.kind === 'agent' && w.pullWork && pr.url && sameUrl(w.pullWork.url, pr.url))
    .sort((a, b) => Number(['starting', 'working', 'needs_input'].includes(b.status)) - Number(['starting', 'working', 'needs_input'].includes(a.status)) || b.pullWork!.assignedAt - a.pullWork!.assignedAt);
}

export function workerForPull(workers: Iterable<WorkerInfo>, pr: Pull): WorkerInfo | undefined {
  const all = [...workers];
  const assigned = pullWorkers(all, pr)[0];
  if (assigned) return assigned;
  return all.find(w => {
    if (w.pr && pr.url) return sameUrl(w.pr.url, pr.url);
    // A bare number/branch is ambiguous on a multi-repository floor.
    if (pr.repo || w.workspace) return false;
    return w.pr?.number === pr.number || (!!pr.headRefName && w.worktree?.branch === pr.headRefName);
  });
}

/** Provider turn completion is not proof that the PR was fixed or merged. */
export function pullWorkStatus(w: WorkerInfo): { text: string; tone: string; active: boolean } {
  if (w.status === 'starting') return { text: 'Starting', tone: 'active', active: true };
  if (w.status === 'working') return { text: 'Working', tone: 'active', active: true };
  if (w.status === 'needs_input') return { text: 'Needs input', tone: 'waiting', active: false };
  if (w.status === 'offline' || w.status === 'exited') return { text: w.status === 'offline' ? 'Offline' : 'Stopped', tone: 'stopped', active: false };
  if (w.status === 'done' && (w.waitingSince ?? 0) >= (w.pullWork?.assignedAt ?? 0)) return { text: 'Turn finished', tone: 'finished', active: false };
  return { text: 'Assigned', tone: 'waiting', active: false };
}

/**
 * What the 3D PR board draws from the workers: the desk a PR came from, or who it was handed to and
 * how that's going. Redraw when this changes, not on every worker update.
 */
export function pullBoardKey(workers: Iterable<WorkerInfo>): string {
  return JSON.stringify([...workers].filter(w => w.worktree || w.pr || w.pullWork).map(w => [
    w.kind, w.worktree?.branch, w.pr?.number, w.pr?.url, !!w.workspace, w.name, w.color, w.deskId,
    w.pullWork?.url, w.pullWork?.assignedAt, w.pullWork && pullWorkStatus(w).text,
  ]));
}
