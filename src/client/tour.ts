// T walks the workers waiting on you on this floor: the nearest seat first, then around the floor,
// and the step after the last one is the boss's office (see OFFICE_SPOT), where the circle started.

export interface TourSeat {
  id: string;
  x: number;
  z: number;
}

export type TourStep = { kind: 'seat'; id: string; n: number; of: number } | { kind: 'office'; waiting: boolean };

const TAU = Math.PI * 2;

/** Around the middle of the floor: south (+z) is 0, east (+x) π/2, north (-z) π, west -π/2. */
function angle(p: { x: number; z: number }): number {
  return Math.atan2(p.x, p.z);
}

/** How far clockwise `to` is from `from`, in (0, 2π]. Seen from above, clockwise is north, east, south, west: the angle falls. */
function clockwise(from: number, to: number): number {
  const d = Math.atan2(Math.sin(from - to), Math.cos(from - to));
  return d > 0 ? d : d + TAU;
}

function nearest(seats: readonly TourSeat[], here: { x: number; z: number }): TourSeat {
  return seats.reduce((best, s) => {
    const d = (s.x - here.x) ** 2 + (s.z - here.z) ** 2;
    const bd = (best.x - here.x) ** 2 + (best.z - here.z) ** 2;
    return d < bd || (d === bd && s.id < best.id) ? s : best;
  });
}

/** The next seat clockwise from `from`. Seats at the same angle go by id. */
function nextClockwise(seats: readonly TourSeat[], from: { x: number; z: number }): TourSeat {
  const a0 = angle(from);
  return seats.reduce((best, s) => {
    const d = clockwise(a0, angle(s));
    const bd = clockwise(a0, angle(best));
    return d < bd || (d === bd && s.id < best.id) ? s : best;
  });
}

/**
 * One press of T after another. The first of a circle is the waiting seat nearest where you stand
 * (`at`, the one you're already behind, is skipped). Each press after that is the next seat
 * clockwise around the floor. Once every one has been visited, the next press is the office, and
 * the circle starts over.
 */
export class SeatTour {
  private seen = new Set<string>();
  /** The seat you were just sent to, so the next press continues around from there. */
  private last: { x: number; z: number } | undefined;
  private visits = 0;

  reset(): void {
    this.seen.clear();
    this.last = undefined;
    this.visits = 0;
  }

  /** True after a seat this circle, until you're sent back to the office. */
  get active(): boolean {
    return this.visits > 0;
  }

  next(waiting: readonly TourSeat[], here: { x: number; z: number }, at?: string): TourStep {
    const live = waiting.filter((w) => w.id && Number.isFinite(w.x) && Number.isFinite(w.z));
    const ids = new Set(live.map((w) => w.id));
    for (const id of this.seen) if (!ids.has(id)) this.seen.delete(id);
    const started = this.visits > 0 || this.last !== undefined;
    if (at && ids.has(at)) this.seen.add(at);

    const left = live.filter((w) => !this.seen.has(w.id));
    if (!left.length) {
      const back = live.length > 0 || started;
      this.reset();
      return { kind: 'office', waiting: back };
    }
    const pick = this.last ? nextClockwise(left, this.last) : nearest(left, here);
    this.seen.add(pick.id);
    this.last = { x: pick.x, z: pick.z };
    this.visits += 1;
    return { kind: 'seat', id: pick.id, n: this.visits, of: this.visits + left.length - 1 };
  }
}
