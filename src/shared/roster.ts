import type { FloorInfo, WorkerInfo, WorkerStatus } from './protocol.js';
import { DESK_BY_ID, type StationKind } from './layout.js';

/** One line on the queue agent's clipboard: who, in which repo(s), doing what. */
export interface RosterEntry {
  id: string;
  name: string;
  color: string;
  status: WorkerStatus;
  /** The repositories it works in: the floor's, or each one a multi-repository desk checked out. */
  repos: string[];
  /** Its branch, when it has a single worktree. */
  branch?: string;
  /** A brief summary of what it's on, or '' when it hasn't been asked anything yet. */
  doing: string;
  /** Set for a board agent at its kiosk. */
  station?: StationKind;
}

/** How long a summary on the clipboard gets. */
export const ROSTER_DOING_MAX = 140;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The floor's repository as people know it: owner/name on GitHub, else its folder's name. A
 * multi-repository desk's repos are named after their checkouts under the floor.
 */
export function rosterEntry(w: WorkerInfo, floorRepo: string): RosterEntry {
  const repos = w.workspace?.repositories.length ? w.workspace.repositories.map((r) => r.name || r.repository) : [floorRepo];
  // The task's one-liner is written for exactly this; before it arrives, what it was asked.
  const doing = w.task
    ? `${w.task.name}${w.task.summary ? `: ${w.task.summary}` : ''}`
    : (w.title ?? w.prompt ?? w.activity ?? '');
  const station = DESK_BY_ID.get(w.deskId)?.station;
  return {
    id: w.id,
    name: w.name,
    color: w.color,
    status: w.status,
    repos,
    ...(w.worktree && !w.workspace ? { branch: w.worktree.branch } : {}),
    doing: clip(doing, ROSTER_DOING_MAX),
    ...(station ? { station } : {}),
  };
}

/** Everyone on a floor, oldest hire first. */
export function floorRoster(workers: Iterable<WorkerInfo>, floorRepo: string): RosterEntry[] {
  return [...workers].sort((a, b) => a.createdAt - b.createdAt).map((w) => rosterEntry(w, floorRepo));
}

/** The name the clipboard gives a floor's repository. */
export function floorRepoName(floor: Pick<FloorInfo, 'name' | 'repo'>): string {
  return floor.repo || floor.name;
}

/**
 * Every floor's roster for the clipboard. Your own floor's comes from its live workers, which arrive
 * before the throttled building broadcast (as in attentionFloors).
 */
export function rosterFloors(floors: readonly FloorInfo[], currentFloor: string | null, workers: Iterable<WorkerInfo>): { floor: FloorInfo; roster: RosterEntry[] }[] {
  return floors.map((floor) => ({
    floor,
    roster: floor.id === currentFloor ? floorRoster(workers, floorRepoName(floor)) : (floor.roster ?? []),
  }));
}

/** One repository's workers, as the clipboard's sheet lists them. */
export interface RosterGroup {
  repo: string;
  entries: RosterEntry[];
}

/**
 * Everyone by the repository they work in, in floor order: a multi-repository desk goes under all
 * of its repos together (e.g. "api + web"), so where each one is working is the first thing you read.
 */
export function rosterByRepo(floors: readonly { roster: RosterEntry[] }[]): RosterGroup[] {
  const groups = new Map<string, RosterEntry[]>();
  for (const { roster } of floors)
    for (const e of roster) {
      const repo = e.repos.join(' + ');
      groups.set(repo, [...(groups.get(repo) ?? []), e]);
    }
  return [...groups].map(([repo, entries]) => ({ repo, entries }));
}
