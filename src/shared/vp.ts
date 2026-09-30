// How the VP stands on a floor (see server/vp.ts), for the floor menu and his kiosk.

export interface VpJobView {
  id: string;
  kind: 'sweep' | 'verify' | 'merge' | 'go-live';
  what: string;
  by: string;
  startedAt: number;
  /** The latest line of its log. */
  last?: string;
}

export interface VpView {
  /** Standing duty: the owner's standing approval for verified merges on this floor. */
  duty?: { on: boolean; by: string; at: number; everyMs: number };
  /** The job he's on right now. */
  job?: VpJobView;
  lastSweep?: { at: number; ms: number; summary: string };
  /** On the office's own floor: merges that only run once the office restarts. */
  waitingRestart?: number;
  /** What holds the building's one verify slot right now (any floor's VP). */
  verifying?: string;
  /** His latest merges, newest first. */
  merges: { pr: number; repo: string; title: string; url: string; at: number }[];
}

export function emptyVpView(): VpView {
  return { merges: [] };
}
