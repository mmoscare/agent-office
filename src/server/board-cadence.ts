import type { Board } from './github.js';

/** How often a floor looks at whether its boards are due another look at GitHub. */
export const TICK_MS = 90_000;
/** A tick that fires a little early still counts. */
const SLACK_MS = 5_000;

/** Who a floor's boards are kept fresh for. */
export interface FloorWatch {
  /** People on the floor, who see both boards. */
  people: boolean;
  /** A worker busy, a task on the queue or a meeting running: the queue, the workers' PR links and the merge gong follow the pull requests. */
  busy: boolean;
  /** Checkouts the boards cover: a floor that's a folder of several costs that many times as much. */
  checkouts: number;
}

/**
 * How stale each board may get before a background refresh (ms); a board that's missing isn't
 * asked for in the background (walking onto the floor asks for it). Each refresh of a checkout
 * costs about 3 points for issues and 5 for pull requests of the 5,000 an hour.
 *
 * - People on the floor: both boards every tick, as before.
 * - Only workers: pull requests every 6 minutes (12 on a folder of checkouts); nobody sees the issues.
 * - Nobody and nothing: pull requests every half hour, so the Unshipped list and PR links don't go stale for a day.
 */
export function boardCadence(on: FloorWatch): Partial<Record<Board, number>> {
  if (on.people) return { issues: TICK_MS, pulls: TICK_MS };
  if (on.busy) return { pulls: (on.checkouts > 1 ? 8 : 4) * TICK_MS };
  return { pulls: 20 * TICK_MS };
}

/**
 * The boards due a background refresh, by when each was last asked for. `resuming` (the rate
 * limit just lifted) also takes any the pause held back.
 */
export function boardsDue(on: FloorWatch, asked: Record<Board, number>, now: number, held: Board[] = []): Board[] {
  const every = boardCadence(on);
  return (['issues', 'pulls'] as Board[]).filter((b) => every[b] !== undefined && (held.includes(b) || now - asked[b] >= every[b]! - SLACK_MS));
}
